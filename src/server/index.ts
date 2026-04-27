import fs from 'fs';
import path from 'path';
import express from 'express';
import multer from 'multer';
import { config } from './config.js';
import { chatStream, ChatMessage, TOOLS, getSystemPrompt } from './llm.js';
import { executeToolCalls, setCurrentXlsxPath, getCurrentXlsxPath, getCurrentXlsxSummary } from './tools.js';
import { startFeishuPolling, setBroadcast, readPdfText, readDocxText, readTextFile, sendToFeishu } from './feishu.js';
import { readMemory, addMemory, replaceMemory, removeMemory } from './memory.js';
import { saveSession, listSessions, getSession, deleteSession, searchSessions, getLastSession, type SessionMessage, saveUnifiedSession, TOKEN_COMPRESS_THRESHOLD, estimateTokens, getCompressCount, incrementCompressCount, getChatSession, setChatSession, clearChatSession } from './sessions.js';
import { listSkills, getSkill, createSkill, updateSkill, deleteSkill } from './skills.js';
import { listJobs, getJob, createJob, updateJob, deleteJob, setCronHandler, startScheduler } from './cron.js';
import { shouldCompress, compressMessages } from './compress.js';
import { resolveApproval, createApproval } from './approval.js';
import { startWechat, stopWechat, setWechatMessageHandler, setQrcodeHandler, getWechatStatus, setWechatStatusHandler, resetWechat, sendToWechat } from './wechat.js';
import { chatComplete } from './llm.js';

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

  // 修复 multer 对 UTF-8 中文文件名的编码问题
  const originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
  const ext = path.extname(originalname).toLowerCase();
  const imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

  try {
    // 图片 → 读取为 base64
    if (imageExts.has(ext)) {
      const data = fs.readFileSync(file.path);
      const base64 = data.toString('base64');
      const mime = ext === '.jpg' ? 'jpeg' : ext.slice(1);
      res.json({ type: 'image', data: `data:image/${mime};base64,${base64}`, fileName: originalname });
      return;
    }

    // PDF
    if (ext === '.pdf') {
      const text = await readPdfText(file.path);
      if (text) {
        res.json({ type: 'text', data: `📄 上传了 PDF: ${originalname}\n\n\`\`\`\n${text}\n\`\`\``, fileName: originalname });
      } else {
        res.json({ type: 'text', data: `📄 上传了 PDF: ${originalname}（未提取到文字内容）`, fileName: originalname });
      }
      return;
    }

    // DOCX
    if (ext === '.docx') {
      const text = await readDocxText(file.path);
      if (text) {
        res.json({ type: 'text', data: `📄 上传了 DOCX: ${originalname}\n\n\`\`\`\n${text}\n\`\`\``, fileName: originalname });
      } else {
        res.json({ type: 'text', data: `📄 上传了 DOCX: ${originalname}（未提取到文字内容）`, fileName: originalname });
      }
      return;
    }

    // 文本文件
    const textContent = readTextFile(file.path);
    if (textContent) {
      res.json({ type: 'text', data: `📄 上传了 ${originalname}\n\n\`\`\`\n${textContent}\n\`\`\``, fileName: originalname });
      return;
    }

    // 其他
    res.json({ type: 'text', data: `📁 上传了文件: ${originalname}（小 Hermes 暂不支持读取该格式）`, fileName: originalname });
  } catch (err) {
    console.error('[上传] 处理失败:', err);
    res.status(500).json({ error: '处理文件失败' });
  }
});

// ========== Web UI API ==========

