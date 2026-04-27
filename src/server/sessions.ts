import fs from 'fs';
import path from 'path';

// ─── 配置 ────────────────────────────────────────────────
const SESSION_DIR = path.resolve(process.cwd(), 'sessions');
const INDEX_FILE = path.join(SESSION_DIR, 'index.json');
const CHAT_SESSION_FILE = path.join(SESSION_DIR, 'chat_sessions.json');

// gemma4:26b 上下文窗口
const MODEL_CONTEXT_TOKENS = 256000;
const COMPRESS_RATIO = 0.6;

/** 压缩 token 阈值：上下文的 60% */
export const TOKEN_COMPRESS_THRESHOLD = Math.floor(MODEL_CONTEXT_TOKENS * COMPRESS_RATIO);

// ─── 类型 ────────────────────────────────────────────────
export interface SessionMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  time?: number;
}

export interface SessionMeta {
  id: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  msgCount: number;
  compressCount: number;
}

export interface SessionData extends SessionMeta {
  messages: SessionMessage[];
}

// ─── 内部工具 ────────────────────────────────────────────

function ensureDir() {
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
}

function readIndex(): SessionMeta[] {
  ensureDir();
  if (!fs.existsSync(INDEX_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function writeIndex(meta: SessionMeta[]) {
  ensureDir();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(meta, null, 2), 'utf-8');
}

function sessionPath(id: string): string {
  return path.join(SESSION_DIR, `${id}.json`);
}

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ─── chat_id → session_id 映射（飞书/微信用） ──────────

function readChatMap(): Record<string, string> {
  ensureDir();
  if (!fs.existsSync(CHAT_SESSION_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CHAT_SESSION_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeChatMap(map: Record<string, string>) {
  ensureDir();
  fs.writeFileSync(CHAT_SESSION_FILE, JSON.stringify(map, null, 2), 'utf-8');
}

export function getChatSession(chatId: string): string | null {
  return readChatMap()[chatId] || null;
}

export function setChatSession(chatId: string, sessionId: string) {
  const map = readChatMap();
  map[chatId] = sessionId;
  writeChatMap(map);
}

export function clearChatSession(chatId: string): string {
  const map = readChatMap();
  delete map[chatId];
  writeChatMap(map);
  const newId = genId();
  map[chatId] = newId;
  writeChatMap(map);
  return newId;
}

// ─── 压缩计数 ──────────────────────────────────────────

export function getCompressCount(sessionId: string): number {
  const data = getSession(sessionId);
  return data?.compressCount || 0;
}

export function incrementCompressCount(sessionId: string): number {
  ensureDir();
  const data = getSession(sessionId);
  if (!data) return 0;
  const newCount = (data.compressCount || 0) + 1;
  data.compressCount = newCount;
  fs.writeFileSync(sessionPath(sessionId), JSON.stringify(data, null, 2), 'utf-8');
  // 同步更新 index
  const meta = readIndex();
  const found = meta.find(m => m.id === sessionId);
  if (found) {
    found.compressCount = newCount;
    writeIndex(meta);
  }
  return newCount;
}

// ─── Token 估算 ─────────────────────────────────────────

/** 粗略估算消息占用的 token 数（中文约1.5-2 chars/token，英文约4 chars/token，取3） */
export function estimateTokens(messages: SessionMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content || '').length;
  }
  return Math.ceil(chars / 3);
}

// ─── 对外接口 ────────────────────────────────────────────

/** 保存/更新一个会话。如果 id 不存在则自动创建 */
export function saveSession(
  id: string | undefined,
  title: string | undefined,
  messages: SessionMessage[],
  model: string,
  compressCount?: number,
): SessionMeta {
  ensureDir();
  const sid = id || genId();
  const now = Date.now();
  const meta = readIndex();
  const existing = meta.find(m => m.id === sid);

  const newMeta: SessionMeta = {
    id: sid,
    title: title || (messages.find(m => m.role === 'user')?.content?.slice(0, 30) || '新对话'),
    model,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    msgCount: messages.length,
    compressCount: compressCount ?? existing?.compressCount ?? 0,
  };

  // 更新索引
  if (existing) {
    Object.assign(existing, newMeta);
  } else {
    meta.push(newMeta);
  }
  writeIndex(meta);

  // 写入完整数据
  const data: SessionData = { ...newMeta, messages };
  fs.writeFileSync(sessionPath(sid), JSON.stringify(data, null, 2), 'utf-8');

  return newMeta;
}

/** 列出所有会话（按更新时间倒序） */
export function listSessions(limit = 50): SessionMeta[] {
  return readIndex()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

/** 读取指定会话的完整内容 */
export function getSession(id: string): SessionData | null {
  const p = sessionPath(id);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/** 删除指定会话 */
export function deleteSession(id: string): boolean {
  const p = sessionPath(id);
  let removed = false;
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    removed = true;
  }
  const meta = readIndex().filter(m => m.id !== id);
  writeIndex(meta);
  return removed;
}

/** 搜索会话内容（关键词匹配消息文本） */
export function searchSessions(query: string, limit = 20): { session: SessionMeta; matches: string[] }[] {
  const results: { session: SessionMeta; matches: string[] }[] = [];
  const meta = readIndex();

  for (const m of meta) {
    const data = getSession(m.id);
    if (!data) continue;
    const matches = data.messages
      .filter(msg => msg.content.toLowerCase().includes(query.toLowerCase()))
      .map(msg => msg.content.slice(0, 100));
    if (matches.length > 0) {
      results.push({ session: m, matches });
    }
    if (results.length >= limit) break;
  }

  return results;
}

/** 获取最近一次会话 */
export function getLastSession(): SessionData | null {
  const list = listSessions(1);
  return list.length > 0 ? getSession(list[0].id) : null;
}

// ─── 统一会话（三通道共享） ────────────────────────────────

const UNIFIED_SESSION_ID = 'unified';

/** 保存一条消息到统一会话（Web UI / 飞书 / 微信共享） */
export function saveUnifiedSession(
  channel: 'web' | 'feishu' | 'wechat',
  userText: string,
  assistantText: string,
  model: string,
  assistantThinking?: string,
): SessionMeta {
  ensureDir();
  const now = Date.now();
  const existing = getSession(UNIFIED_SESSION_ID);

  const userMsg: SessionMessage = {
    role: 'user',
    content: `[${channel}] ${userText.slice(0, 5000)}`,
    time: now,
  };
  const asstMsg: SessionMessage = {
    role: 'assistant',
    content: assistantText.slice(0, 10000),
    time: now,
  };
  if (assistantThinking) (asstMsg as any).thinking = assistantThinking.slice(0, 5000);

  const messages = existing
    ? [...existing.messages, userMsg, asstMsg]
    : [userMsg, asstMsg];

  return saveSession(UNIFIED_SESSION_ID, '统一会话', messages, model);
}

// ─── 上下文注入与搜索 ─────────────────────────────────────

/** 从统一会话中获取最近 N 轮对话，注入 system prompt */
export function getRecentContext(maxTurns = 5): string {
  const data = getSession(UNIFIED_SESSION_ID);
  if (!data || !data.messages.length) return '';

  const recent = data.messages.slice(-maxTurns * 2); // N轮 = N user + N assistant
  if (!recent.length) return '';

  const lines = recent.map((m, i) => {
    const tag = m.role === 'user' ? '👤' : '🤖';
    const content = m.content.slice(0, 300).replace(/\n/g, ' ');
    return `${tag} ${content}`;
  });

  return `最近对话（跨通道汇总）：\n${lines.join('\n')}`;
}

/** 搜索所有会话内容（关键词匹配），返回摘要 */
export function searchAllSessions(query: string, maxResults = 5): string {
  if (!query?.trim()) return '';

  const results = searchSessions(query, maxResults);
  if (!results.length) return '未找到匹配的对话。';

  return results.map((r, i) =>
    `${i + 1}. [${r.session.title.slice(0, 40)}] ${r.session.model} | ${new Date(r.session.updatedAt).toLocaleString('zh-CN')}\n` +
    r.matches.map(m => `   - ${m}`).join('\n')
  ).join('\n\n');
}
