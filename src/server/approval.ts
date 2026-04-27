/**
 * 权限控制系统：联网搜索等需用户确认的操作
 */
import crypto from 'crypto';

interface PendingApproval {
  id: string;
  toolCall: any;
  query: string;
  resolve: (approved: boolean) => void;
  timestamp: number;
  resolved: boolean;
}

const pendingMap = new Map<string, PendingApproval>();
const TIMEOUT_MS = 120_000; // 2 分钟超时

/** 创建一个待确认请求，返回 { id, promise } */
export function createApproval(toolCall: any): { id: string; promise: Promise<boolean> } {
  const id = crypto.randomUUID().slice(0, 8);
  let resolve: (approved: boolean) => void = () => {};

  const promise = new Promise<boolean>((res) => {
    resolve = res;
  });

  const args = typeof toolCall.function?.arguments === 'string'
    ? JSON.parse(toolCall.function.arguments)
    : (toolCall.function?.arguments || {});

  pendingMap.set(id, {
    id,
    toolCall,
    query: args.query || '',
    resolve,
    timestamp: Date.now(),
    resolved: false,
  });

  // 超时自动拒绝
  setTimeout(() => {
    const entry = pendingMap.get(id);
    if (entry && !entry.resolved) {
      entry.resolved = true;
      entry.resolve(false);
      pendingMap.delete(id);
    }
  }, TIMEOUT_MS);

  return { id, promise };
}

/** 处理用户确认/拒绝 */
export function resolveApproval(id: string, approved: boolean): boolean {
  const entry = pendingMap.get(id);
  if (!entry || entry.resolved) return false;
  entry.resolved = true;
  entry.resolve(approved);
  pendingMap.delete(id);
  return true;
}
