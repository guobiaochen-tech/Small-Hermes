/**
 * 工具注册中心
 * 
 * 所有工具（内置 + 技能加载）统一注册到此。
 * 替代原来 llm.ts 里硬编码的 TOOLS 和 index.ts/feishu.ts 里重复的 executeToolCalls。
 */
import { ChatMessage } from './llm.js';
import { webSearch, formatSearchResults } from './search.js';
import { readMemory, addMemory, replaceMemory, removeMemory } from './memory.js';
import { searchAllSessions } from './sessions.js';
import { createApproval } from './approval.js';
import fs from 'fs';
import path from 'path';

// ─── 类型 ──────────────────────────────────────────────────────

export interface ToolHandler {
  name: string;
  description: string;
  parameters: Record<string, any>;
  /** 执行工具，返回 { changed } 表示是否真的执行了操作 */
  handler: (
    args: Record<string, any>,
    toolCall: any,
    msgs: ChatMessage[],
    sendEvent?: (data: any) => void,
  ) => Promise<{ changed: boolean }>;
}

// ─── 注册表 ──────────────────────────────────────────────────

const handlers = new Map<string, ToolHandler>();

/** 注册一个工具 */
export function registerTool(def: ToolHandler): void {
  handlers.set(def.name, def);
  console.log(`[工具] 注册: ${def.name}`);
}

/** 获取所有工具定义（Ollama function calling 格式） */
export function getToolDefinitions(): any[] {
  return Array.from(handlers.values()).map(h => ({
    type: 'function',
    function: {
      name: h.name,
      description: h.description,
      parameters: h.parameters,
    },
  }));
}

/** 执行工具调用 */
export async function executeToolCalls(
  toolCalls: any[],
  msgs: ChatMessage[],
  sendEvent?: (data: any) => void,
): Promise<{ changed: boolean }> {
  let changed = false;
  for (const tc of toolCalls) {
    if (tc._skipped) continue;
    const fnName = tc.function?.name;
    const handler = handlers.get(fnName);
    if (!handler) {
      console.log(`[工具] 未知工具: ${fnName}`);
      continue;
    }
    const args = typeof tc.function?.arguments === 'string'
      ? JSON.parse(tc.function.arguments)
      : (tc.function?.arguments || {});
    try {
      const result = await handler.handler(args, tc, msgs, sendEvent);
      if (result.changed) changed = true;
    } catch (err: any) {
      console.error(`[工具] ${fnName} 执行失败:`, err);
      msgs.push({ role: 'tool', content: `工具「${fnName}」执行失败: ${err.message}`, tool_call_id: tc.id });
      changed = true;
    }
  }
  return { changed };
}

// ─── 内置工具注册 ──────────────────────────────────────────

// web_search：需用户确认
registerTool({
  name: 'web_search',
  description: '搜索互联网获取实时信息。当用户问的是需要最新数据的问题（新闻、天气、股价、事件等）时使用。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
    },
    required: ['query'],
  },
  handler: async (args, tc, msgs, sendEvent) => {
    // 有 sendEvent（Web UI）→ 需要用户确认；无（飞书）→ 自动批准
    if (sendEvent) {
      const { id, promise } = createApproval(tc);
      sendEvent({ type: 'approval', approvalId: id, query: args.query });
      const approved = await promise;
      if (!approved) {
        msgs.push({ role: 'assistant', content: '', tool_calls: [tc] });
        msgs.push({ role: 'tool', content: `用户取消了搜索「${args.query}」的请求`, tool_call_id: tc.id });
        return { changed: true };
      }
    }
    const results = await webSearch(args.query);
    const content = formatSearchResults(args.query, results);
    msgs.push({ role: 'assistant', content: '', tool_calls: [tc] });
    msgs.push({ role: 'tool', content, tool_call_id: tc.id });
    return { changed: true };
  },
});

// memory_read
registerTool({
  name: 'memory_read',
  description: '读取已保存的记忆。target="memory" 读取环境/项目笔记，target="user" 读取用户画像。',
  parameters: {
    type: 'object',
    properties: {
      target: { type: 'string', enum: ['memory', 'user'], description: '读取哪个记忆库' },
    },
    required: ['target'],
  },
  handler: async (args, tc, msgs) => {
    const result = readMemory(args.target || 'memory');
    const content = result.entries.length > 0
      ? `记忆 (${args.target}):\n${result.entries.join('\n')}\n\n容量: ${result.usage}`
      : `记忆 (${args.target}) 为空`;
    msgs.push({ role: 'assistant', content: '', tool_calls: [tc] });
    msgs.push({ role: 'tool', content, tool_call_id: tc.id });
    return { changed: true };
  },
});

