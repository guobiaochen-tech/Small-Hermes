import * as lark from '@larksuiteoapi/node-sdk';
import { config } from './config.js';
import { chatComplete, chatStream, TOOLS, ChatMessage } from './llm.js';
import { webSearch, formatSearchResults } from './search.js';

const client = new lark.Client({
  appId: config.feishu.appId,
  appSecret: config.feishu.appSecret,
  disableTokenCache: false,
});

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
    header: {
      title: { tag: 'plain_text', content: '🤖 Small Hermes · 思考中' },
      template: 'purple',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          element_id: 'main_content',
          content: '⏳ 正在思考…',
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
  // 创建流式思考卡片
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
  let thinkingSent = false;

  // 节流的卡片更新
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
      if (streamOk && thinkingText.trim()) {
        pendingUpdate = `🤔 推理过程：\n\n${sanitizeForFeishu(thinkingText)}`;
        scheduleUpdate();
      }
    } else if (chunk.startsWith('__STATS__') || chunk.startsWith('__TOOL_CALL__')) {
      continue;
    } else {
      // 第一条内容到达时，推理已完成 → 确保最后一次卡片更新
      if (thinkingText && !thinkingSent) {
        await flushUpdate();
        // 等一小会，让飞书客户端渲染完最后的推理更新再发回答
        await new Promise(r => setTimeout(r, 200));
        thinkingSent = true;
        console.log(`[飞书] → 推理完成 ${thinkingText.length} 字（流式卡片）`);
      }
      replyText += chunk;
    }
  }

  // 清理定时器
  if (updateTimer) {
    clearTimeout(updateTimer);
    updateTimer = null;
  }

  // 流结束后，如果还有推理未发送
  if (thinkingText && !thinkingSent) {
    await flushUpdate();
    thinkingSent = true;
    console.log(`[飞书] → 推理已发送 ${thinkingText.length} 字`);
  }

  if (!replyText) return;
  console.log(`[飞书] → 回复 ${replyText.length} 字${thinkingText ? `，推理 ${thinkingText.length} 字（流式卡片）` : ''}`);

  // 发送最终回答
  if (thinkingText) {
    await replyCard(chatId, 'chat_id', replyText);
  } else {
    await replyMessage(chatId, 'chat_id', replyText);
  }

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

  // 只处理文本
  if (msg.message_type !== 'text') return;

  // 跳过 bot 自己发的消息
  const senderType = data?.sender?.sender_type;
  if (senderType === 'app') return;

  let text = '';
  try {
    const content = JSON.parse(msg.content);
    text = content.text || '';
  } catch {
    text = msg.content || '';
  }
  if (!text.trim()) return;

  const chatId: string = msg.chat_id || '';
  // 推送到网页端
  if (_broadcast) _broadcast({ type: 'feishu_user', content: text });

  // 串行处理：前一个消息完全处理完成（含模型调用）后才执行这个
  await processInOrder(chatId, async () => {
    console.log(`[飞书] ← ${text.slice(0, 50)}`);

    // 先秒回，让用户知道已收到
    await replyMessage(chatId, 'chat_id', '🤔 正在思考…');

    try {
      const hasTools = config.tavily.apiKey ? TOOLS : undefined;
    const messages: ChatMessage[] = [{ role: 'user', content: text }];

    // 如有工具，先非流式检查是否需要搜索
    if (hasTools) {
      const firstResult = await chatComplete(messages, undefined, hasTools);
      if (firstResult.tool_calls?.length) {
        for (const tc of firstResult.tool_calls) {
          if (tc.function.name === 'web_search') {
            const args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
            console.log(`[搜索] ${args.query}`);
            if (_broadcast) _broadcast({ type: 'feishu_assistant', content: `🔍 搜索: ${args.query}` });

            const searchResults = await webSearch(args.query);
            const searchContent = formatSearchResults(args.query, searchResults);
            messages.push({ role: 'assistant', content: '', tool_calls: firstResult.tool_calls });
            messages.push({ role: 'tool', content: searchContent, tool_call_id: tc.id });
          }
        }
        // 需要搜索 → 走流式生成
        await doStreamAndReply(chatId, messages, hasTools);
      } else {
        // 不需要搜索 → 直接用 firstResult 的内容
        console.log(`[飞书] → 回复 ${(firstResult.content || '').length} 字（单次调用，无需搜索）`);

        if (firstResult.thinking) {
          // 有推理内容 → 用卡片形式显示
          let cardId = '';
          try {
            cardId = await createStreamCard();
            if (cardId) {
              await sendStreamCard(chatId, 'chat_id', cardId);
              const ok = await streamingUpdateText(cardId, `🤔 推理过程：\n\n${sanitizeForFeishu(firstResult.thinking)}`, 1);
              if (ok) await streamingUpdateText(cardId, `🤔 推理过程：\n\n${sanitizeForFeishu(firstResult.thinking)}\n\n---\n已推理完成 ✓`, 2);
            }
          } catch (err) {
            console.error('[飞书] 推理卡片失败:', err);
          }
          await replyCard(chatId, 'chat_id', firstResult.content || '');
        } else {
          await replyMessage(chatId, 'chat_id', firstResult.content || '');
        }
        if (_broadcast) _broadcast({ type: 'feishu_assistant', content: firstResult.content || '' });
      }
      return;
    }

    // 无 Tavily 配置 → 直接流式
    await doStreamAndReply(chatId, messages, undefined);
    } catch (err) {
      console.error('[飞书] 模型调用失败:', err);
      await replyMessage(chatId, 'chat_id', '⚠️ 模型调用失败，请检查 Ollama 是否运行');
    }
  });
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
