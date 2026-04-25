import { config } from './config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];  // base64 图片（Ollama 要求裸 base64，不含 data:image/... 前缀）
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMResponse {
  content: string;
  tool_calls?: ToolCall[];
  thinking?: string;
}

// ─── 系统提示词 ────────────────────────────────────────────────
export function getSystemPrompt(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  const h = now.getHours().toString().padStart(2, '0');
  const min = now.getMinutes().toString().padStart(2, '0');
  return (
    `你是 Small Hermes，一个运行在本地的 AI 聊天助手，基于 Ollama 运行。` +
    `当前日期是 ${y}年${m}月${d}日，时间 ${h}:${min}。` +
    `你不是 AI 角色，而是工具型助手。回答直截了当，不要角色扮演，不要玩文字游戏。` +
    `用户问什么就答什么。` +
    `你可以通过 web_search 工具搜索互联网获取实时信息。` +
    `重要：当搜索工具返回结果后，必须基于搜索结果回答问题，不要忽略搜索结果。`
  );
}

// ─── 工具定义 ────────────────────────────────────────────────────
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '搜索互联网获取实时信息。当用户问的是需要最新数据的问题（新闻、天气、股价、事件等）时使用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
        },
        required: ['query'],
      },
    },
  },
];

/**
 * Ollama 的 /api/chat images 字段要求裸 base64（不含 data:image/...;base64, 前缀）。
 * 此函数清理所有消息中的 images 字段。
 */
function cleanImages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(m => {
    if (m.images && m.images.length > 0) {
      return {
        ...m,
        images: m.images.map(img => {
          const commaIdx = img.indexOf(',');
          return commaIdx > 0 ? img.slice(commaIdx + 1) : img;
        }),
      };
    }
    return m;
  });
}

/** 非流式调用 */
export async function chatComplete(
  messages: ChatMessage[],
  model?: string,
  tools?: any[]
): Promise<LLMResponse> {
  const body: any = {
    model: model || config.ollama.model,
    messages: cleanImages(messages),
    stream: false,
  };
  if (tools) body.tools = tools;

  const res = await fetch(`${config.ollama.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = await res.json();
  const msg = data.message || {};
  return { content: msg.content || '', tool_calls: msg.tool_calls || undefined, thinking: msg.thinking || undefined };
}

/** 流式调用 */
export async function* chatStream(
  messages: ChatMessage[],
  model?: string,
  tools?: any[]
): AsyncGenerator<string> {
  const body: any = {
    model: model || config.ollama.model,
    messages: cleanImages(messages),
    stream: true,
  };
  if (tools) body.tools = tools;

  const res = await fetch(`${config.ollama.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Ollama ${res.status}`);

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';
  let toolCalls: ToolCall[] = [];
  let chunkCount = 0;  // 调试用：计数器

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        // 调试：打印前 5 条原始消息结构
        if (chunkCount < 5) {
          console.log(`[Ollama] 原始消息 #${chunkCount + 1}:`, JSON.stringify({
            hasThinking: !!parsed.message?.thinking,
            hasContent: !!parsed.message?.content,
            thinkingLen: parsed.message?.thinking?.length || 0,
            contentLen: parsed.message?.content?.length || 0,
          }));
          chunkCount++;
        }
        if (parsed.message?.thinking) {
          const chunk = `__THINKING__${parsed.message.thinking}`;
          yield chunk;
        }
        if (parsed.message?.content) {
          const chunk = parsed.message.content;
          yield chunk;
        }
        if (parsed.message?.tool_calls) {
          for (const tc of parsed.message.tool_calls) {
            const existing = toolCalls.find((t) => t.id === tc.id);
            if (existing) {
              existing.function.arguments += tc.function?.arguments || '';
            } else {
              toolCalls.push({
                id: tc.id || `call_${toolCalls.length}`,
                type: 'function',
                function: {
                  name: tc.function?.name || '',
                  arguments: tc.function?.arguments || '',
                },
              });
            }
          }
        }
        if (parsed.done && parsed.eval_count && parsed.eval_duration) {
          const tps = Math.round(parsed.eval_count / (parsed.eval_duration / 1e9) * 10) / 10;
          yield `__STATS__${JSON.stringify({ tokens: parsed.eval_count, tps })}`;
        }
      } catch { /* skip */ }
    }
  }

  if (toolCalls.length > 0) {
    yield `__TOOL_CALL__${JSON.stringify(toolCalls)}`;
  }
}
