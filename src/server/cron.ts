import fs from 'fs';
import path from 'path';

const CRON_DIR = path.resolve(process.cwd(), 'cron');
if (!fs.existsSync(CRON_DIR)) fs.mkdirSync(CRON_DIR, { recursive: true });

export interface CronJob {
  id: string;
  name: string;
  schedule: string;        // "30m", "2h", "1d", "08:00", "0 9 * * *"
  prompt: string;           // 触发时要发的消息
  enabled: boolean;
  lastRun: number | null;   // timestamp
  nextRun: number | null;   // timestamp
  createdAt: number;
  updatedAt: number;
}

// ─── 调度解析 ──────────────────────────────────────────────────

/** 解析 schedule 字符串，返回下次触发时间戳（ms） */
function parseNextRun(schedule: string, after: number = Date.now()): number | null {
  // 间隔格式：30m, 2h, 1d
  const intervalMatch = schedule.match(/^(\d+)\s*(m|h|d)$/);
  if (intervalMatch) {
    const num = parseInt(intervalMatch[1], 10);
    const unit = intervalMatch[2];
    const ms = unit === 'm' ? num * 60 * 1000
              : unit === 'h' ? num * 3600 * 1000
              : num * 86400 * 1000;
    return after + ms;
  }

  // 固定时间：08:00 → 每天该时间
  const timeMatch = schedule.match(/^(\d{2}):(\d{2})$/);
  if (timeMatch) {
    const h = parseInt(timeMatch[1], 10);
    const m = parseInt(timeMatch[2], 10);
    const now = new Date(after);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
    if (today.getTime() > after) return today.getTime();
    // 今天已过，明天
    return today.getTime() + 86400000;
  }

  // 简单 cron 表达式：minute hour day month dayOfWeek（5字段，空格分隔）
  const cronMatch = schedule.match(/^(\d{1,2}|\*)\s+(\d{1,2}|\*)\s+(\d{1,2}|\*)\s+(\d{1,2}|\*)\s+(\d{1,2}|\*)$/);
  if (cronMatch) {
    return parseCron(cronMatch[1], cronMatch[2], cronMatch[3], cronMatch[4], cronMatch[5], after);
  }

  return null;
}

function parseCron(minute: string, hour: string, day: string, month: string, _dow: string, after: number): number | null {
  // 简化实现：仅支持 daily/hourly 模式
  const minVal = minute === '*' ? undefined : parseInt(minute, 10);
  const hourVal = hour === '*' ? undefined : parseInt(hour, 10);
  const dayVal = day === '*' ? undefined : parseInt(day, 10);
  const monthVal = month === '*' ? undefined : parseInt(month, 10);

  let date = new Date(after);

  // 尝试最多 366 天
  for (let i = 0; i <= 366; i++) {
    const d = new Date(date.getTime() + i * 60000); // 每分钟步进
    if (monthVal !== undefined && (d.getMonth() + 1) !== monthVal) continue;
    if (dayVal !== undefined && d.getDate() !== dayVal) continue;
    if (hourVal !== undefined && d.getHours() !== hourVal) continue;
    if (minVal !== undefined && d.getMinutes() !== minVal) continue;
    if (d.getTime() > after) return d.getTime();
  }

  return null;
}

// ─── 持久化 ──────────────────────────────────────────────────

function jobPath(id: string): string {
  const safeId = id.replace(/[/\\?%*:|"<>.]/g, '_');
  return path.join(CRON_DIR, `${safeId}.json`);
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function saveJob(job: CronJob): void {
  fs.writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2), 'utf-8');
}

function loadJob(id: string): CronJob | null {
  const p = jobPath(id);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch { return null; }
}

// ─── 公有 API ──────────────────────────────────────────────────

export function listJobs(): CronJob[] {
  const files = fs.readdirSync(CRON_DIR).filter(f => f.endsWith('.json'));
  return files.map(f => {
    try {
      return JSON.parse(fs.readFileSync(path.join(CRON_DIR, f), 'utf-8')) as CronJob;
    } catch { return null; }
  }).filter(Boolean) as CronJob[];
}

export function getJob(id: string): CronJob | null {
  return loadJob(id);
}

export function createJob(name: string, schedule: string, prompt: string): CronJob {
  const id = generateId();
  const now = Date.now();
  const job: CronJob = {
    id,
    name,
    schedule,
    prompt,
    enabled: true,
    lastRun: null,
    nextRun: parseNextRun(schedule),
    createdAt: now,
    updatedAt: now,
  };
  saveJob(job);
  return job;
}

export function updateJob(id: string, updates: Partial<Pick<CronJob, 'name' | 'schedule' | 'prompt' | 'enabled'>>): CronJob | null {
  const job = loadJob(id);
  if (!job) return null;
  if (updates.name !== undefined) job.name = updates.name;
  if (updates.schedule !== undefined) {
    job.schedule = updates.schedule;
    job.nextRun = parseNextRun(job.schedule);
  }
  if (updates.prompt !== undefined) job.prompt = updates.prompt;
  if (updates.enabled !== undefined) job.enabled = updates.enabled;
  job.updatedAt = Date.now();
  saveJob(job);
  return job;
}

export function deleteJob(id: string): boolean {
  const p = jobPath(id);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

/** 标记任务已执行，更新下次触发时间 */
export function markRun(id: string): CronJob | null {
  const job = loadJob(id);
  if (!job) return null;
  job.lastRun = Date.now();
  job.nextRun = parseNextRun(job.schedule);
  job.updatedAt = Date.now();
  saveJob(job);
  return job;
}

// ─── 调度循环 ──────────────────────────────────────────────────

type CronHandler = (job: CronJob) => void | Promise<void>;

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let onTrigger: CronHandler | null = null;

export function setCronHandler(handler: CronHandler) {
  onTrigger = handler;
}

/** 启动调度器（每 30 秒检查一次） */
export function startScheduler() {
  if (schedulerTimer) return;
  console.log('[Cron] 调度器已启动（每30秒检查）');
  schedulerTimer = setInterval(async () => {
    const now = Date.now();
    const jobs = listJobs().filter(j => j.enabled && j.nextRun && j.nextRun <= now);
    for (const job of jobs) {
      console.log(`[Cron] 触发任务: ${job.name} (${job.id})`);
      if (onTrigger) {
        try { await onTrigger(job); } catch (e) { console.error('[Cron] 触发失败:', e); }
      }
      markRun(job.id);
      console.log(`[Cron] 通知已发送: ${job.name}`);
    }
  }, 30000);
}

export function stopScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}