function genSessionId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 流式聊天接口（多轮 tool call 模式）
app.post('/api/chat', async (req, res) => {
  const t0 = Date.now();
  const { messages, model, session_id, title }: { messages: ChatMessage[]; model?: string; session_id?: string; title?: string } = req.body;
  const reqId = Date.now().toString(36);
  console.log(`[API #${reqId}] 收到 /api/chat 请求, messages数: ${messages?.length || 0}, model: ${model}`);

  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: 'messages is required' });
    return;
  }

  // ─── /new /reset 检测：重置会话 ─────────────────────────
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role === 'user' && /^\/(new|reset)\s*$/i.test(lastMsg.content?.trim() || '')) {
    const newId = genSessionId();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.write(`data: ${JSON.stringify({ reset: true, session_id: newId, content: 'Small Hermes:新会话开始!' })}\n\n`);
    res.end();
    return;
  }

  // ─── 取名检测：后端正则检测，不依赖模型 function calling ────
  let nameChangedTo: string | null = null;
  if (lastMsg?.role === 'user' && lastMsg?.content) {
    const text = lastMsg.content.trim();
    const nameRegex = /(?:给你(?:取|换|改)(?:个?名字|个?名)|你叫|叫你|名字叫|名字是|你(?:以后|就)?叫|改名为|给你改名叫|取名为|取名叫|改名叫|给你起(?:名|个名))[：:]?\s*([^\s，。！？,.!?吧了哈哦嗯啊的]{2,8})/;
    const match = text.match(nameRegex);
    if (match) {
      const newName = match[1].trim();
      if (newName && !/什么|啥|谁|哪里|怎么|干嘛|哪个/.test(newName)) {
        const { getAssistantName, setAssistantName } = await import('./memory.js');
        const oldName = getAssistantName();
        if (oldName !== newName) {
          setAssistantName(newName);
          nameChangedTo = newName;
          console.log(`[API #${reqId}] 🏷️ 改名: "${oldName}" → "${newName}"`);
          messages.push({ role: 'system', content: `系统通知：用户已把你的名字改为「${newName}」，你的新名字是 ${newName}。` });
        }
      }
    }
  }

  // 注入系统提示词
  const systemMsg: ChatMessage = { role: 'system', content: getSystemPrompt() };
  let msgs: ChatMessage[] = [systemMsg, ...messages];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  if ((res as any).socket) (res as any).socket.setNoDelay(true);

  // 上下文压缩：token 超过 60% 阈值时自动压缩旧消息
  if (shouldCompress(msgs)) {
    console.log(`[API #${reqId}] 触发上下文压缩 (${estimateTokens(msgs.filter(m=>m.role==='user'||m.role==='assistant') as any)} tokens)`);
    
    // 获取当前会话的压缩计数
    const effectiveSid = session_id || genSessionId();
    const prevCount = getCompressCount(effectiveSid);
    const newCount = prevCount + 1;
    incrementCompressCount(effectiveSid);
    
    const notifyMsg = newCount >= 5
      ? `🧹 上下文已压缩（第 ${newCount} 轮），建议输入 /new 重启会话`
      : `🧹 上下文已压缩（第 ${newCount} 轮）`;
    
    res.write(`data: ${JSON.stringify({ thinking: notifyMsg })}\n\n`);
    msgs = await compressMessages(msgs);
    console.log(`[API #${reqId}] 压缩完成: ${msgs.length} 条消息`);
  }

  // ─── 自动检测用户消息中的 URL ──────────────────────────────────
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (lastUserMsg?.content) {
    const urlRegex = /https?:\/\/[^\s<>"']+/g;
    const urls = lastUserMsg.content.match(urlRegex);
    if (urls && urls.length > 0) {
      for (const url of urls) {
        console.log(`[API #${reqId}] 检测到 URL: ${url}`);
        res.write(`data: ${JSON.stringify({ thinking: `🌐 正在读取链接内容…` })}\n\n`);
        try {
          const fetchRes = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            signal: AbortSignal.timeout(15000),
          });
          if (fetchRes.ok) {
            const html = await fetchRes.text();
            let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
            text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
            text = text.replace(/<[^>]+>/g, ' ');
            text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
            text = text.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
            text = text.replace(/\s+/g, ' ').trim();
            if (text.length > 10000) text = text.slice(0, 10000) + '\n\n…（内容较长，已截断）';
            if (text) {
              msgs.push({
                role: 'system',
                content: `用户消息中包含链接 ${url}，以下是该网页的文本内容（共 ${text.length} 字）：\n${text}`,
              });
              console.log(`[API #${reqId}] URL 内容已注入: ${text.length} 字`);
            }
          } else {
            console.log(`[API #${reqId}] URL 读取失败: ${fetchRes.status}`);
            msgs.push({
              role: 'system',
              content: `用户消息中包含链接 ${url}，但读取失败（HTTP ${fetchRes.status}）。`,
            });
          }
        } catch (err: any) {
          console.log(`[API #${reqId}] URL 读取异常: ${err.message}`);
          msgs.push({
            role: 'system',
            content: `用户消息中包含链接 ${url}，但读取失败（${err.message}）。`,
          });
        }
      }
    }
  }
  let urlContentInjected = false;
  // Check any URL was actually injected
  if (msgs.some(m => m.role === 'system' && m.content.startsWith('用户消息中包含链接'))) {
    urlContentInjected = true;
  }

  try {
    const hasTools = TOOLS.length > 0 ? TOOLS : undefined;

    // 多轮 tool call 循环（最多 5 轮）
    let totalContent = '';
    let toolIterations = 0;
    let finalThinking = '';  // 最后一次迭代的思维链（用于日志/会话保存）
    let toolCallsFromStream: any[] = [];
    const MAX_TOOL_ITERATIONS = 2;

    while (toolIterations < MAX_TOOL_ITERATIONS) {
      toolIterations++;
      let replyText = '';
      let thinkingText = '';  // 本轮迭代的思维链
      let chunkCount = 0;
      let contentCount = 0;

      console.log(`[API #${reqId}] 第 ${toolIterations} 次流式调用`);

      for await (const chunk of chatStream(msgs, model, hasTools)) {
        chunkCount++;
        if (chunk.startsWith('__THINKING_FULL__')) {
          // chatStream 流结束时发出的完整思维链（用于注入消息历史）
          try { thinkingText = JSON.parse(chunk.slice(17)); } catch {}
        } else if (chunk.startsWith('__THINKING__')) {
          thinkingText += chunk.slice(12);
          res.write(`data: ${JSON.stringify({ thinking: chunk.slice(12) })}\n\n`);
        } else if (chunk.startsWith('__TOOL_CALL__')) {
          try {
            toolCallsFromStream = JSON.parse(chunk.slice(13));
            console.log(`[API #${reqId}] 流中检测到工具调用: ${toolCallsFromStream.length} 个`);
          } catch { }
        } else if (chunk.startsWith('__STATS__')) {
          res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
        } else {
          contentCount++;
          replyText += chunk;
          totalContent += chunk;
          res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
        }
      }

      console.log(`[API #${reqId}] 第 ${toolIterations} 次结束: content=${contentCount}, toolCalls=${toolCallsFromStream.length}`);

      // 保存本轮思维链（用于 DONE 信号和会话保存）
      finalThinking = thinkingText;

      if (toolCallsFromStream.length > 0) {
        // 发送结构化工具调用事件
        const toolInfo = toolCallsFromStream.map((tc: any) => {
          let args: any = {};
          try {
            args = typeof tc.function?.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : (tc.function?.arguments || {});
          } catch {}
          const info: any = { name: tc.function?.name || '', args };
          if (tc.function?.name === 'web_search') info.needsApproval = true;
          return info;
        });
        res.write(`data: ${JSON.stringify({ type: 'tool_calls', calls: toolInfo })}\n\n`);

        // 执行工具调用
        const { changed } = await executeToolCalls(toolCallsFromStream, msgs, (data) => {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        });
        // 把思维链注入到刚才推入的 assistant 消息中（多轮 tool call 用）
        if (thinkingText) {
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'assistant' && msgs[i].tool_calls && !msgs[i].thinking) {
              msgs[i] = { ...msgs[i], thinking: thinkingText };
            } else if (msgs[i].role === 'system') {
              break; // 碰到 system 消息说明已经过了新推入的消息
            }
          }
        }
        if (!changed) break; // 没有有效的工具调用就退出循环
        // 如果本轮既有 content 又有 tool call，说明模型已给出回答，工具执行完就退出
        if (contentCount > 0) break;
      } else {
        // 没有 tool call，完全没 content → 服务端根据上下文兜底
        if (contentCount === 0 && toolIterations === 1) {
          let fallback = '';
          if (nameChangedTo) {
            fallback = `好的，以后叫我${nameChangedTo}吧 😊`;
          } else if (urlContentInjected) {
            fallback = '网页内容已经读取，有什么想了解的吗？';
          } else {
            fallback = '你好，有什么可以帮你的吗？';
          }
          totalContent = fallback;
          res.write(`data: ${JSON.stringify({ content: fallback })}\n\n`);
        }
        break;
      }
    }

    console.log(`[API #${reqId}] 完成: ${Date.now()-t0}ms, totalContent=${totalContent.length}`);
    // 把 thinking 随 DONE 信号发给前端，方便前端存回消息历史
    if (finalThinking) {
      res.write(`data: ${JSON.stringify({ done: true, thinking: finalThinking })}\n\n`);
    } else {
      res.write('data: [DONE]\n\n');
    }

    // 记录最近一次聊天结果到文件（供调试用）
    try {
      fs.writeFileSync(path.resolve(process.cwd(), '.last-chat.json'), JSON.stringify({
        time: new Date().toISOString(),
        reqId,
        userMsg: messages[messages.length - 1]?.content?.slice(0, 200) || '',
        thinking: finalThinking.slice(0, 1000),
        content: totalContent.slice(0, 500),
        toolCalls: toolCallsFromStream?.length || 0,
      }), 'utf-8');
    } catch {}

    // 自动保存到统一会话（三通道共享）+ 独立会话文件
    if (messages?.length && totalContent) {
      try {
        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
        const userText = lastUserMsg?.content || '';
        const modelName = model || config.ollama.model;
        
        // 统一会话（跨通道上下文）
        saveUnifiedSession('web', userText, totalContent, modelName, finalThinking);
        
        // 独立会话文件（session_search 用）
        const sessMessages: SessionMessage[] = [];
        for (const m of messages) {
          if (m.role === 'system' && m.content === getSystemPrompt()) continue;
          sessMessages.push({ role: m.role, content: m.content?.slice(0, 10000) || '' });
        }
        sessMessages.push({ role: 'assistant', content: totalContent.slice(0, 10000) });
        saveSession(session_id, title, sessMessages, modelName);
      } catch {}
    }
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

