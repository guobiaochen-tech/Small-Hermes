import fs from 'fs';
import path from 'path';
import express from 'express';
import { config } from './config.js';
import { chatStream, chatComplete, ChatMessage, TOOLS } from './llm.js';
import { startFeishuPolling, setBroadcast } from './feishu.js';
import { webSearch, formatSearchResults } from './search.js';

const app = express();
app.use(express.json());

// ========== SSE 广播 ==========
const sseClients: express.Response[] = [];
// 飞书消息历史，新 SSE 客户端连接时重放
const feishuHistory: { type: string; content: string }[] = [];
const MAX_HISTORY = 100;

function broadcast(data: any) {
  // 缓存飞书消息，新客户端重放用
  if (data.type === 'feishu_user' || data.type === 'feishu_assistant') {
    feishuHistory.push({ type: data.type, content: data.content });
    if (feishuHistory.length > MAX_HISTORY) feishuHistory.splice(0, feishuHistory.length - MAX_HISTORY);
  }
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { /* ignore */ }
  }
}

setBroadcast(broadcast);

// ========== 静态文件（Web UI）==========
app.use(express.static('client-dist'));

// ========== SSE 实时推送 ==========
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // 重放历史飞书消息
  for (const entry of feishuHistory) {
    res.write(`data: ${JSON.stringify({ type: entry.type, content: entry.content })}\n\n`);
  }

  sseClients.push(res);
  console.log(`[SSE] 客户端已连接，当前 ${sseClients.length} 个（重放 ${feishuHistory.length} 条历史）`);
  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx >= 0) sseClients.splice(idx, 1);
    console.log(`[SSE] 客户端断开，剩余 ${sseClients.length} 个`);
  });
});

// ========== Web UI API ==========

