import * as lark from '@larksuiteoapi/node-sdk';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { chatStream, TOOLS, ChatMessage, getSystemPrompt } from './llm.js';
import { executeToolCalls } from './tools.js';
import { saveUnifiedSession, getChatSession, setChatSession, clearChatSession, getCompressCount, incrementCompressCount, saveSession, type SessionMessage } from './sessions.js';
import { createApproval, resolveApproval } from './approval.js';
import { addMemory } from './memory.js';
import { shouldCompress, compressMessages } from './compress.js';

const client = new lark.Client({
  appId: config.feishu.appId,
  appSecret: config.feishu.appSecret,
  disableTokenCache: false,
});

export const DOWNLOAD_DIR = path.resolve(process.cwd(), 'feishu_uploads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

// SSE 广播函数，由 index.ts 注入
let _broadcast: ((data: any) => void) | null = null;
export function setBroadcast(fn: (data: any) => void) {
  _broadcast = fn;
}

/** 最近一个发消息的用户 open_id（用于文档创建时授权） */
let _lastSenderOpenId: string | null = null;
export function getLastSenderOpenId(): string | null {
  return _lastSenderOpenId;
}

// 已处理消息 ID（防重复）
const seenMsgIds = new Set<string>();
const serverStartTime = Date.now();

// 每个 chat 一次只处理一条消息（防止 WS 重连回放 + 并发导致多个"正在思考"）
const chatQueue = new Map<string, Promise<void>>();

// 等待用户确认的 chat（chatId → approvalId），文本回复即可确认
const chatApprovalMap = new Map<string, string>();

// 已连接的飞书聊天（用于定时任务推送）
const feishuChats = new Set<string>();
export async function sendToFeishu(text: string): Promise<void> {
  const promises = [];
  for (const chatId of feishuChats) {
    promises.push(replyMessage(chatId, 'chat_id', `⏰ ${text}`).catch(() => {}));
  }
  await Promise.all(promises);
}

/** 同个 chat 的消息串行处理：前一个处理完全完成后才执行 fn */
async function processInOrder<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chatQueue.get(chatId) || Promise.resolve();
  // fn 不会执行，直到 prev 完成（即上一个消息的处理完全结束）
  const result = prev.then(() => fn());
  // 更新队列，用 result.then().catch() 保证无论如何都完成
  chatQueue.set(chatId, result.then(() => {}, () => {}) as Promise<void>);
  return result;
}

// ─── 飞书文件下载 ──────────────────────────────────────────────

/** 获取 tenant_access_token */
async function getTenantToken(): Promise<string> {
  const res = await client.request({
    method: 'POST',
    url: '/open-apis/auth/v3/tenant_access_token/internal',
    data: {
      app_id: config.feishu.appId,
      app_secret: config.feishu.appSecret,
    },
  }) as any;
  return res?.data?.tenant_access_token || '';
}

/** 下载飞书图片，返回 base64 字符串（裸 base64，不含 data:image 前缀） */
export async function downloadImageAsBase64(imageKey: string, messageId: string): Promise<{ base64: string; mime: string } | null> {
  try {
    // 使用 SDK 内置的 messageResource.get，自动处理 token + 流式下载
    const result = await client.im.messageResource.get({
      path: { message_id: messageId, file_key: imageKey },
      params: { type: 'image' as any },
    });
    const localPath = path.join(DOWNLOAD_DIR, `${imageKey}.jpg`);
    await result.writeFile(localPath);
    const buffer = fs.readFileSync(localPath);
    const base64 = buffer.toString('base64');
    console.log(`[飞书] 图片已保存: ${localPath} (${buffer.length} bytes)`);
    return { base64, mime: 'jpeg' };
  } catch (err) {
    console.error('[飞书] 下载图片异常:', err);
    return null;
  }
}

/** 下载飞书文件，保存到本地并返回路径和文本内容 */
export async function downloadFile(fileKey: string, messageId: string, ext?: string): Promise<{ localPath: string; text: string } | null> {
  try {
    const result = await client.im.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type: 'file' as any },
    });
    const fileName = ext ? `${fileKey}${ext}` : fileKey;
    const localPath = path.join(DOWNLOAD_DIR, fileName);
    await result.writeFile(localPath);
    console.log(`[飞书] 文件已保存: ${localPath}`);
    const text = readTextFile(localPath);
    return { localPath, text };
  } catch (err) {
    console.error('[飞书] 下载文件异常:', err);
    return null;
  }
}