// ─── 记忆读写接口 ──────────────────────────────────────────────

/** 获取记忆 */
app.get('/api/memory', (req, res) => {
  const target = (req.query.target as string) === 'user' ? 'user' : 'memory';
  const data = readMemory(target);
  res.json({ target, ...data });
});

/** 添加记忆 */
app.post('/api/memory', (req, res) => {
  const { target: rawTarget, content, action, old_text, new_content } = req.body;
  const target = rawTarget === 'user' ? 'user' : 'memory';

  if (action === 'add' || (!action && content)) {
    const result = addMemory(target, content || '');
    if (result.success) {
      res.json({ success: true, target, entries: result.entries, usage: result.usage });
    } else {
      res.status(400).json({ success: false, error: result.error, usage: result.usage });
    }
  } else if (action === 'remove') {
    const result = removeMemory(target, old_text || '');
    if (result.success) {
      res.json({ success: true, target, entries: result.entries, usage: result.usage });
    } else {
      res.status(400).json({ success: false, error: result.error, usage: result.usage });
    }
  } else if (action === 'replace' || old_text) {
    const result = replaceMemory(target, old_text || '', new_content || '');
    if (result.success) {
      res.json({ success: true, target, entries: result.entries, usage: result.usage });
    } else {
      res.status(400).json({ success: false, error: result.error, usage: result.usage });
    }
  } else {
    res.status(400).json({ error: '请指定 action (add/replace/remove) 和 content' });
  }
});