// memory_add
registerTool({
  name: 'memory_add',
  description: '添加一条新的记忆。用户画像存 user，环境/项目信息存 memory。',
  parameters: {
    type: 'object',
    properties: {
      target: { type: 'string', enum: ['memory', 'user'], description: '存入哪个记忆库' },
      content: { type: 'string', description: '记忆内容，简明扼要' },
    },
    required: ['target', 'content'],
  },
  handler: async (args, tc, msgs) => {
    const result = addMemory(args.target || 'memory', args.content || '');
    msgs.push({ role: 'assistant', content: '', tool_calls: [tc] });
    msgs.push({
      role: 'tool',
      content: result.success
        ? `已添加。当前 ${args.target} 记忆: ${result.usage}，共 ${result.entries.length} 条`
        : `添加失败: ${result.error}`,
      tool_call_id: tc.id,
    });
    return { changed: true };
  },
});

// memory_replace
registerTool({
  name: 'memory_replace',
  description: '替换一条已有记忆。通过 old_text 找到匹配的记忆，用 new_content 替换。',
  parameters: {
    type: 'object',
    properties: {
      target: { type: 'string', enum: ['memory', 'user'], description: '哪个记忆库' },
      old_text: { type: 'string', description: '要替换的记忆中包含的文字片段' },
      new_content: { type: 'string', description: '替换后的新内容' },
    },
    required: ['target', 'old_text', 'new_content'],
  },
  handler: async (args, tc, msgs) => {
    const result = replaceMemory(args.target || 'memory', args.old_text || '', args.new_content || '');
    msgs.push({ role: 'assistant', content: '', tool_calls: [tc] });
    msgs.push({
      role: 'tool',
      content: result.success
        ? `已替换。当前 ${args.target} 记忆: ${result.usage}`
        : `替换失败: ${result.error}`,
      tool_call_id: tc.id,
    });
    return { changed: true };
  },
});

// memory_remove
registerTool({
  name: 'memory_remove',
  description: '删除一条记忆。通过 old_text 找到匹配的记忆并删除。',
  parameters: {
    type: 'object',
    properties: {
      target: { type: 'string', enum: ['memory', 'user'], description: '哪个记忆库' },
      old_text: { type: 'string', description: '要删除的记忆中包含的文字片段' },
    },
    required: ['target', 'old_text'],
  },
  handler: async (args, tc, msgs) => {
    const result = removeMemory(args.target || 'memory', args.old_text || '');
    msgs.push({ role: 'assistant', content: '', tool_calls: [tc] });
    msgs.push({
      role: 'tool',
      content: result.success
        ? `已删除。当前 ${args.target} 记忆: ${result.usage}`
        : `删除失败: ${result.error}`,
      tool_call_id: tc.id,
    });
    return { changed: true };
  },
});

// ─── read_url：读取网页内容 ─────────────────────────────────

/** HTML 转纯文本（简易版） */
function htmlToText(html: string): string {
  // 去掉 script/style
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  // 去掉 HTML 标签
  text = text.replace(/<[^>]+>/g, ' ');
  // 解码 HTML 实体
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
  // 合并空白
  text = text.replace(/\s+/g, ' ').trim();
  // 限制长度
  if (text.length > 10000) text = text.slice(0, 10000) + '\n\n…（内容已截断，共 ' + text.length + ' 字）';
  return text;
}

