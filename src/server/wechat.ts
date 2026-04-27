/**
 * WeChat 通道：基于 wx-clawbot (OpenClaw 协议)
 */
import { WechatBot, Message } from 'wx-clawbot';
import fs from 'fs';
import path from 'path';
import { readPdfText, readDocxText, readTextFile, readXlsxText } from './feishu.js';
import { removeMemory } from './memory.js';
import { setCurrentXlsxPath } from './tools.js';

const CONFIG_PATH = path.resolve(process.cwd(), 'wechat-config.json');

// 简单 JSON 文件存储（替代 conf 包）
const fileStore = {
  data: loadData(),
  get<T>(key: string): T | undefined {
    return this.data[key] as T | undefined;
  },
  set(key: string, value: any) {
    this.data[key] = value;
    saveData(this.data);
  },
  delete(key: string) {
    delete this.data[key];
    saveData(this.data);
  },
};

function loadData(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveData(data: Record<string, any>) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

let bot: any = null;
let onMessage: ((text: string, images: string[] | undefined, reply: (text: string, filePath?: string | null) => void) => void) | null = null;
let onQrcode: ((qrUrl: string) => void) | null = null;
let onConnected: ((connected: boolean, accountId?: string) => void) | null = null;

export function setWechatMessageHandler(
  handler: (text: string, images: string[] | undefined, reply: (text: string, filePath?: string | null) => void) => void
) {
  onMessage = handler;
}

// 已连接的微信聊天（用于定时任务推送）
const wechatContacts: any[] = [];
let lastWechatMsg: any = null;  // 兜底：最新收到的消息对象
export async function sendToWechat(text: string): Promise<void> {
  if (wechatContacts.length === 0 && lastWechatMsg) {
    try { await lastWechatMsg.sendText(`⏰ ${text}`); } catch {}
    return;
  }
  const promises = [];
  for (const contact of wechatContacts) {
    promises.push(contact.sendText(`⏰ ${text}`).catch(() => {}));
  }
  await Promise.all(promises);
}

export function setQrcodeHandler(handler: (qrUrl: string) => void) {
  onQrcode = handler;
}

export function setWechatStatusHandler(handler: (connected: boolean, accountId?: string) => void) {
  onConnected = handler;
}

export function getWechatStatus(): { connected: boolean; accountId?: string } {
  return { connected: !!(bot?.connected), accountId: bot?.accountId };
}

/** 启动微信机器人 */
export async function startWechat() {
  if (bot) {
    console.log('[微信] 机器人已在运行');
    return;
  }

  const WechatBotClass = WechatBot as any;
  bot = new WechatBotClass({ store: fileStore });

  bot.on('scan', ({ url }: { url: string }) => {
    console.log(`[微信] 扫码登录: ${url}`);
    if (onQrcode) onQrcode(url);
  });

  bot.on('scaned', () => {
    console.log('[微信] 已扫码，等待确认...');
  });

  bot.on('login', (data: any) => {
    if (data.status === 'success') {
      console.log(`[微信] 登录成功: ${data.userId}`);
      if (onConnected) onConnected(true, data.userId);
    } else {
      console.error('[微信] 登录失败');
      if (onConnected) onConnected(false);
    }
  });

  bot.on('logout', () => {
    console.log('[微信] 已登出');
    if (onConnected) onConnected(false);
  });

  bot.on('connected', () => {
    console.log('[微信] 连接已建立，等待消息...');
    if (onConnected) onConnected(true, bot?.accountId);
  });

  bot.on('error', (err: Error) => {
    console.error('[微信] 错误:', err.message);
  });

  bot.on('message', async (msg: any) => {
    lastWechatMsg = msg;  // 保存最新消息对象，供定时任务兜底
    const text = msg.text;
    const hasMedia = msg.hasMedia;
    if (!text && !hasMedia) return;

    // 下载媒体（图片/文件）
    let images: string[] | undefined;
    let fileText: string | undefined;
    let hadFile = false;
    let finalXlsxPath: string | null = null;
    if (hasMedia) {
      try {
        const media = await msg.downloadMedia();
        if (!media) { /* 跳过 */ }
        else if (media.type === 'image' && media.buffer) {
          images = [media.buffer.toString('base64')];
          console.log(`[微信] 收到图片 (${media.buffer.length} bytes)`);
        } else if (media.type === 'file' && media.buffer) {
          hadFile = true;
          const rawName = media.filename || 'unknown';
          let ext = path.extname(rawName).toLowerCase();
          console.log(`[微信] 收到文件: rawName="${rawName}" ext="${ext}" size=${media.buffer.length} contentType=${media.contentType}`);
          // 兜底：用 content-type 推断扩展名
          if (!ext && media.contentType) {
            const mimeMap: Record<string, string> = {
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
              'application/vnd.ms-excel': '.xls',
              'application/pdf': '.pdf',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
              'application/msword': '.doc',
              'text/plain': '.txt',
              'text/csv': '.csv',
            };
            for (const [mime, e] of Object.entries(mimeMap)) {
              if (media.contentType.includes(mime)) { ext = e; break; }
            }
            console.log(`[微信] 从 MIME 推断扩展名: "${ext}"`);
          }
          // 保存临时文件
          const tmpDir = path.resolve(process.cwd(), 'wechat_uploads');
          if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
          const tmpPath = path.join(tmpDir, `${Date.now()}_${media.filename}`);
          fs.writeFileSync(tmpPath, media.buffer);
          try {
            if (ext === '.pdf') {
              fileText = await readPdfText(tmpPath);
            } else if (ext === '.docx') {
              fileText = await readDocxText(tmpPath);
            } else if (ext === '.txt' || ext === '.md' || ext === '.json' || ext === '.csv' || ext === '.log') {
              fileText = readTextFile(tmpPath);
            } else if (ext === '.xlsx' || ext === '.xls') {
              fileText = await readXlsxText(tmpPath);
              finalXlsxPath = tmpPath; // 保留文件，给 xlsx_edit 用
            } else {
              fileText = `⚠️ 收到了文件「${media.filename}」(${ext})，暂不支持解析该格式。`;
              try { fs.unlinkSync(tmpPath); } catch {}
            }
          } finally {
            if (!finalXlsxPath) try { fs.unlinkSync(tmpPath); } catch {}
          }
        }
      } catch (err) {
        console.error('[微信] 下载媒体失败:', err);
      }
    }

    // 合并文本内容：文件提取文本 + 用户消息
    let finalText = text || '';
    if (fileText) {
      finalText = fileText.startsWith('⚠️')
        ? fileText
        : `用户发送了文件「${text || '无描述'}」，内容如下：\n\n${fileText}`;
    }
    console.log(`[微信] 收到消息: ${finalText.slice(0, 80)}${finalText.length > 80 ? '...' : ''}`);

    // 记录联系人，用于定时任务推送（talker() 可能不存在，安全处理）
    try {
      const talker = msg.talker?.();
      if (talker && !wechatContacts.includes(talker)) {
        wechatContacts.push(talker);
      }
    } catch {}

    // 显示"正在输入..."（非阻塞，不影响回复）
    msg.sendTyping().catch(() => {});

    if (onMessage) {
      // 如果是 Excel 文件，设置路径（供后续消息使用）
      if (fileText && !fileText.startsWith('⚠️') && hadFile && finalXlsxPath) {
        setCurrentXlsxPath(finalXlsxPath);
        console.log('[微信] Excel路径已设置:', finalXlsxPath);
      }
      onMessage(finalText || '', images, async (replyText: string, filePath?: string | null) => {
        try {
          msg.stopTyping().catch(() => {});
          if (filePath) {
            await msg.sendFile(filePath);
            console.log(`[微信] 已发送文件: ${filePath}`);
            setCurrentXlsxPath(null);
            try { removeMemory('memory', '当前Excel文件'); } catch {}
          } else {
            await msg.sendText(replyText);
            console.log(`[微信] 已回复: ${replyText.slice(0, 50)}...`);
          }
        } catch (err) {
          console.error('[微信] 发送失败:', err);
        }
      });
    } else {
      try {
        try { await msg.stopTyping(); } catch {}
        await msg.sendText('你好，我是 Small Hermes');
      } catch {}
    }
  });

  try {
    bot.ensureLogin();
    bot.runServer();
  } catch (err) {
    console.error('[微信] 启动失败:', err);
    bot = null;
    throw err;
  }
}

export function stopWechat() {
  if (bot) {
    try { bot.close?.(); } catch {}
    bot = null;
    console.log('[微信] 已停止');
  }
}

// 进程退出时自动清理（防止僵尸端口）
process.on('exit', () => { try { bot?.close?.(); } catch {} });
process.on('SIGTERM', () => { stopWechat(); process.exit(); });
process.on('SIGINT', () => { stopWechat(); process.exit(); });

/** 重置微信登录（清空 token + 停止 + 重启扫码） */
export async function resetWechat(): Promise<void> {
  stopWechat();
  // 清空持久化的登录态
  fileStore.delete('botToken');
  fileStore.delete('accountId');
  fileStore.delete('userId');
  fileStore.delete('contextToken');
  fileStore.delete('userEntry');
  fileStore.delete('baseUrl');
  console.log('[微信] 登录态已清空');
  // 重新启动（触发扫码）
  await startWechat();
}