// ─── 会话管理接口 ──────────────────────────────────────────────

/** 获取会话列表 */
app.get('/api/sessions', (_req, res) => {
  const list = listSessions();
  res.json({ sessions: list });
});

/** 搜索会话（必须在 :id 前，否则被 :id 匹配） */
app.get('/api/sessions/search', (req, res) => {
  const q = (req.query.q as string) || '';
  if (!q) { res.json({ results: [] }); return; }
  const results = searchSessions(q);
  res.json({ query: q, results });
});

/** 获取最近会话 */
app.get('/api/sessions/last/resume', (_req, res) => {
  const last = getLastSession();
  if (!last) { res.json({ session: null }); return; }
  res.json({ session: last });
});

/** 获取指定会话详情 */
app.get('/api/sessions/:id', (req, res) => {
  const data = getSession(req.params.id);
  if (!data) { res.status(404).json({ error: '会话不存在' }); return; }
  res.json(data);
});

/** 删除会话 */
app.delete('/api/sessions/:id', (req, res) => {
  const ok = deleteSession(req.params.id);
  res.json({ success: ok });
});

// ─── 技能管理接口 ──────────────────────────────────────────────

/** 获取技能列表 */
app.get('/api/skills', (_req, res) => {
  const list = listSkills();
  res.json({ skills: list });
});

/** 获取技能详情 */
app.get('/api/skills/:name', (req, res) => {
  const skill = getSkill(req.params.name);
  if (!skill) { res.status(404).json({ error: '技能不存在' }); return; }
  res.json(skill);
});

/** 创建技能 */
app.post('/api/skills', (req, res) => {
  const { name, description, category, body } = req.body;
  if (!name || !description || !body) {
    res.status(400).json({ error: 'name, description, body 必填' });
    return;
  }
  const skill = createSkill(name, description, category || '', body);
  res.json({ skill });
});

/** 更新技能 */
app.put('/api/skills/:name', (req, res) => {
  const { description, category, body } = req.body;
  const skill = updateSkill(req.params.name, { description, category, body });
  if (!skill) { res.status(404).json({ error: '技能不存在' }); return; }
  res.json({ skill });
});

/** 删除技能 */
app.delete('/api/skills/:name', (req, res) => {
  const ok = deleteSkill(req.params.name);
  res.json({ success: ok });
});

// ─── 定时任务接口 ──────────────────────────────────────────────

/** 获取任务列表 */
app.get('/api/cron', (_req, res) => {
  const list = listJobs();
  res.json({ jobs: list });
});

/** 获取单个任务 */
app.get('/api/cron/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) { res.status(404).json({ error: '任务不存在' }); return; }
  res.json(job);
});

/** 创建任务 */
app.post('/api/cron', (req, res) => {
  const { name, schedule, prompt } = req.body;
  if (!name || !schedule || !prompt) {
    res.status(400).json({ error: 'name, schedule, prompt 必填' });
    return;
  }
  const job = createJob(name, schedule, prompt);
  res.json({ job });
});

