import * as lark from '@larksuiteoapi/node-sdk';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { chatStream, TOOLS, ChatMessage, getSystemPrompt } from './llm.js';
import { webSearch, formatSearchResults } from './search.js';

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

// 已处理消息 ID（防重复）
const seenMsgIds = new Set<string>();
const serverStartTime = Date.now();

// 每个 chat 一次只处理一条消息（防止 WS 重连回放 + 并发导致多个"正在思考"）
const chatQueue = new Map<string, Promise<void>>();

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

/** 构建回复卡片 */
function buildReplyCard(reply: string): string {
  const elements: any[] = [];

  elements.push({
    tag: 'markdown',
    content: reply,
  });

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🤖 Small Hermes' },
      template: 'purple',
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

/** 创建带流式模式的卡片实体，返回 card_id */
async function createStreamCard(): Promise<string> {
  const cardJson = {
    schema: '2.0',
    config: {
      streaming_mode: true,
      update_multi: true,
      wide_screen_mode: true,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          element_id: 'main_content',
          content: '🧠 思考中…',
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

// 流式生成 + 卡片回复（用于需要搜索后或无需搜索时）
async function doStreamAndReply(chatId: string, messages: ChatMessage[], hasTools: typeof TOOLS | undefined) {
  // 创建流式思考卡片（极简：只显示"🧠 思考中…"）
  let cardId = '';
  let streamOk = false;
  let seq = 0;
  try {
    cardId = await createStreamCard();
    if (cardId) {
      await sendStreamCard(chatId, 'chat_id', cardId);
      streamOk = true;
    }
  } catch (err) {
    console.error('[飞书] 流式卡片创建失败，降级:', err);
  }

  // 流式获取推理 + 内容
  let thinkingText = '';
  let replyText = '';
  let answerStarted = false;

  // 回答内容节流更新
  let pendingUpdate = '';
  let updateTimer: ReturnType<typeof setTimeout> | null = null;

  const flushUpdate = async () => {
    if (updateTimer) {
      clearTimeout(updateTimer);
      updateTimer = null;
    }
    if (pendingUpdate && streamOk) {
      seq++;
      const ok = await streamingUpdateText(cardId, pendingUpdate, seq);
      if (!ok) streamOk = false;
      pendingUpdate = '';
    }
  };

  const scheduleUpdate = () => {
    if (!updateTimer) {
      updateTimer = setTimeout(flushUpdate, 100);
    }
  };

  for await (const chunk of chatStream(messages, undefined, hasTools)) {
    if (chunk.startsWith('__THINKING__')) {
      thinkingText += chunk.slice(12);
    } else if (chunk.startsWith('__STATS__') || chunk.startsWith('__TOOL_CALL__')) {
      continue;
    } else {
      if (!answerStarted) {
        answerStarted = true;
        console.log(`[飞书] → 推理完成 ${thinkingText.length} 字，开始显示回答`);
      }
      replyText += chunk;
      if (streamOk) {
        pendingUpdate = sanitizeForFeishu(replyText);
        scheduleUpdate();
      }
    }
  }

  // 最终刷新
  await flushUpdate();

  if (!replyText) return;
  console.log(`[飞书] → 回复 ${replyText.length} 字${thinkingText ? `，推理 ${thinkingText.length} 字` : ''}`);

  if (_broadcast) _broadcast({ type: 'feishu_assistant', content: replyText });
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

  const chatId: string = msg.chat_id || '';

  if (msgType === 'text') {
    let text = '';
    try {
      const content = JSON.parse(msg.content);
      text = content.text || '';
    } catch {
      text = msg.content || '';
    }
    if (!text.trim()) return;

    // 推送到网页端
    if (_broadcast) _broadcast({ type: 'feishu_user', content: text });

    // 串行处理
    await processInOrder(chatId, async () => {
      console.log(`[飞书] ← ${text.slice(0, 50)}`);
      await replyMessage(chatId, 'chat_id', '🤔 正在思考…');
      try {
        const hasTools = config.tavily.apiKey ? TOOLS : undefined;
        const messages: ChatMessage[] = [
          { role: 'system', content: getSystemPrompt() },
          { role: 'user', content: text },
        ];
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
      await replyMessage(chatId, 'chat_id', '🤔 正在分析图片…');

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

        const hasTools = config.tavily.apiKey ? TOOLS : undefined;
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
      await replyMessage(chatId, 'chat_id', '🤔 正在处理文件…');

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

        const hasTools = config.tavily.apiKey ? TOOLS : undefined;
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
  });

  wsClient.start({
    eventDispatcher,
  });

  console.log('[飞书] 长连接已启动');
}
