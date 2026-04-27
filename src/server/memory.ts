import fs from 'fs';
import path from 'path';

// ─── 配置 ────────────────────────────────────────────────────────
const MEMORY_DIR = path.resolve(process.cwd(), 'memories');
const MEMORY_CHAR_LIMIT = 2200;   // MEMORY.md 上限
const USER_CHAR_LIMIT = 1375;     // USER.md 上限
const ENTRY_DELIMITER = '\n§\n';

// ─── 记忆文件路径 ────────────────────────────────────────────────
function memPath(target: 'memory' | 'user'): string {
  return target === 'user'
    ? path.join(MEMORY_DIR, 'USER.md')
    : path.join(MEMORY_DIR, 'MEMORY.md');
}

// ─── 内部读写 ────────────────────────────────────────────────────

function ensureDir() {
  if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
  }
}

function readEntries(target: 'memory' | 'user'): string[] {
  const p = memPath(target);
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf-8').trim();
  if (!raw) return [];
  return raw.split(ENTRY_DELIMITER).map(e => e.trim()).filter(Boolean);
}

function writeEntries(target: 'memory' | 'user', entries: string[]) {
  ensureDir();
  const content = entries.length > 0 ? entries.join(ENTRY_DELIMITER) : '';
  // 原子写入：临时文件 + rename
  const p = memPath(target);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, p);
}

function charLimit(target: 'memory' | 'user'): number {
  return target === 'user' ? USER_CHAR_LIMIT : MEMORY_CHAR_LIMIT;
}

// ─── 对外接口 ────────────────────────────────────────────────────

/** 获取记忆内容（用于注入 system prompt） */
export function getMemoryBlock(target: 'memory' | 'user'): string {
  const entries = readEntries(target);
  if (entries.length === 0) return '';

  const limit = charLimit(target);
  const content = entries.join(ENTRY_DELIMITER);
  const current = content.length;
  const pct = Math.min(100, Math.round((current / limit) * 100));

  const label = target === 'user' ? 'USER PROFILE' : 'MEMORY';
  const header = `${label} [${pct}% — ${current.toLocaleString()}/${limit.toLocaleString()} chars]`;
  const separator = '═'.repeat(46);
  return `${separator}\n${header}\n${separator}\n${content}`;
}

/** 获取所有记忆条目（用于 tool call 返回给模型） */
export function readMemory(target: 'memory' | 'user'): { entries: string[]; usage: string } {
  const entries = readEntries(target);
  const current = entries.length > 0 ? entries.join(ENTRY_DELIMITER).length : 0;
  const limit = charLimit(target);
  const pct = Math.min(100, Math.round((current / limit) * 100));
  return {
    entries,
    usage: `${pct}% — ${current.toLocaleString()}/${limit.toLocaleString()} chars`,
  };
}

/** 添加一条记忆 */
export function addMemory(target: 'memory' | 'user', content: string): { success: boolean; error?: string; entries: string[]; usage: string } {
  content = content.trim();
  if (!content) return { success: false, error: '内容不能为空', entries: [], usage: '' };

  const entries = readEntries(target);
  const limit = charLimit(target);

  // 去重
  if (entries.includes(content)) {
    return { success: true, entries, usage: readMemory(target).usage, error: undefined };
  }

  // 检查是否超限
  const newEntries = [...entries, content];
  const newTotal = newEntries.join(ENTRY_DELIMITER).length;
  if (newTotal > limit) {
    const current = entries.length > 0 ? entries.join(ENTRY_DELIMITER).length : 0;
    return {
      success: false,
      error: `记忆已满 (${current.toLocaleString()}/${limit.toLocaleString()} 字符)。请先删除旧记忆。`,
      entries,
      usage: `${Math.round((current / limit) * 100)}% — ${current.toLocaleString()}/${limit.toLocaleString()} chars`,
    };
  }

  writeEntries(target, newEntries);
  return { success: true, entries: newEntries, usage: readMemory(target).usage };
}

/** 替换一条记忆（通过 oldText 子串匹配） */
export function replaceMemory(target: 'memory' | 'user', oldText: string, newContent: string): { success: boolean; error?: string; entries: string[]; usage: string } {
  oldText = oldText.trim();
  newContent = newContent.trim();
  if (!oldText) return { success: false, error: 'oldText 不能为空', entries: [], usage: '' };
  if (!newContent) return { success: false, error: 'newContent 不能为空，请使用 remove', entries: [], usage: '' };

  const entries = readEntries(target);
  const idx = entries.findIndex(e => e.includes(oldText));
  if (idx === -1) return { success: false, error: `未找到包含"${oldText}"的记忆`, entries, usage: readMemory(target).usage };

  entries[idx] = newContent;
  const limit = charLimit(target);
  const newTotal = entries.join(ENTRY_DELIMITER).length;
  if (newTotal > limit) {
    return { success: false, error: '替换后超出容量上限', entries, usage: readMemory(target).usage };
  }

  writeEntries(target, entries);
  return { success: true, entries, usage: readMemory(target).usage };
}

/** 删除一条记忆（通过 oldText 子串匹配） */
export function removeMemory(target: 'memory' | 'user', oldText: string): { success: boolean; error?: string; entries: string[]; usage: string } {
  oldText = oldText.trim();
  if (!oldText) return { success: false, error: 'oldText 不能为空', entries: [], usage: '' };

  const entries = readEntries(target);
  const idx = entries.findIndex(e => e.includes(oldText));
  if (idx === -1) return { success: false, error: `未找到包含"${oldText}"的记忆`, entries, usage: readMemory(target).usage };

  entries.splice(idx, 1);
  writeEntries(target, entries);
  return { success: true, entries, usage: readMemory(target).usage };
}

// ─── 助手名字管理 ────────────────────────────────────────────
const NAME_ENTRY_PREFIX = 'AI名字:';

/** 获取当前助手的名字（从 MEMORY.md 读取），默认 "Small Hermes" */
export function getAssistantName(): string {
  const entries = readEntries('memory');
  const entry = entries.find(e => e.startsWith(NAME_ENTRY_PREFIX));
  return entry ? entry.slice(NAME_ENTRY_PREFIX.length).trim() : 'Small Hermes';
}

/** 保存/更新助手名字到 MEMORY.md */
export function setAssistantName(name: string): boolean {
  name = name.trim();
  if (!name) return false;
  const entries = readEntries('memory');
  const idx = entries.findIndex(e => e.startsWith(NAME_ENTRY_PREFIX));
  const newEntry = `${NAME_ENTRY_PREFIX} ${name}`;
  if (idx >= 0) {
    entries[idx] = newEntry;
  } else {
    entries.push(newEntry);
  }
  writeEntries('memory', entries);
  return true;
}