registerTool({
  name: 'read_url',
  description: '读取指定 URL 的网页内容，返回纯文本。适用于用户分享链接、微信公众号文章、新闻等。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要读取的网页 URL' },
    },
    required: ['url'],
  },
  handler: async (args, tc, msgs) => {
    const url = args.url;
    if (!url || typeof url !== 'string') {
      msgs.push({ role: 'assistant', content: '', tool_calls: [tc] });
      msgs.push({ role: 'tool', content: '请提供一个有效的 URL', tool_call_id: tc.id });
      return { changed: true };
    }

    console.log(`[read_url] 读取: ${url}`);
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const html = await res.text();
      const text = htmlToText(html);
      const preview = text.length > 500 ? text.slice(0, 500) + '...' : text;

      const content = `📄 已读取: ${url}\n\n${text}`;
      msgs.push({ role: 'assistant', content: '', tool_calls: [tc] });
      msgs.push({ role: 'tool', content, tool_call_id: tc.id });
      console.log(`[read_url] 成功: ${text.length} 字`);
      return { changed: true };
    } catch (err: any) {
      console.error(`[read_url] 失败:`, err.message);
      msgs.push({ role: 'assistant', content: '', tool_calls: [tc] });
      msgs.push({ role: 'tool', content: `读取网页失败: ${err.message}`, tool_call_id: tc.id });
      return { changed: true };
    }
  },
});

// ─── feishu_doc_create：创建飞书云文档 ──────────────────────────

registerTool({
  name: 'feishu_doc_create',
  description: '创建一个飞书云文档。当用户需要记录、保存、整理内容到飞书文档时使用。支持 Markdown 格式（标题、列表、代码块、分割线等）。',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '文档标题' },
      content: { type: 'string', description: '文档正文，支持 Markdown 格式' },
    },
    required: ['title', 'content'],
  },
  handler: async (args, tc, msgs) => {
    const { title, content } = args;
    if (!title || !content) {
      msgs.push({ role: 'assistant', content: '', tool_calls: [tc] });
      msgs.push({ role: 'tool', content: '请提供文档标题和内容', tool_call_id: tc.id });
      return { changed: true };
    }
    console.log(`[feishu_doc_create] 创建文档: ${title} (${content.length} 字)`);
    const { createFeishuDoc, getLastSenderOpenId } = await import('./feishu.js');
    const openId = getLastSenderOpenId();
    const result = await createFeishuDoc(title, content, openId || undefined);
    msgs.push({ role: 'assistant', content: '', tool_calls: [tc] });
    msgs.push({
      role: 'tool',
      content: result.ok
        ? `✅ 云文档已创建: ${result.url}`
        : `❌ 创建失败: ${result.error}`,
      tool_call_id: tc.id,
    });
    return { changed: true };
  },
});

// ─── cron_create：创建定时提醒 ──────────────────────────

registerTool({
  name: 'cron_create',
  description: '创建一个定时提醒任务。当用户说"提醒我""定时""设个闹钟""到时候叫我"时使用。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '任务名称，例如"出门提醒""吃药提醒"' },
      schedule: { type: 'string', description: '触发时间。格式：HH:MM（如 16:25 表示每天下午4点25分），或数字+单位（如 30m 每30分钟、1h 每小时）' },
      prompt: { type: 'string', description: '触发时要提示的消息内容' },
    },
    required: ['name', 'schedule', 'prompt'],
  },
  handler: async (args, tc, msgs) => {
    const { name, schedule, prompt } = args;
    if (!name || !schedule || !prompt) {
      msgs.push({ role: 'assistant', content: '', tool_calls: [tc] });
      msgs.push({ role: 'tool', content: '请提供任务名称、触发时间和提示消息', tool_call_id: tc.id });
      return { changed: true };
    }
    const { createJob } = await import('./cron.js');
    try {
      const job = createJob(name, schedule, prompt);
      msgs.push({ role: 'assistant', content: '', tool_calls: [tc] });
      msgs.push({ role: 'tool', content: `✅ 定时任务已创建：「${job.name}」在 ${schedule} 触发，消息：${job.prompt}`, tool_call_id: tc.id });
      return { changed: true };
    } catch (err: any) {
      msgs.push({ role: 'assistant', content: '', tool_calls: [tc] });
      msgs.push({ role: 'tool', content: `❌ 创建失败: ${err.message}`, tool_call_id: tc.id });
      return { changed: true };
    }
  },
});

// ─── xlsx_edit：编辑 Excel 文件 ──────────────────────────

/** 当前微信文件路径（由 wechat.ts 在调用 LLM 前设置） */
let currentXlsxPath: string | null = null;

export function setCurrentXlsxPath(p: string | null) {
  currentXlsxPath = p;
}

export function getCurrentXlsxPath(): string | null {
  return currentXlsxPath;
}