/** 更新任务 */
app.put('/api/cron/:id', (req, res) => {
  const { name, schedule, prompt, enabled } = req.body;
  const job = updateJob(req.params.id, { name, schedule, prompt, enabled });
  if (!job) { res.status(404).json({ error: '任务不存在' }); return; }
  res.json({ job });
});

/** 删除任务 */
app.delete('/api/cron/:id', (req, res) => {
  const ok = deleteJob(req.params.id);
  res.json({ success: ok });
});

// ─── 权限确认接口 ──────────────────────────────────────────────

/** 用户确认/拒绝操作 */
app.post('/api/approve', (req, res) => {
  const { id, approved } = req.body;
  if (!id) {
    res.status(400).json({ error: 'id 必填' });
    return;
  }
  const ok = resolveApproval(id, approved === true);
  if (!ok) {
    res.json({ success: false, error: '确认请求已过期或不存在' });
    return;
  }
  res.json({ success: true, approved: approved === true });
});

/** 飞书卡片 URL 按钮确认（GET，不依赖飞书事件配置） */
app.get('/api/feishu-approve', (req, res) => {
  const { id, ok } = req.query;
  if (!id) {
    res.status(400).send('缺少 id');
    return;
  }
  const approved = ok === '1';
  const ok2 = resolveApproval(id as string, approved);
  const emoji = approved ? '✅' : '❌';
  const text = approved ? '已允许搜索' : '已取消搜索';
  res.send(`<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="font-family:-apple-system,sans-serif;text-align:center;padding-top:40vh;font-size:28px;background:#1c1c1e;color:#fff">${ok2 ? `${emoji} ${text}` : '⏰ 请求已过期'}<br><small style="font-size:14px;color:#888;margin-top:20px;display:block">可关闭此页面</small></body></html>`);
  console.log(`[飞书] URL确认: id=${id} approved=${approved} ok=${ok2}`);
});

// ─── 微信通道接口 ──────────────────────────────────────────────