// 流式聊天接口
app.post('/api/chat', async (req, res) => {
  const t0 = Date.now();
  const { messages, model }: { messages: ChatMessage[]; model?: string } = req.body;

  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: 'messages is required' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  if ((res as any).socket) (res as any).socket.setNoDelay(true);

  try {
    const hasTools = config.tavily.apiKey ? TOOLS : undefined;

    // 没有工具配置 → 直接流式
    if (!hasTools) {
      console.log(`[perf] chat: ${Date.now()-t0}ms to start stream`);
      for await (const chunk of chatStream(messages, model)) {
        const isThinking = chunk.startsWith('__THINKING__');
        res.write(`data: ${JSON.stringify(isThinking ? { thinking: chunk.slice(12) } : { content: chunk })}\n\n`);
      }
      console.log(`[perf] chat: ${Date.now()-t0}ms done`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // 有工具配置 → 先非流式检查是否需要搜索
    const firstResult = await chatComplete(messages, model, hasTools);

    if (firstResult.tool_calls?.length) {
      for (const tc of firstResult.tool_calls) {
        if (tc.function.name === 'web_search') {
          const args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
          console.log(`[搜索] ${args.query}`);
          res.write(`data: ${JSON.stringify({ content: `\u{1F50D} \u641C\u7D22: ${args.query}` })}\n\n`);
          const searchResults = await webSearch(args.query);
          const searchContent = formatSearchResults(args.query, searchResults);
          messages.push({ role: 'assistant', content: '', tool_calls: firstResult.tool_calls });
          messages.push({ role: 'tool', content: searchContent, tool_call_id: tc.id });
        }
      }
      for await (const chunk of chatStream(messages, model)) {
        const isThinking = chunk.startsWith('__THINKING__');
        res.write(`data: ${JSON.stringify(isThinking ? { thinking: chunk.slice(12) } : { content: chunk })}\n\n`);
      }
    } else {
      // 不需要搜索 → 直接用 firstResult 的内容，不再调第二次模型
      console.log(`[perf] chat: ${Date.now()-t0}ms done (single call, no search)`);
      const reply = firstResult.content || '';
      const thinking = firstResult.thinking;
      if (thinking) {
        res.write(`data: ${JSON.stringify({ thinking })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ content: reply })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.write('data: [DONE]\n\n');
  } catch (err) {
    console.error('[API] 流式聊天失败:', err);
    res.write(`data: ${JSON.stringify({ error: '\u6A21\u578B\u8C03\u7528\u5931\u8D25' })}\n\n`);
  }

  res.end();
});

// 健康检查
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', model: config.ollama.model });
});

// 重启服务
app.post('/api/restart', (_req, res) => {
  res.json({ ok: true });
  console.log('[重启] 收到重启请求，1秒后退出...');
  setTimeout(() => process.exit(0), 1000);
});

// 获取本地模型列表
app.get('/api/models', async (_req, res) => {
  try {
    const r = await fetch(`${config.ollama.baseUrl}/api/tags`);
    if (!r.ok) throw new Error(`Ollama ${r.status}`);
    const data = await r.json();
    const models = (data.models || []).map((m: any) => ({
      name: m.name,
      size: m.size,
      modified: m.modified_at,
    }));
    res.json({ models });
  } catch (err) {
    console.error('[API] 获取模型列表失败:', err);
    res.json({ models: [], error: '无法连接 Ollama' });
  }
});

// 读取飞书配置
app.get('/api/config/feishu', (_req, res) => {
  res.json({ appId: config.feishu.appId, hasSecret: !!config.feishu.appSecret });
});

// 读取 Tavily 配置
app.get('/api/config/tavily', (_req, res) => {
  res.json({ hasKey: !!config.tavily.apiKey });
});

// ─── 辅助：更新 .env 文件中的键值 ──────────────────────────────────
function updateEnvFile(key: string, value: string) {
  const envPath = path.resolve(process.cwd(), '.env');
  let envContent = fs.readFileSync(envPath, 'utf-8');
  const regex = new RegExp(`^${key}=.*`, 'm');
  if (regex.test(envContent)) {
    envContent = envContent.replace(regex, `${key}=${value}`);
  } else {
    envContent += `\n${key}=${value}`;
  }
  fs.writeFileSync(envPath, envContent);
  console.log(`[配置] ${key} 已更新`);
}

// 保存 Tavily 配置
app.post('/api/config/tavily', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) {
    res.status(400).json({ error: 'apiKey 必填' });
    return;
  }
  config.tavily.apiKey = apiKey;
  try {
    updateEnvFile('TAVILY_API_KEY', apiKey);
    res.json({ ok: true, message: '已保存，重启服务后生效' });
  } catch (err) {
    console.error('[配置] 写入 .env 失败:', err);
    res.status(500).json({ error: '写入失败' });
  }
});

// 保存飞书配置
app.post('/api/config/feishu', async (req, res) => {
  const { appId, appSecret } = req.body;
  if (!appId || !appSecret) {
    res.status(400).json({ error: 'appId 和 appSecret 必填' });
    return;
  }
  config.feishu.appId = appId;
  config.feishu.appSecret = appSecret;
  try {
    updateEnvFile('FEISHU_APP_ID', appId);
    updateEnvFile('FEISHU_APP_SECRET', appSecret);
    res.json({ ok: true, message: '已保存，重启服务后生效' });
  } catch (err) {
    console.error('[配置] 写入 .env 失败:', err);
    res.status(500).json({ error: '写入失败' });
  }
});

// ========== 启动 ==========

app.listen(config.port, () => {
  console.log(`
╔══════════════════════════════════════╗
║  🏛️  Small Hermes                    ║
║  Running on http://localhost:${config.port}   ║
║  Model: ${config.ollama.model.padEnd(26)}║
║  Feishu: ${config.feishu.appId ? '✅ Configured' : '❌ Not configured'.padEnd(25)}║
║  Mode:   Polling (2s)                ║
╚══════════════════════════════════════╝
  `);

  // 启动飞书轮询
  startFeishuPolling();
});