/** 获取当前 Excel 的摘要（表头+行数），用于跨轮注入上下文
 *  大文件安全：只读前几行，不加载全量数据 */
export function getCurrentXlsxSummary(): string | null {
  if (!currentXlsxPath) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const XLSX = require('xlsx');
    const buf = fs.readFileSync(currentXlsxPath);
    const wb = XLSX.read(buf, { type: 'buffer' });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return null;
    const ws = wb.Sheets[sheetName];
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
    const totalRows = range.e.r - range.s.r + 1;
    const dataRows = totalRows - 1; // 减表头
    // 只读表头 + 前3行预览（大文件安全）
    const previewEnd = Math.min(range.s.r + 3, range.e.r);
    const previewRange = { s: range.s, e: { r: previewEnd, c: range.e.c } };
    const data: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', range: previewRange });
    if (data.length === 0) return null;
    const headers = data[0].map((h: any) => String(h));
    const sampleRows = data.slice(1).map(row => row.map(c => String(c ?? '')).join(', ')).join('\n');
    return `📊 当前已加载 Excel 文件，表头：[${headers.join(', ')}]，共 ${dataRows} 行数据。\n前几行预览：\n${sampleRows}\n\n（你可以用 xlsx_edit 工具编辑此文件：删列、清空列、改单元格、加列）`;
  } catch {
    return null;
  }
}

/** 生成修改后的文件路径 */
function getModifiedXlsxPath(originalPath: string): string {
  const dir = path.dirname(originalPath);  // need path import
  const name = path.basename(originalPath, path.extname(originalPath));
  return path.join(dir, `${name}_modified_${Date.now()}.xlsx`);
}