/** 设置微信消息/状态/扫码处理器（多处复用） */
function setupWechatHandlers() {
  setQrcodeHandler((qrUrl) => {
    broadcast({ type: 'wechat_qrcode', url: qrUrl });
  });
  setWechatStatusHandler((connected, accountId) => {
    broadcast({ type: 'wechat_status', connected, accountId: accountId || null });
  });

  // ─── 微信对话历史（保持上下文连续性） ─────────────────
  const wechatHistory: ChatMessage[] = [];
  const MAX_HISTORY = 10; // 5轮：5条user + 5条assistant

  // 等待确认的联网搜索（微信端用文本回复 是/否 确认）
  let wechatApproval: {
    approvalId: string;
    msgs: ChatMessage[];
    toolCalls: any[];
    totalContent: string;
    userMsg: ChatMessage;
    reply: (text: string, filePath?: string | null) => void;
    text: string;
    images: string[] | undefined;
  } | null = null;

  setWechatMessageHandler(async (text, images, reply) => {
    try {
      // ─── /new /reset 重置会话 ───────────────────────────
      const trimmedText = (text || '').trim();
      if (/^\/(new|reset)\s*$/i.test(trimmedText)) {
        clearChatSession('wechat:default');
        wechatHistory.length = 0; // 清空当前历史
        reply('Small Hermes:新会话开始!');
        return;
      }

      // ─── 检查是否有待确认的搜索 ────────────────────────
      if (wechatApproval) {
        const trimmed = text.trim();
        const opt1 = /^1|不允许|否|no|不|取消|n|算了$/i.test(trimmed);
        const opt2 = /^2|允许|是|yes|ok|好|可以|确认|y|同意$/i.test(trimmed);
        const opt3 = /^3|一直允许|始终|永远|总是$/i.test(trimmed);
        if (opt1 || opt2 || opt3) {
          if (opt1) {
            resolveApproval(wechatApproval.approvalId, false);
            reply('已取消搜索。');
          } else {
            // opt2 允许 / opt3 一直允许
            if (opt3) {
              // 保存到 MEMORY.md，以后不再询问
              try { addMemory('memory', '用户允许联网搜索无需确认'); } catch {}
              reply('✅ 已设为一直允许，以后联网搜索不再询问。');
            }
            resolveApproval(wechatApproval.approvalId, true);
            const { msgs, toolCalls, totalContent: prevContent, userMsg, reply: savedReply, text: savedText } = wechatApproval;
            wechatApproval = null;

            let totalContent = prevContent;
            let modifiedFilePath: string | null = null;

            // 执行待确认的工具
            const { changed } = await executeToolCalls(toolCalls, msgs);
            if (changed) {
              // 继续 LLM 循环（最多再 2 轮）
              for (let iter = 0; iter < 2; iter++) {
                const result = await chatComplete(msgs, undefined, TOOLS.length > 0 ? TOOLS : undefined);
                if (result.content) totalContent += result.content;

                if (result.tool_calls?.length) {
                  const aMsg: ChatMessage = { role: 'assistant', content: result.content || '', tool_calls: result.tool_calls };
                  if (result.thinking) aMsg.thinking = result.thinking;
                  msgs.push(aMsg);
                  const r = await executeToolCalls(result.tool_calls, msgs);
                  if (!r.changed) break;
                  if (result.content) break; // 已回答，退出循环
                } else {
                  msgs.push({ role: 'assistant', content: totalContent });
                  break;
                }
              }
            }

            // 存入对话历史
            const oldLen = wechatHistory.length;
            wechatHistory.push(userMsg);
            for (let i = 1 + oldLen; i < msgs.length; i++) wechatHistory.push(msgs[i]);
            while (wechatHistory.length > MAX_HISTORY) wechatHistory.shift();

            const replyText = totalContent || '抱歉，我没能理解。';
            broadcast({ type: 'wechat_msg', user: savedText || '(附件)', assistant: replyText });
            try { 
              saveUnifiedSession('wechat', savedText || '', replyText, config.ollama.model); 
              const chatKey = 'wechat:default';
              const sid = getChatSession(chatKey) || genSessionId();
              setChatSession(chatKey, sid);
              saveSession(sid, undefined, [
                { role: 'user' as const, content: (savedText || '').slice(0, 10000) },
                { role: 'assistant' as const, content: replyText.slice(0, 10000) },
              ], config.ollama.model);
            } catch {}
            savedReply(replyText, modifiedFilePath);
          }
          wechatApproval = null;
          return;
        }
      }

      // ─── 正常消息处理 ──────────────────────────────────
      let userContent = text || '请分析这张图片';

      // ─── 跨轮 Excel 上下文注入 ──────────────────────────
      // 如果上一轮上传过 Excel 但没有新文件，注入表头摘要
      // 解决小模型跨轮忘记文件内容的问题
      const existingXlsx = getCurrentXlsxPath();
      if (existingXlsx && text && !text.startsWith('用户发送了文件')) {
        const summary = getCurrentXlsxSummary();
        if (summary) {
          userContent = summary + '\n\n用户消息：' + userContent;
          console.log('[微信] 注入 Excel 上下文:', summary.slice(0, 100));
        }
      }
      const systemMsg: ChatMessage = { role: 'system', content: getSystemPrompt() };
      const userMsg: ChatMessage = { role: 'user', content: userContent };
      if (images?.length) userMsg.images = images;

      // 构建消息：system + 历史 + 当前用户消息
      const hasTools = TOOLS.length > 0 ? TOOLS : undefined;
      let msgs_base: ChatMessage[] = [systemMsg, ...wechatHistory, userMsg];

      // ─── 上下文压缩检测 ─────────────────────────────────
      if (shouldCompress(msgs_base)) {
        const chatKey = 'wechat:default';
        const sid = getChatSession(chatKey) || genSessionId();
        setChatSession(chatKey, sid);
        const prevCount = getCompressCount(sid);
        const newCount = prevCount + 1;
        incrementCompressCount(sid);
        const notifyMsg = newCount >= 5
          ? `🧹 上下文已压缩（第 ${newCount} 轮），建议输入 /new 重启会话`
          : `🧹 上下文已压缩（第 ${newCount} 轮）`;
        reply(notifyMsg);
        msgs_base = await compressMessages(msgs_base);
      }

      const msgs = msgs_base;
      let totalContent = '';
      let modifiedFilePath: string | null = null;
      const MAX_ITER = 3;

      for (let iter = 0; iter < MAX_ITER; iter++) {
        const result = await chatComplete(msgs, undefined, hasTools);
        if (result.content) totalContent += result.content;

        if (result.tool_calls?.length) {
          // 检查是否需要联网确认
          const hasWebSearch = result.tool_calls.some((tc: any) => tc.function?.name === 'web_search');
          if (hasWebSearch) {
            // 如果用户已设"一直允许"，直接执行
            const { entries } = readMemory('memory');
            const alwaysAllow = entries.some(e => e.includes('搜索无需确认') || e.includes('一直允许搜索') || e.includes('联网搜索无需确认'));
            if (alwaysAllow) {
              // 直接执行，不询问
              const assistantMsg: ChatMessage = { role: 'assistant', content: result.content || '', tool_calls: result.tool_calls };
              if (result.thinking) assistantMsg.thinking = result.thinking;
              msgs.push(assistantMsg);
              const { changed } = await executeToolCalls(result.tool_calls, msgs);
              if (!changed) break;
              continue; // 继续 LLM 循环
            }

            const assistantMsg: ChatMessage = { role: 'assistant', content: result.content || '', tool_calls: result.tool_calls };
            if (result.thinking) assistantMsg.thinking = result.thinking;
            msgs.push(assistantMsg);

            const { id } = createApproval(result.tool_calls[0]);
            const query = (() => {
              try { const a = JSON.parse(result.tool_calls[0].function?.arguments || '{}'); return a.query || ''; } catch { return ''; }
            })();
            wechatApproval = { approvalId: id, msgs, toolCalls: result.tool_calls, totalContent, userMsg, reply, text, images };
            reply(`🔍 需要搜索「${query}」，请选择：\n1 不允许\n2 允许\n3 一直允许（以后不再询问）\n（2分钟超时自动取消）`);
            return; // 等用户回复
          }

          const assistantMsg: ChatMessage = { role: 'assistant', content: result.content || '', tool_calls: result.tool_calls };
          if (result.thinking) assistantMsg.thinking = result.thinking;
          msgs.push(assistantMsg);

          const { changed } = await executeToolCalls(result.tool_calls, msgs);
          if (!changed) break;

          for (let i = msgs.length - 1; i >= 0 && msgs[i].role === 'tool'; i--) {
            const match = msgs[i].content.match(/__FILE__(.+)/);
            if (match) {
              modifiedFilePath = match[1].trim();
              msgs[i].content = msgs[i].content.replace(/__FILE__.+\\\\n?/, '').trim();
              break;
            }
          }
        } else {
          // 纯文本回复也要存入msgs，方便历史追踪
          msgs.push({ role: 'assistant', content: totalContent });
          break;
        }
      }

      // 存入对话历史（只保存本轮新增的 user + assistant/tool）
      const oldHistoryLen = wechatHistory.length;
      wechatHistory.push(userMsg);
      const skipCount = 1 + oldHistoryLen; // system + 旧历史
      for (let i = skipCount; i < msgs.length; i++) {
        wechatHistory.push(msgs[i]);
      }
      // 裁剪：保留最近 N 条
      while (wechatHistory.length > MAX_HISTORY) {
        wechatHistory.shift();
      }

      const replyText = totalContent || '抱歉，我没能理解。';
      broadcast({ type: 'wechat_msg', user: text || '(附件)', assistant: replyText });

      // 保存到统一会话 + 独立会话文件
      try { 
        saveUnifiedSession('wechat', text || '', replyText, config.ollama.model); 
        // 独立会话文件
        const chatKey = 'wechat:default';
        const sid = getChatSession(chatKey) || genSessionId();
        setChatSession(chatKey, sid);
        const sessMessages: SessionMessage[] = [
          { role: 'user', content: (text || '').slice(0, 10000) },
          { role: 'assistant', content: replyText.slice(0, 10000) },
        ];
        saveSession(sid, undefined, sessMessages, config.ollama.model);
      } catch {}

      reply(replyText, modifiedFilePath);
    } catch (err: any) {
      reply('处理消息时出错: ' + err.message);
    }
  });
}

