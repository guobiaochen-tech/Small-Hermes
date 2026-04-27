import { config } from './config.js';
import { getMemoryBlock, getAssistantName } from './memory.js';
import { getRecentContext } from './sessions.js';
import { getToolDefinitions } from './tools.js';
import fs from 'fs';
import path from 'path';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;   // 思维链，多轮对话时传给下一轮
  images?: string[];   // base64 图片（Ollama 要求裸 base64，不含 data:image/... 前缀）
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

// ─── 技能加载 ──────────────────────────────────────────────────

const SKILLS_DIR = path.resolve(process.cwd(), 'skills');

interface SkillInfo {
  description: string;
  body: string;
  category: string;
}

/** 读取所有技能的内容（用于注入 system prompt） */
function loadSkillsInstructions(): SkillInfo[] {
  try {
    if (!fs.existsSync(SKILLS_DIR)) return [];
    const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.md'));
    return files.map(f => {
      const fullPath = path.join(SKILLS_DIR, f);
      const content = fs.readFileSync(fullPath, 'utf-8');
      // 解析 YAML frontmatter
      const metaMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
      if (!metaMatch) return null;
      const metaLines = metaMatch[1].split('\n');
      const meta: Record<string, string> = {};
      for (const line of metaLines) {
        const idx = line.indexOf(':');
        if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      const body = content.slice(metaMatch[0].length).trim();
      if (!body) return null;
      return {
        description: meta.description || '',
        body,
        category: meta.category || '',
      };
    }).filter(Boolean) as SkillInfo[];
  } catch {
    return [];
  }
}

// ─── 系统提示词 ──────────────────────────────────

export function getSystemPrompt(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  const h = now.getHours().toString().padStart(2, '0');
  const min = now.getMinutes().toString().padStart(2, '0');
  const myName = getAssistantName();

  let prompt = (
    `你是一个运行在本地的 AI 聊天助手，基于 Ollama 运行。` +
    `你的名字是 ${myName}。当用户给你改名时，主动接受并用 memory_replace 更新你的名字记忆。` +
    `当前日期是 ${y}年${m}月${d}日，时间 ${h}:${min}。` +
    `你是一个工具型助手，回答直截了当，不要角色扮演。` +
    `\\n\\n你可以使用以下工具来帮助用户：\\n` +
    `- web_search：搜索互联网获取实时信息\\n` +
    `- read_url：读取指定网页的文本内容（用于点开搜索结果、阅读文章、查询页面）\\n` +
    `- memory_read：读取已保存的记忆（用户画像 / 环境笔记）\\n` +
    `- memory_add：添加新的记忆\\n` +
    `- memory_replace：替换已有记忆\\n` +
    `- memory_remove：删除记忆\\n` +
    `- feishu_doc_create：创建飞书云文档\\n` +
    `- session_search：搜索过去的对话历史，找回之前聊过的内容\\n` +
    `\\n你可以接收和处理的文件类型：\\n` +
    `- 图片：系统已自动解析，你拥有视觉能力，直接描述/分析图片内容即可\\n` +
    `- PDF/DOCX/Excel/文本：系统已自动提取文字内容，消息中的「用户发送了文件」标题后面就是文件内容，直接阅读并回复\\n` +
    `\\n重要规则：` +
    `\\n1. 当搜索工具返回结果后，必须基于搜索结果回答问题` +
    `\\n2. 用户分享的链接会自动读取内容并注入到上下文中，你直接基于这些内容回答即可，不需要调用任何工具` +
    `\\n3. 每次对话中，当你了解到用户的个人信息、偏好、习惯、重要决策时，必须立即调用 memory_add 保存到 user 目标。宁可多记不可漏记` +
    `\\n4. 环境信息、项目事实、工作上下文保存到 memory 目标` +
    `\\n5. 记忆容量有限（memory: 2200字, user: 1375字），满了需要用 memory_replace 替换或 memory_remove 删除旧记忆再添加` +
    `\\n6. 如果你能调用 xlsx_edit 工具，优先先完成用户要求的 Excel 编辑操作` +
    `\\n7. 当用户提到之前聊过的内容、说"上次""之前""还记得吗"时，先调用 session_search 查找历史对话再回答` +
    `\\n8. 系统注入的「最近对话」展示了跨通道的最新交流，直接参考这些内容回答问题即可`
  );

  // 注入技能指令
  const skills = loadSkillsInstructions();
  if (skills.length > 0) {
    prompt += '\n\n══════════════════════════════════════';
    prompt += '\n你还有以下技能：';
    for (const skill of skills) {
      prompt += `\n\n── ${skill.description} ──\n${skill.body}`;
    }
  }

  // 注入已有记忆
  const memBlock = getMemoryBlock('memory');
  const userBlock = getMemoryBlock('user');
  if (memBlock) prompt += `\n\n${memBlock}`;
  if (userBlock) prompt += `\n\n${userBlock}`;

  // 注入最近对话上下文（跨通道汇总）
  const recentCtx = getRecentContext(5);
  if (recentCtx) prompt += `\n\n${recentCtx}`;

  return prompt;
}

// ─── TOOLS（从注册中心获取）────────────────────────────────────

/** 所有可用工具定义（发给 Ollama 的 tools 字段） */
export const TOOLS = getToolDefinitions();

// ─── Ollama API 调用 ──────────────────────────────────────────

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
  let allThinking = '';
  let chunkCount = 0;

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
          allThinking += parsed.message.thinking;
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

  // 完整的思维链，供调用方注入回消息历史
  if (allThinking) {
    yield `__THINKING_FULL__${JSON.stringify(allThinking)}`;
  }

  if (toolCalls.length > 0) {
    yield `__TOOL_CALL__${JSON.stringify(toolCalls)}`;
  }
}