// ─── 文本文件读取 ──────────────────────────────────────────────

/** 读取文本文件 */
export function readTextFile(filePath: string): string {
  try {
    const buffer = fs.readFileSync(filePath);
    // 尝试 UTF-8
    return buffer.toString('utf-8');
  } catch {
    return '';
  }
}

/** 尝试用 pdfjs-dist 提取 PDF 文本 */
export async function readPdfText(filePath: string): Promise<string> {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(fs.readFileSync(filePath));
    const doc = await pdfjs.getDocument({ data }).promise;
    let text = '';
    for (let i = 1; i <= Math.min(doc.numPages, 20); i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const lines = content.items.map((item: any) => item.str || '').join(' ');
      text += lines + '\n';
    }
    return text.trim();
  } catch (err) {
    console.error('[PDF] 解析失败:', err);
    return '';
  }
}

/** 提取 DOCX 文本 */
export async function readDocxText(filePath: string): Promise<string> {
  try {
    const mammoth = await import('mammoth');
    const buffer = fs.readFileSync(filePath);
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  } catch {
    return '';
  }
}

/** 提取 xlsx/xls 文字（CSV 格式，每个 sheet 用分隔符隔开） */
export async function readXlsxText(filePath: string): Promise<string> {
  try {
    const XLSX = await import('xlsx');
    const buf = fs.readFileSync(filePath);
    const wb = XLSX.read(buf, { type: 'buffer' });
    const sheets: string[] = [];
    for (const name of wb.SheetNames) {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
      if (csv.trim()) {
        sheets.push(`── Sheet: ${name} ──\n${csv}`);
      }
    }
    return sheets.join('\n\n') || '(空表格)';
  } catch {
    return '';
  }
}

/** 获取文件类型信息 */
export async function getFileTypeInfo(filePath: string): Promise<{ type: string; content: string; ext: string }> {
  const ext = path.extname(filePath).toLowerCase();
  const imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

  if (imageExts.has(ext)) {
    const buffer = fs.readFileSync(filePath);
    return { type: 'image', content: buffer.toString('base64'), ext };
  }

  if (ext === '.pdf') {
    const text = await readPdfText(filePath);
    return { type: 'text', content: text, ext };
  }

  if (ext === '.docx') {
    const text = await readDocxText(filePath);
    return { type: 'text', content: text, ext };
  }

  if (['.txt', '.md', '.json', '.js', '.ts', '.py', '.html', '.css', '.csv', '.xml', '.yaml', '.yml', '.log'].includes(ext)) {
    const text = readTextFile(filePath);
    return { type: 'text', content: text, ext };
  }

  return { type: 'unknown', content: '', ext };
}

// ─── 发送消息 ────────────────────────────────────────────────────
async function replyMessage(receiveId: string, receiveIdType: string, text: string) {
  if (text.length > 29000) text = text.slice(0, 29000) + '\n\n…（已截断）';
  try {
    await client.request({
      method: 'POST',
      url: '/open-apis/im/v1/messages',
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
  } catch (err) {
    console.error('[飞书] 发送失败:', err);
  }
}

/** 构建回复卡片（灰色条、剧中） */
function buildReplyCard(reply: string): string {
  const elements: any[] = [];

  elements.push({
    tag: 'markdown',
    content: reply,
  });

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Small Hermes' },
      template: 'grey',
    },
    elements,
  };

  return JSON.stringify(card);
}