registerTool({
  name: 'xlsx_edit',
  description: '编辑当前收到的 Excel 文件。支持操作：modify_cell(修改或写入任意单元格，按行号+列名定位)、clear_column(清除某列)、delete_column(删除某列)、add_column(添加新列)。modify_cell 可写入任意行（包括现有数据下方的新行），用 row 指定行号（1=第一行数据），column 指定列名，new_value 指定新值。操作后会自动生成修改后的文件并发送给用户。',
  parameters: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: ['clear_column', 'delete_column', 'add_column', 'modify_cell'], description: '操作类型' },
      column: { type: 'string', description: '列名（如"数量"）或列字母（如"A"）' },
      new_value: { type: 'string', description: 'modify_cell 时的新值' },
      row: { type: 'number', description: 'modify_cell 时的行号（从1开始）' },
      new_column_name: { type: 'string', description: 'add_column 时的列名' },
      new_column_value: { type: 'string', description: 'add_column 时填充的值（可选）' },
    },
    required: ['operation'],
  },
  handler: async (args, tc, msgs) => {
    if (!currentXlsxPath) {
      msgs.push({ role: 'assistant', content: '', tool_calls: [tc] });
      msgs.push({ role: 'tool', content: '当前没有可编辑的 Excel 文件', tool_call_id: tc.id });
      return { changed: true };
    }
    try {
      const XLSX = await import('xlsx');
      const buf = fs.readFileSync(currentXlsxPath);
      const wb = XLSX.read(buf, { type: 'buffer' });
      const sheetName = wb.SheetNames[0];
      if (!sheetName) throw new Error('Excel 文件没有工作表');
      const ws = wb.Sheets[sheetName];
      // 保存原始数据起始位置（sheet_to_json 会压缩，写回时需恢复）
      const origRange = XLSX.utils.decode_range(ws['!ref'] || 'A1');
      const origRow = origRange.s.r;
      const origCol = origRange.s.c;
      const data: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      
      if (data.length === 0) throw new Error('工作表为空');
      
      const headers: string[] = data[0].map(h => String(h));
      console.log(`[xlsx_edit] 表头: ${headers.join(', ')}, 数据行: ${data.length - 1}`);
      
      const op = args.operation;
      let resultMsg = '';
      
      if (op === 'clear_column' || op === 'delete_column') {
        const colName = args.column;
        if (!colName) throw new Error('请指定列名');
        const colIdx = findColumnIndex(headers, colName);
        if (colIdx < 0) throw new Error(`未找到列「${colName}」，可用列: ${headers.join(', ')}`);
        
        if (op === 'clear_column') {
          let count = 0;
          for (let r = 1; r < data.length; r++) {
            if (data[r][colIdx] !== '' && data[r][colIdx] != null) {
              data[r][colIdx] = '';
              count++;
            }
          }
          resultMsg = `✅ 已清除「${headers[colIdx]}」列中的 ${count} 个单元格`;
        } else {
          // delete_column
          for (let r = 0; r < data.length; r++) {
            data[r].splice(colIdx, 1);
          }
          resultMsg = `✅ 已删除「${headers[colIdx]}」列`;
        }
      } else if (op === 'modify_cell') {
        const { column, row, new_value } = args;
        if (!column) throw new Error('请指定列名');
        if (!row || row < 1) throw new Error('请指定行号（从1开始）');
        const colIdx = findColumnIndex(headers, column);
        if (colIdx < 0) throw new Error(`未找到列「${column}」`);
        if (row >= data.length) {
          // 扩展行数以容纳目标行
          while (data.length <= row) data.push([]);
        }
        const oldVal = data[row]?.[colIdx] ?? '(空)';
        data[row][colIdx] = new_value ?? '';
        resultMsg = `✅ 已将第 ${row} 行「${headers[colIdx]}」列从「${oldVal}」改为「${new_value}」`;
      } else if (op === 'add_column') {
        const { new_column_name, new_column_value } = args;
        if (!new_column_name) throw new Error('请指定新列名');
        for (let r = 0; r < data.length; r++) {
          data[r].push(r === 0 ? new_column_name : (new_column_value ?? ''));
        }
        resultMsg = `✅ 已添加新列「${new_column_name}」`;
      }
      
      // 写回新文件，保留原始位置
      const newWs: any = {};
      XLSX.utils.sheet_add_aoa(newWs, data, { origin: { r: origRow, c: origCol } });
      wb.Sheets[sheetName] = newWs;
      const newPath = getModifiedXlsxPath(currentXlsxPath);
      const newBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      fs.writeFileSync(newPath, newBuf);
      console.log(`[xlsx_edit] 修改后文件: ${newPath} (${newBuf.length} bytes)`);
      
      msgs.push({ role: 'assistant', content: '', tool_calls: [tc] });
      // 把文件路径编码到结果中，让调用方知道要发送文件
      msgs.push({ role: 'tool', content: `${resultMsg}\n__FILE__${newPath}`, tool_call_id: tc.id });
      return { changed: true };
    } catch (err: any) {
      console.error('[xlsx_edit] 失败:', err.message);
      msgs.push({ role: 'assistant', content: '', tool_calls: [tc] });
      msgs.push({ role: 'tool', content: `❌ 编辑失败: ${err.message}`, tool_call_id: tc.id });
      return { changed: true };
    }
  },
});

/** 根据列名或列字母找列索引 */
function findColumnIndex(headers: string[], colName: string): number {
  // 用列字母（A、B、C...）
  if (/^[A-Z]+$/i.test(colName)) {
    const idx = colName.toUpperCase().charCodeAt(0) - 65;
    if (idx >= 0 && idx < headers.length) return idx;
  }
  // 用列名匹配
  const lower = colName.toLowerCase();
  const exact = headers.findIndex(h => h.toLowerCase() === lower);
  if (exact >= 0) return exact;
  // 模糊匹配
  const fuzzy = headers.findIndex(h => h.toLowerCase().includes(lower));
  if (fuzzy >= 0) return fuzzy;
  return -1;
}

// ─── session_search：搜索历史对话 ──────────────────────────

registerTool({
  name: 'session_search',
  description: '搜索过去的对话历史。当用户提到之前聊过的内容、问"我们之前讨论过什么"、或需要回顾上下文时使用。关键词搜索所有会话文件。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词（支持多词 OR 搜索，如"天气 OR 记忆"）' },
      max_results: { type: 'integer', description: '最多返回条数，默认5', default: 5 },
    },
    required: ['query'],
  },
  handler: async (args, tc, msgs) => {
    const query = args.query || '';
    const maxResults = args.max_results || 5;
    const result = searchAllSessions(query, maxResults);
    msgs.push({ role: 'assistant', content: '', tool_calls: [tc] });
    msgs.push({
      role: 'tool',
      content: result || '未找到匹配的对话。',
      tool_call_id: tc.id,
    });
    return { changed: true };
  },
});
