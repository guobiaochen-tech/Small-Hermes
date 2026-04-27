import { ChatMessage, chatComplete } from './llm.js';
import { TOKEN_COMPRESS_THRESHOLD, estimateTokens } from './sessions.js';

// 保留的最新消息数（不被压缩）
const KEEP_RECENT = 10;

/**
 * 判断是否需要对消息列表进行上下文压缩
 * 阈值：60% of 256K = 153600 tokens
 */
export function shouldCompress(messages: ChatMessage[]): boolean {
  // 只统计 user 和 assistant 消息
  const chatMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant');
  const tokens = estimateTokens(chatMessages as any);
  return tokens >= TOKEN_COMPRESS_THRESHOLD;
}

/**
 * 压缩历史消息：将旧消息用 Ollama 缩成摘要，
 * 返回新的消息数组（摘要 + 最新 KEEP_RECENT 条原始消息）
 */
export async function compressMessages(messages: ChatMessage[]): Promise<ChatMessage[]> {
  const chatMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant');
  const tokens = estimateTokens(chatMessages as any);

  if (tokens < TOKEN_COMPRESS_THRESHOLD) return messages;

  // 分离：旧消息（要压缩）+ 新消息（保留）
  const oldMessages = chatMessages.slice(0, chatMessages.length - KEEP_RECENT);
  const recentMessages = chatMessages.slice(chatMessages.length - KEEP_RECENT);

  console.log(`[压缩] ${tokens} tokens (阈值 ${TOKEN_COMPRESS_THRESHOLD})，压缩 ${oldMessages.length} 条，保留 ${recentMessages.length} 条`);

  try {
    const compressPrompt: ChatMessage[] = [
      {
        role: 'system',
        content: '你是对话摘要助手。将以下对话浓缩为一段简洁的摘要（中文），保留：\n' +
          '1. 用户问过的主要问题\n' +
          '2. 你给出的关键回答和结论\n' +
          '3. 用户提到的个人信息和偏好\n' +
          '4. 双方达成的共识和决定\n\n' +
          '要求：摘要不超过 300 字，用连贯的段落形式，不要列表。只输出摘要内容，不要额外说明。',
      },
      ...oldMessages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }) as ChatMessage),
    ];

    const result = await chatComplete(compressPrompt, undefined, undefined);
    const summary = result.content?.trim();
    
    if (!summary) {
      console.log('[压缩] 摘要为空，跳过压缩');
      return messages;
    }

    console.log(`[压缩] 摘要已生成 (${summary.length} 字): ${summary.slice(0, 100)}...`);

    // 构建压缩后的消息列表：保留 system prompt + 摘要 + 最近消息
    const systemMessages = messages.filter(m => m.role === 'system');
    const compressedContext: ChatMessage = {
      role: 'system',
      content: `以下是之前对话的摘要：\n${summary}`,
    };

    return [...systemMessages, compressedContext, ...recentMessages];
  } catch (err) {
    console.error('[压缩] 失败:', err);
    return messages;
  }
}