/** 飞书卡片 markdown 不支持代码块展开，去掉所有代码标记 */
function sanitizeForFeishu(text: string): string {
  // 1. 去掉 ```python、```javascript 等 fenced code block 标记
  text = text.replace(/```[a-z]*\n?/gi, '');
  // 2. 去掉行首缩进（4空格/tab），防止飞书识别为 indented code block
  text = text.replace(/^[ \t]+/gm, '');
  return text;
}

// ─── 流式更新卡片（打字机效果） ──────────────────────────────────

/** 创建带流式模式的卡片实体（初始内容：点阵动画），返回 card_id */
async function createStreamCard(): Promise<string> {
  const cardJson = {
    schema: '2.0',
    config: {
      streaming_mode: true,
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      title: { tag: 'plain_text', content: 'Small Hermes' },
      template: 'grey',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          element_id: 'main_content',
          content: '⚡ 推理中',
        },
      ],
    },
  };

  const result: any = await client.request({
    method: 'POST',
    url: '/open-apis/cardkit/v1/cards',
    data: {
      type: 'card_json',
      data: JSON.stringify(cardJson),
    },
  });

  return result?.data?.card_id || '';
}

/** 以卡片实体 ID 发送卡片消息 */
async function sendStreamCard(receiveId: string, receiveIdType: string, cardId: string) {
  await client.request({
    method: 'POST',
    url: '/open-apis/im/v1/messages',
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      msg_type: 'interactive',
      content: JSON.stringify({
        type: 'card',
        data: { card_id: cardId },
      }),
    },
  });
}

/** 流式更新卡片文本（打字机效果），element_id 与卡片 JSON 中元素的 id 一致 */
async function streamingUpdateText(
  cardId: string,
  text: string,
  sequence: number,
): Promise<boolean> {
  if (text.length > 100000) text = text.slice(0, 100000) + '\n\n…（已截断）';
  try {
    await client.request({
      method: 'PUT',
      url: `/open-apis/cardkit/v1/cards/${cardId}/elements/main_content/content`,
      data: {
        content: text,
        sequence,
      },
    });
    return true;
  } catch (err: any) {
    console.error('[飞书] 流式更新失败:', err?.message || err);
    return false;
  }
}

/** 发送交互式卡片消息 */
async function replyCard(receiveId: string, receiveIdType: string, reply: string) {
  let content = buildReplyCard(reply);
  // 卡片内容过长时截断
  if (content.length > 100000) {
    content = buildReplyCard(reply.slice(0, 15000) + '\n\n…（回复已截断）');
  }
  try {
    await client.request({
      method: 'POST',
      url: '/open-apis/im/v1/messages',
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: 'interactive',
        content,
      },
    });
  } catch (err) {
    console.error('[飞书] 卡片发送失败:', err);
    await replyMessage(receiveId, receiveIdType, reply);
  }
}

/** 发送工具确认卡片（绿色header + 原生回调按钮，需飞书后台配 card.action.trigger 事件） */
async function sendApprovalCard(chatId: string, approvalId: string, query: string) {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🔍 联网搜索确认' },
      template: 'green',
    },
    elements: [
      {
        tag: 'markdown',
        content: `搜索关键词：**${query}**`,
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 允许' },
            type: 'primary',
            value: JSON.stringify({ approval_id: approvalId, approved: true }),
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ 拒绝' },
            type: 'danger',
            value: JSON.stringify({ approval_id: approvalId, approved: false }),
          },
        ],
      },
    ],
  };

  try {
    await client.request({
      method: 'POST',
      url: '/open-apis/im/v1/messages',
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
    console.log(`[飞书] 确认卡片已发送: ${query}`);
  } catch (err) {
    console.error('[飞书] 确认卡片发送失败:', err);
    // 降级：发文本提示
    await replyMessage(chatId, 'chat_id', `🔍 正在搜索：${query}`);
  }
}

/** 发送消息送达确认（紧跟前一条消息，从外部看像是挂在其下方） */
async function sendReceiptCard(chatId: string) {
  try {
    await client.request({
      method: 'POST',
      url: '/open-apis/im/v1/messages',
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: '✅ 已收到  |  Small Hermes' }),
      },
    });
  } catch (err) {
    // 静默失败
  }
}

// ─── 流式生成 + 卡片回复（支持多轮 tool call）────────────────────
async function doStreamAndReply(chatId: string, messages: ChatMessage[], hasTools: typeof TOOLS | undefined) {
  // 消息送达确认
  sendReceiptCard(chatId).catch(() => {});

  // 多轮 tool call 循环
  let totalReplyText = '';
  let toolLines: string[] = [];
  const msgs = [...messages];
  const MAX_TOOL_ITERATIONS = 2;

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    let thinkingText = '';
    let replyText = '';
    let toolCallsFromStream: any[] = [];

    for await (const chunk of chatStream(msgs, undefined, hasTools)) {
      if (chunk.startsWith('__THINKING_FULL__')) {
        try { thinkingText = JSON.parse(chunk.slice(17)); } catch {}
      } else if (chunk.startsWith('__THINKING__')) {
        thinkingText += chunk.slice(12);
      } else if (chunk.startsWith('__TOOL_CALL__')) {
        try {
          toolCallsFromStream = JSON.parse(chunk.slice(13));
          console.log(`[飞书] 工具调用: ${toolCallsFromStream.length} 个`);
        } catch {}
      } else if (chunk.startsWith('__STATS__')) {
        continue;
      } else {
        replyText += chunk;
        totalReplyText += chunk;
      }
    }

    if (toolCallsFromStream.length > 0) {
      // 对需要确认的工具（web_search），发送询问
      for (const tc of toolCallsFromStream) {
        const name = tc.function?.name || '';
        if (name === 'web_search') {
          const args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {});
          const query = args.query || '';

          // 检查是否已设"一直允许"
          const memoryMod = await import('./memory.js');
          const { entries } = memoryMod.readMemory('memory');
          const alwaysAllow = entries.some(e => e.includes('搜索无需确认') || e.includes('一直允许搜索') || e.includes('联网搜索无需确认'));
          if (alwaysAllow) {
            console.log(`[飞书] 搜索一直允许，直接执行: ${query}`);
            continue; // 跳过确认，直接执行
          }

          const { id, promise } = createApproval(tc);
          chatApprovalMap.set(chatId, id);
          await replyMessage(chatId, 'chat_id', `🔍 需要搜索「**${query}**」，请选择：\n1 不允许\n2 允许\n3 一直允许（以后不再询问）\n（60秒超时自动取消）`);
          const approved = await promise;
          chatApprovalMap.delete(chatId); // 清理
          if (!approved) {
            tc._skipped = true;
            msgs.push({ role: 'assistant', content: '', tool_calls: [tc] });
            msgs.push({ role: 'tool', content: `用户取消了搜索「${query}」的请求`, tool_call_id: tc.id });
            console.log(`[飞书] 用户取消搜索: ${query}`);
          }
        }
      }
      // 构建工具调用摘要，加到回复中
      toolLines = [];
      for (const tc of toolCallsFromStream) {
        const name = tc.function?.name || '';
        const args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {});
        const iconMap: Record<string, string> = { web_search: '🔍', memory_add: '💾', memory_read: '📖', memory_replace: '🔄', memory_remove: '🗑️', read_url: '📄', feishu_doc_create: '📝' };
        const icon = iconMap[name] || '🔧';
        const labelMap: Record<string, string> = { web_search: '联网搜索', memory_add: '保存记忆', memory_read: '读取记忆', memory_replace: '更新记忆', memory_remove: '删除记忆', read_url: '读取网页', feishu_doc_create: '创建飞书文档' };
        if (tc._skipped) {
          toolLines.push(`${icon} ${labelMap[name] || name}: 已取消`);
        } else {
          toolLines.push(`${icon} ${labelMap[name] || name}: ${JSON.stringify(args).slice(0, 100)}`);
        }
      }
      // 使用注册中心执行工具调用（飞书不传 sendEvent → 自动批准）
      const { changed } = await executeToolCalls(toolCallsFromStream, msgs);
      // 把思维链注入到 assistant 消息中
      if (thinkingText) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === 'assistant' && msgs[i].tool_calls && !msgs[i].thinking) {
            msgs[i] = { ...msgs[i], thinking: thinkingText };
          } else if (msgs[i].role === 'system') {
            break;
          }
        }
      }
      if (!changed) break;
      // 如果本轮既有回复又有 tool call，工具执行完就退出
      if (replyText) break;
    } else {
      // 没有 tool call，回复完成
      if (replyText) {
        totalReplyText = replyText;
      }
      break;
    }
  }

  if (!totalReplyText) {
    if (toolLines.length > 0) totalReplyText = toolLines.join('\n');
    else return;
  }
  // 工具调用摘要放在回复最前面
  if (toolLines.length > 0) totalReplyText = toolLines.join('\n') + '\n\n' + totalReplyText;
  console.log(`[飞书] → 回复 ${totalReplyText.length} 字`);

  // 保存到统一会话 + 独立会话文件
  try {
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const userText = lastUserMsg?.content || '';
    saveUnifiedSession('feishu', userText, totalReplyText, config.ollama.model);
    // 独立会话文件
    const sid = getChatSession('feishu:' + chatId) || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    setChatSession('feishu:' + chatId, sid);
    const sessMessages: SessionMessage[] = [
      { role: 'user', content: userText.slice(0, 10000) },
      { role: 'assistant', content: totalReplyText.slice(0, 10000) },
    ];
    saveSession(sid, undefined, sessMessages, config.ollama.model);
  } catch (err) { console.error('[飞书] 会话保存失败:', err); }

  // 发卡片回复
  try {
    await replyCard(chatId, 'chat_id', totalReplyText);
  } catch (err: any) {
    console.error('[飞书] 卡片发送失败，降级文本:', err?.message || err);
    await replyMessage(chatId, 'chat_id', totalReplyText);
  }

  if (_broadcast) _broadcast({ type: 'feishu_assistant', content: totalReplyText });
}

// ─── 处理收到的消息 ──────────────────────────────────────────────
async function handleImMessage(data: any) {
  const msg = data?.message;
  if (!msg) return;

  // 去重
  const msgId: string = msg.message_id || '';
  if (msgId && seenMsgIds.has(msgId)) return;
  if (msgId) seenMsgIds.add(msgId);

  // 跳过服务器启动前的旧消息
  const createTime = parseInt(msg.create_time || '0') * 1000 || 0;
  if (createTime && createTime < serverStartTime) return;

  // 只处理 text, image, file
  const msgType: string = msg.message_type || '';
  if (!['text', 'image', 'file'].includes(msgType)) return;

  // 跳过 bot 自己发的消息
  const senderType = data?.sender?.sender_type;
  if (senderType === 'app') return;

  // 捕获用户 open_id（用于文档创建授权）
  _lastSenderOpenId = data?.sender?.sender_id?.open_id || null;

  const chatId: string = msg.chat_id || '';
  if (chatId) feishuChats.add(chatId);

  if (msgType === 'text') {
    let text = '';
    try {
      const content = JSON.parse(msg.content);
      text = content.text || '';
    } catch {
      text = msg.content || '';
    }
    if (!text.trim()) return;

    // ─── /new /reset 重置会话 ───────────────────────────
    if (/^\/(new|reset)\s*$/i.test(text.trim())) {
      clearChatSession('feishu:' + chatId);
      await replyMessage(chatId, 'chat_id', 'Small Hermes:新会话开始!');
      return;
    }

    // 检查是否是等待确认的回复
    const pendingApprovalId = chatApprovalMap.get(chatId);
    if (pendingApprovalId) {
      const t = text.trim();
      const opt1 = /^(1|不允许|❌|否|拒绝|不|no|n|取消|✗|✘)$/i.test(t);
      const opt2 = /^(2|允许|✅|是|可以|行|好|yes|ok|y|确认|同意|✓|✔)$/i.test(t);
      const opt3 = /^(3|一直允许|始终|永远|总是)$/i.test(t);
      if (opt1 || opt2 || opt3) {
        chatApprovalMap.delete(chatId);
        const approved = opt2 || opt3;
        if (opt3) {
          try { addMemory('memory', '用户允许联网搜索无需确认'); } catch {}
        }
        resolveApproval(pendingApprovalId, approved);
        console.log(`[飞书] 文本确认: approval=${pendingApprovalId} approved=${approved}`);
        const msg = opt1 ? '❌ 已取消搜索' : opt3 ? '✅ 已设为一直允许，以后联网搜索不再询问' : '✅ 已允许，开始搜索…';
        await replyMessage(chatId, 'chat_id', msg);
        return;
      }
      // 不是确认回复，继续正常处理
    }

    // 推送到网页端
    if (_broadcast) _broadcast({ type: 'feishu_user', content: text });

    // 串行处理
    await processInOrder(chatId, async () => {
      console.log(`[飞书] ← ${text.slice(0, 50)}`);
      try {
        const hasTools = TOOLS.length > 0 ? TOOLS : undefined;

        // ─── 取名检测 ────
        const nameRegex = /(?:给你(?:取|换|改)(?:个?名字|个?名)|你叫|叫你|名字叫|名字是|你(?:以后|就)?叫|改名为|给你改名叫|取名为|取名叫|改名叫|给你起(?:名|个名))[：:]?\s*([^\s，。！？,.!?吧了哈哦嗯啊的]{2,8})/;
        const nameMatch = text.match(nameRegex);
        if (nameMatch) {
          const name = nameMatch[1].trim();
          if (name && !/什么|啥|谁|哪里|怎么|干嘛|哪个/.test(name)) {
            const { getAssistantName, setAssistantName } = await import('./memory.js');
            const oldName = getAssistantName();
            setAssistantName(name);
            console.log(`[飞书] 🏷️ 改名: "${oldName}" → "${name}"`);
          }
        }

        const messages: ChatMessage[] = [
          { role: 'system', content: getSystemPrompt() },
          { role: 'user', content: text },
        ];

        // 自动检测 URL 并注入内容
        const urlRegex = /https?:\/\/[^\s<>"']+/g;
        const urls = text.match(urlRegex);
        if (urls && urls.length > 0) {
          for (const url of urls) {
            console.log(`[飞书] 检测到 URL: ${url}`);
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
                let pageText = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
                pageText = pageText.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
                pageText = pageText.replace(/<[^>]+>/g, ' ');
                pageText = pageText.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
                pageText = pageText.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
                pageText = pageText.replace(/\s+/g, ' ').trim();
                if (pageText.length > 10000) pageText = pageText.slice(0, 10000) + '\n\n…（内容较长，已截断）';
                // 注入到 system prompt 后面
                if (pageText) {
                  messages.splice(1, 0, {
                    role: 'system',
                    content: `用户消息中包含链接 ${url}，以下是该网页的文本内容（共 ${pageText.length} 字）：\n${pageText}`,
                  });
                  console.log(`[飞书] URL 内容已注入: ${pageText.length} 字`);
                }
              } else {
                messages.splice(1, 0, {
                  role: 'system',
                  content: `用户消息中包含链接 ${url}，但读取失败（HTTP ${fetchRes.status}）。`,
                });
              }
            } catch (err: any) {
              console.log(`[飞书] URL 读取异常: ${err.message}`);
              messages.splice(1, 0, {
                role: 'system',
                content: `用户消息中包含链接 ${url}，但读取失败（${err.message}）。`,
              });
            }
          }
        }

        // ─── 上下文压缩检测 ─────────────────────────────────
        if (shouldCompress(messages)) {
          const sid = getChatSession('feishu:' + chatId) || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
          setChatSession('feishu:' + chatId, sid);
          const prevCount = getCompressCount(sid);
          const newCount = prevCount + 1;
          incrementCompressCount(sid);
          const notifyMsg = newCount >= 5
            ? `🧹 上下文已压缩（第 ${newCount} 轮），建议输入 /new 重启会话`
            : `🧹 上下文已压缩（第 ${newCount} 轮）`;
          await replyMessage(chatId, 'chat_id', notifyMsg);
          messages.splice(0, messages.length, ...await compressMessages(messages));
        }

        await doStreamAndReply(chatId, messages, hasTools);
      } catch (err) {
        console.error('[飞书] 模型调用失败:', err);
        await replyMessage(chatId, 'chat_id', '⚠️ 模型调用失败，请检查 Ollama 是否运行');
      }
    });
    return;
  }

  if (msgType === 'image') {
    if (_broadcast) _broadcast({ type: 'feishu_user', content: '📷 图片' });

    await processInOrder(chatId, async () => {
      console.log(`[飞书] ← 图片消息`);

      try {
        // 飞书 WS 事件 msg.content 是 JSON 字符串 {"image_key":"..."}
        let imageKey = '';
        try {
          const parsed = JSON.parse(msg.content);
          imageKey = parsed.image_key || '';
        } catch {
          imageKey = msg.content?.image_key || '';
        }
        if (!imageKey) {
          console.error('[飞书] 图片消息缺少 image_key, content:', msg.content?.slice(0, 100));
          await replyMessage(chatId, 'chat_id', '⚠️ 无法获取图片');
          return;
        }

        const imageData = await downloadImageAsBase64(imageKey, msg.message_id);
        if (!imageData) {
          await replyMessage(chatId, 'chat_id', '⚠️ 图片下载失败');
          return;
        }

        const hasTools = TOOLS.length > 0 ? TOOLS : undefined;
        const messages: ChatMessage[] = [
          { role: 'system', content: getSystemPrompt() },
          { role: 'user', content: '分析这张图片的内容', images: [`data:image/${imageData.mime};base64,${imageData.base64}`] },
        ];
        await doStreamAndReply(chatId, messages, hasTools);
      } catch (err) {
        console.error('[飞书] 图片处理失败:', err);
        await replyMessage(chatId, 'chat_id', '⚠️ 图片处理失败');
      }
    });
    return;
  }

  if (msgType === 'file') {
    if (_broadcast) _broadcast({ type: 'feishu_user', content: '📁 文件' });

    await processInOrder(chatId, async () => {
      console.log(`[飞书] ← 文件消息`);

      try {
        // 飞书 WS 事件 msg.content 是 JSON 字符串 {"file_key":"...","file_name":"..."}
        let fileKey = '';
        let fileName = '';
        try {
          const parsed = JSON.parse(msg.content);
          fileKey = parsed.file_key || '';
          fileName = parsed.file_name || parsed.name || '';
        } catch {
          fileKey = msg.content?.file_key || '';
        }
        if (!fileKey) {
          console.error('[飞书] 文件消息缺少 file_key, content:', msg.content?.slice(0, 100));
          await replyMessage(chatId, 'chat_id', '⚠️ 无法获取文件');
          return;
        }

        const fileExt = fileName ? path.extname(fileName).toLowerCase() : undefined;
        const fileData = await downloadFile(fileKey, msg.message_id, fileExt);
        if (!fileData) {
          await replyMessage(chatId, 'chat_id', '⚠️ 文件下载失败');
          return;
        }

        const fileInfo = await getFileTypeInfo(fileData.localPath);
        let userContent = `📁 用户上传了一个文件${fileName ? `「${fileName}」` : ''}`;
        let fileImages: string[] | undefined;

        if (fileInfo.type === 'image' && fileInfo.content) {
          // 图片文件 → 通过 images 字段传给模型
          const mime = fileInfo.ext === 'jpg' ? 'jpeg' : (fileInfo.ext || '').replace('.', '') || 'jpeg';
          fileImages = [`data:image/${mime};base64,${fileInfo.content}`];
          userContent = `📁 用户上传了一个图片文件${fileName ? `「${fileName}」` : ''}，请分析图片内容`;
        } else if (fileInfo.type === 'text' && fileInfo.content) {
          // 直接告诉 LLM 去阅读文件内容并回复，不需要问用户想干嘛
          const contentPreview = fileInfo.content.slice(0, 15000);
          userContent = `📁 用户上传了文件${fileName ? `「${fileName}」` : ''}。请直接阅读以下文件内容，然后自动回复（总结、回答相关问题、提取信息等）。无需询问用户需求。\n\n${contentPreview}`;
        }

        const hasTools = TOOLS.length > 0 ? TOOLS : undefined;
        const messages: ChatMessage[] = [
          { role: 'system', content: getSystemPrompt() },
          { role: 'user', content: userContent, images: fileImages },
        ];
        await doStreamAndReply(chatId, messages, hasTools);
      } catch (err) {
        console.error('[飞书] 文件处理失败:', err);
        await replyMessage(chatId, 'chat_id', '⚠️ 文件处理失败');
      }
    });
  }
}

// ─── 启动长连接 ──────────────────────────────────────────────────
export function startFeishuPolling() {
  if (!config.feishu.appId || !config.feishu.appSecret) {
    console.log('[飞书] 未配置，跳过');
    return;
  }

  const wsClient = new lark.WSClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    loggerLevel: lark.LoggerLevel.error,
  });

  const eventDispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: any) => {
      await handleImMessage(data);
    },
    'card.action.trigger': async (data: any) => {
      try {
        const value = JSON.parse(data?.action?.value || '{}');
        const { approval_id, approved } = value;
        if (approval_id) {
          resolveApproval(approval_id, approved === true);
          console.log(`[飞书] 卡片按钮: approval=${approval_id} approved=${approved}`);
        }
      } catch (err: any) {
        console.error('[飞书] 卡片操作解析失败:', err?.message || err);
      }
    },
  });

  wsClient.start({
    eventDispatcher,
  });

  console.log('[飞书] 长连接已启动');
}

// ─── 云文档创建 ──────────────────────────────────────────────

/** 将 Markdown 文本转换为飞书文档块 */
function mdToBlocks(md: string): any[] {
  const blocks: any[] = [];
  const lines = md.split('\n');
  let inCodeBlock = false;
  let codeContent = '';

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        if (codeContent.trim()) {
          blocks.push({
            block_type: 18,
            code: {
              elements: [{ text_run: { content: codeContent, text_element_style: {} } }],
              style: { language: 1 },
            },
          });
        }
        codeContent = '';
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      codeContent += (codeContent ? '\n' : '') + line;
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^#{1,3}\s/.test(trimmed)) {
      const level = trimmed.match(/^(#{1,3})/)![1].length;
      const text = trimmed.replace(/^#{1,3}\s/, '');
      const fieldName = level === 1 ? 'heading1' : level === 2 ? 'heading2' : 'heading3';
      blocks.push({
        block_type: level + 2,
        [fieldName]: {
          elements: [{ text_run: { content: text, text_element_style: {} } }],
          style: {},
        },
      });
      continue;
    }

    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      blocks.push({
        block_type: 12,
        bullet: {
          elements: [{ text_run: { content: trimmed.slice(2), text_element_style: {} } }],
          style: {},
        },
      });
      continue;
    }

    if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
      blocks.push({ block_type: 22, divider: {} });
      continue;
    }

    blocks.push({
      block_type: 2,
      text: {
        elements: [{ text_run: { content: trimmed, text_element_style: {} } }],
        style: {},
      },
    });
  }

  return blocks;
}

/** 创建飞书云文档 */
export async function createFeishuDoc(title: string, content: string, openId?: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  const t0 = Date.now();
  try {
    if (!config.feishu.appId || !config.feishu.appSecret) {
      return { ok: false, error: '飞书未配置（缺少 appId/appSecret）。请在 .env 中设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET' };
    }

    // 1. 创建文档
    console.log(`[飞书文档] 创建: ${title}`);
    const createRes: any = await client.request({
      method: 'POST',
      url: '/open-apis/docx/v1/documents',
      data: { title },
    });
    if (createRes.code !== 0) {
      return { ok: false, error: `创建文档失败: ${createRes.msg || JSON.stringify(createRes)}` };
    }
    const docId: string = createRes.data.document.document_id;
    const docUrl = `https://bytedance.feishu.cn/docx/${docId}`;

    // 2. 转换内容为块
    const blocks = mdToBlocks(content);
    if (blocks.length === 0) {
      blocks.push({
        block_type: 2,
        text: { elements: [{ text_run: { content: content.slice(0, 5000), text_element_style: {} } }], style: {} },
      });
    }

    // 3. 批量添加块
    const BATCH_SIZE = 50;
    for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
      const batch = blocks.slice(i, i + BATCH_SIZE);
      const addRes: any = await client.request({
        method: 'POST',
        url: `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`,
        data: { children: batch, index: -1 },
      });
      if (addRes.code !== 0) {
        console.error(`[飞书文档] 添加块失败:`, JSON.stringify(addRes));
        return { ok: false, error: `添加内容失败: ${addRes.msg || JSON.stringify(addRes)}` };
      }
      if (i + BATCH_SIZE < blocks.length) {
        await new Promise(r => setTimeout(r, 50));
      }
    }

    // 4. 如果有用户 open_id，分享文档给该用户
    if (openId) {
      try {
        const shareRes: any = await client.request({
          method: 'POST',
          url: `/open-apis/drive/v1/permissions/${docId}/members`,
          data: {
            member_type: 'openid',
            member_id: openId,
            perm: 'full_access',
          },
        });
        if (shareRes.code !== 0) {
          console.error(`[飞书文档] 分享失败:`, JSON.stringify(shareRes));
          // 不阻断——文档已创建，只是没分享成功
        } else {
          console.log(`[飞书文档] 已分享给用户: ${openId}`);
        }
      } catch (err: any) {
        console.error(`[飞书文档] 分享异常:`, err.message);
      }
    }

    console.log(`[飞书文档] 完成: ${docUrl} (${Date.now() - t0}ms, ${blocks.length} blocks)`);
    return { ok: true, url: docUrl };
  } catch (err: any) {
    console.error('[飞书文档] 异常:', err);
    return { ok: false, error: err.message || '未知错误' };
  }
}