/** 启动微信机器人 */
app.post('/api/wechat/start', async (_req, res) => {
  try {
    setupWechatHandlers();
    await startWechat();
    res.json({ success: true, message: '微信机器人已启动，请在终端扫码登录' });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

/** 检查微信状态 */
app.get('/api/wechat/status', (_req, res) => {
  res.json(getWechatStatus());
});

/** 停止微信机器人 */
app.post('/api/wechat/stop', (_req, res) => {
  stopWechat();
  res.json({ success: true });
});

/** 重置微信登录（切换账号） */
app.post('/api/wechat/reset', async (_req, res) => {
  try {
    setupWechatHandlers();
    await resetWechat();
    res.json({ success: true, message: '登录态已清除，请扫码登录' });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
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

// ─── 模型基准测试 ──────────────────────────────────────────────
app.post('/api/benchmark', async (req, res) => {
  const { model: testModel } = req.body;
  const m = testModel || config.ollama.model;
  const results: any[] = [];

  // 固定测试文本：small-hermes 项目介绍（约 300 字）
  const projectIntro = `Small Hermes 是一个运行在本地的 AI 聊天助手项目，基于 Ollama 和 gemma4 模型。
它使用 Express 作为后端服务器，React 作为前端界面，支持飞书消息互通。
项目特点是纯本地运行，保护用户隐私，响应速度快，不做复杂的 Agent 功能。
用户可以通过 Web 界面或飞书客户端与模型对话，支持图片、PDF、DOCX 等文件上传分析。
项目还集成了搜索功能，可以通过 Tavily API 搜索互联网获取实时信息。
记忆系统使用 MEMORY.md 和 USER.md 文件存储关键事实，每次对话时注入到系统提示词中。`;

  // 暖机：先发一次"你好"，避免冷启动干扰
  async function warmUp() {
    try {
      const warmBody = JSON.stringify({
        model: m,
        messages: [{ role: 'user', content: '你好' }],
        stream: false,
      });
      await fetch(`${config.ollama.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: warmBody,
      });
    } catch {}
  }

  async function runTest(label: string, repeatCount: number, customContent?: string): Promise<any> {
    // 用自定义内容或重复项目介绍
    const prompt = customContent || Array(repeatCount).fill(projectIntro).join('\n\n');
    const msgs = [{ role: 'user', content: prompt }];
    const body = JSON.stringify({ model: m, messages: msgs, stream: false });
    const bodySize = body.length;

    // 流式测试
    const streamBody = JSON.stringify({ model: m, messages: msgs, stream: true });
    let firstTokenTime = 0;
    let totalTokens = 0;
    let totalDuration = 0;

    try {
      const t0 = Date.now();
      const streamRes = await fetch(`${config.ollama.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody,
      });
      const reader = streamRes.body?.getReader();
      const decoder = new TextDecoder();
      let gotFirstToken = false;
      let buffer = '';
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (!gotFirstToken && (parsed.message?.content || parsed.message?.thinking)) {
              firstTokenTime = Date.now() - t0;
              gotFirstToken = true;
            }
            if (parsed.done) {
              totalDuration = Date.now() - t0;
              totalTokens = parsed.eval_count || 0;
            }
          } catch {}
        }
      }
    } catch (err: any) {
      return { label, error: err.message };
    }

    const tps = totalDuration > 0 && totalTokens > 0
      ? Math.round((totalTokens / (totalDuration / 1000)) * 10) / 10
      : 0;

    // 估算输入层数
    const layers = repeatCount <= 1 ? '1层（正常聊天）'
      : repeatCount <= 3 ? '几层（少量历史）'
      : repeatCount <= 10 ? '10层（较多历史）'
      : repeatCount <= 30 ? '30层（大量历史）'
      : '100层（海量历史）';

    return {
      label,
      repeatCount,
      inputChars: prompt.length,
      bodySizeKB: Math.round(bodySize / 1024),
      layers,
      firstTokenMs: firstTokenTime,
      totalTokens,
      totalDurationMs: totalDuration,
      tps,
    };
  }

  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // 暖机
    res.write(`data: ${JSON.stringify({ type: 'warmup', message: '🔥 暖机中（先发一条"你好"预热模型）...' })}\n\n`);
    await warmUp();
    res.write(`data: ${JSON.stringify({ type: 'warmup', message: '✅ 暖机完成' })}\n\n`);

    // 跑测试，每项间隔 1 秒
    const testCases = [
      { label: '项目介绍', repeat: 1, customContent: projectIntro },
    ];

    for (const tc of testCases) {
      await new Promise(r => setTimeout(r, 1000));
      const result = await runTest(tc.label, tc.repeat, tc.customContent);
      results.push(result);
      res.write(`data: ${JSON.stringify({ type: 'progress', ...result })}\n\n`);
    }

    res.write(`data: ${JSON.stringify({ type: 'done', results })}\n\n`);
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
  }

  res.end();
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

// 设置定时任务触发：广播给 SSE + 推送到所有已连平台
setCronHandler(async (job) => {
  const msg = `⏰ ${job.name}：${job.prompt}`;
  console.log(`[Cron] 触发通知: ${job.name}`);

  // Web UI：广播消息事件（永远可用）
  broadcast({
    type: 'cron_message',
    jobId: job.id,
    jobName: job.name,
    prompt: job.prompt,
    message: msg,
  });

  // 飞书：仅配置了才发
  if (config.feishu.appId) {
    try { await sendToFeishu(msg); } catch (e) { console.error('[Cron] 飞书推送失败:', e); }
  }

  // 微信：仅连接状态才发
  const wxStatus = getWechatStatus();
  if (wxStatus.connected) {
    try { await sendToWechat(msg); } catch (e) { console.error('[Cron] 微信推送失败:', e); }
  }
});

// 启动调度器
startScheduler();

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

  // 自动恢复微信连接（如果有保存的登录态）
  try {
    const configPath = path.resolve(process.cwd(), 'wechat-config.json');
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (raw.botToken && raw.userEntry?.everSucceeded) {
        console.log('[微信] 检测到登录态，自动恢复连接...');
        setupWechatHandlers();
        startWechat();
      }
    }
  } catch {}
});
