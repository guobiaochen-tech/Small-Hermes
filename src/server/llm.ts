import { config } from './config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
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

/** 非流式调用 */
export async function chatComplete(
  messages: ChatMessage[],
  model?: string,
  tools?: any[]
): Promise<LLMResponse> {
  const body: any = {
    model: model || config.ollama.model,
    messages,
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
    messages,
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
        if (parsed.message?.thinking) {
          yield `__THINKING__${parsed.message.thinking}`;
        }
        if (parsed.message?.content) {
          yield parsed.message.content;
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
