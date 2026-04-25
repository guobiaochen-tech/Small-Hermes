import fs from 'fs';
import path from 'path';
import express from 'express';
import multer from 'multer';
import { config } from './config.js';
import { chatStream, ChatMessage, TOOLS, getSystemPrompt } from './llm.js';
import { startFeishuPolling, setBroadcast, readPdfText, readDocxText, readTextFile } from './feishu.js';
import { webSearch, formatSearchResults } from './search.js';

const app = express();
app.use(express.json({ limit: '20mb' }));

// ─── 文件上传 ───
export const WEB_UPLOAD_DIR = path.resolve(process.cwd(), 'web_uploads');
if (!fs.existsSync(WEB_UPLOAD_DIR)) fs.mkdirSync(WEB_UPLOAD_DIR, { recursive: true });
const upload = multer({ dest: WEB_UPLOAD_DIR, limits: { fileSize: 20 * 1024 * 1024 } });

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

// ─── 文件上传接口 ───
app.post('/api/upload', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: '未选择文件' });
    return;
  }

  const ext = path.extname(file.originalname).toLowerCase();
  const imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

  try {
    // 图片 → 读取为 base64
    if (imageExts.has(ext)) {
      const data = fs.readFileSync(file.path);
      const base64 = data.toString('base64');
      const mime = ext === '.jpg' ? 'jpeg' : ext.slice(1);
      res.json({ type: 'image', data: `data:image/${mime};base64,${base64}`, fileName: file.originalname });
      return;
    }

    // PDF
    if (ext === '.pdf') {
      const text = await readPdfText(file.path);
      if (text) {
        res.json({ type: 'text', data: `📄 上传了 PDF: ${file.originalname}\n\n\`\`\`\n${text}\n\`\`\``, fileName: file.originalname });
      } else {
        res.json({ type: 'text', data: `📄 上传了 PDF: ${file.originalname}（未提取到文字内容）`, fileName: file.originalname });
      }
      return;
    }

    // DOCX
    if (ext === '.docx') {
      const text = await readDocxText(file.path);
      if (text) {
        res.json({ type: 'text', data: `📄 上传了 DOCX: ${file.originalname}\n\n\`\`\`\n${text}\n\`\`\``, fileName: file.originalname });
      } else {
        res.json({ type: 'text', data: `📄 上传了 DOCX: ${file.originalname}（未提取到文字内容）`, fileName: file.originalname });
      }
      return;
    }

    // 文本文件
    const textContent = readTextFile(file.path);
    if (textContent) {
      res.json({ type: 'text', data: `📄 上传了 ${file.originalname}\n\n\`\`\`\n${textContent}\n\`\`\``, fileName: file.originalname });
      return;
    }

    // 其他
    res.json({ type: 'text', data: `📁 上传了文件: ${file.originalname}（小 Hermes 暂不支持读取该格式）`, fileName: file.originalname });
  } catch (err) {
    console.error('[上传] 处理失败:', err);
    res.status(500).json({ error: '处理文件失败' });
  }
});

// ========== Web UI API ==========

// 流式聊天接口（单次流式调用模式 - 和 Hermes Agent 一致）
app.post('/api/chat', async (req, res) => {
  const t0 = Date.now();
  const { messages, model }: { messages: ChatMessage[]; model?: string } = req.body;
  const reqId = Date.now().toString(36);
  console.log(`[API #${reqId}] 收到 /api/chat 请求, messages数: ${messages?.length || 0}, model: ${model}`);

  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: 'messages is required' });
    return;
  }

  // 注入系统提示词
  const systemMsg: ChatMessage = { role: 'system', content: getSystemPrompt() };
  const msgs: ChatMessage[] = [systemMsg, ...messages];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  if ((res as any).socket) (res as any).socket.setNoDelay(true);

  try {
    const hasTools = config.tavily.apiKey ? TOOLS : undefined;

    // 单次流式调用（带工具定义）
    // 模式：流式调用 → 没有 tool_calls → 一次搞定 ✓
    //       流式调用 → 有 tool_calls（要搜索）→ 执行搜索 → 再流式生成回答
    let chunkCount = 0;
    let contentCount = 0;
    let thinkingCount = 0;
    let replyText = '';
    let toolCallsFromStream: any[] = [];

    for await (const chunk of chatStream(msgs, model, hasTools)) {
      chunkCount++;
      if (chunk.startsWith('__THINKING__')) {
        thinkingCount++;
        const thinkingData = chunk.slice(12);
        res.write(`data: ${JSON.stringify({ thinking: thinkingData })}\n\n`);
      } else if (chunk.startsWith('__TOOL_CALL__')) {
        // 模型请求工具调用 - 收集起来流结束后执行
        try {
          toolCallsFromStream = JSON.parse(chunk.slice(12));
          console.log(`[API #${reqId}] 流中检测到工具调用: ${toolCallsFromStream.length} 个`);
        } catch { }
      } else if (chunk.startsWith('__STATS__')) {
        const stats = chunk.slice(9);
        res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
      } else {
        contentCount++;
        replyText += chunk;
        res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
      }
    }

    console.log(`[API #${reqId}] 首次流式结束: content=${contentCount}, thinking=${thinkingCount}, toolCalls=${toolCallsFromStream.length}`);

    if (toolCallsFromStream.length > 0) {
      // 执行工具调用
      const searchMessages: ChatMessage[] = [...msgs];
      for (const tc of toolCallsFromStream) {
        if (tc.function?.name === 'web_search') {
          const args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
          console.log(`[API #${reqId}] 搜索: ${args.query}`);
          res.write(`data: ${JSON.stringify({ content: `🔍 搜索: ${args.query}` })}\n\n`);
          const searchResults = await webSearch(args.query);
          const searchContent = formatSearchResults(args.query, searchResults);
          searchMessages.push({ role: 'assistant', content: '', tool_calls: toolCallsFromStream });
          searchMessages.push({ role: 'tool', content: searchContent, tool_call_id: tc.id });
        }
      }

      // 第二次流式调用（带搜索结果）
      console.log(`[API #${reqId}] 基于搜索结果二次流式生成回答`);
      chunkCount = 0;
      contentCount = 0;
      for await (const chunk of chatStream(searchMessages, model)) {
        chunkCount++;
        if (chunk.startsWith('__THINKING__')) {
          res.write(`data: ${JSON.stringify({ thinking: chunk.slice(12) })}\n\n`);
        } else if (chunk.startsWith('__STATS__')) {
          res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
        } else if (!chunk.startsWith('__TOOL_CALL__')) {
          contentCount++;
          res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
        }
      }
      console.log(`[API #${reqId}] 二次流式结束: ${contentCount} content chunks`);
    }

    console.log(`[API #${reqId}] 完成: ${Date.now()-t0}ms`);
    res.write('data: [DONE]\n\n');
  } catch (err) {
    console.error('[API] 流式聊天失败:', err);
    res.write(`data: ${JSON.stringify({ error: '模型调用失败' })}\n\n`);
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
  console.log('[重启] 触发文件变更，tsx watch 将自动重启...');
  // 触碰当前文件让 tsx watch 检测到变更后自动重启
  const now = new Date();
  fs.utimes(__filename, now, now, () => {});
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
║  Mode:   WebSocket                    ║
╚══════════════════════════════════════╝
  `);

  // 启动飞书轮询
  startFeishuPolling();
});
