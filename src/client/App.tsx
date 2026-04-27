import { useState, useRef, useEffect, useCallback } from 'react';
import QRCode from 'qrcode';
import LoginPage from './LoginPage';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  images?: string[];  // 图片 base64（只在 API 请求用，不进 localStorage）
  thinking?: string;
  stats?: { tokens: number; tps: number };
  done?: boolean;
  time?: number;  // 消息时间戳（毫秒）
  toolCalls?: { name: string; args: any; needsApproval?: boolean; approvalId?: string }[];  // 工具调用列表
}

interface Conversation {
  id: string;
  title: string;
  messages: Message[];
}

interface OllamaModel {
  name: string;
  size: number;
  modified: string;
}

const VERSION = '0.1.0';

// ─── 图标 ───
function IconModel() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
    </svg>
  );
}
function IconFeishu() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
function IconAbout() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}
function IconSearch() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}
function IconRestart() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}
function IconSpeed() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
      <circle cx="12" cy="12" r="4" />
    </svg>
  );
}
function IconAttach() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}
function ThinkingIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="4" />
    </svg>
  );
}

// ─── 应用图标 ───
function AppIcon({ size = 32 }: { size?: number }) {
  return (
    <img src="/favicon.jpg" width={size} height={size} alt="Small Hermes" style={{
      borderRadius: size * 0.2, display: 'block',
    }} />
  );
}

// ─── 工具名称映射 ───
function getToolDisplay(name: string): { icon: string; label: string; color: string } {
  const map: Record<string, { icon: string; label: string; color: string }> = {
    web_search:       { icon: '🔍', label: '联网搜索',     color: '#5b9bd5' },
    memory_read:      { icon: '📖', label: '读取记忆',     color: '#9b59b6' },
    memory_add:       { icon: '💾', label: '保存记忆',     color: '#27ae60' },
    memory_replace:   { icon: '🔄', label: '更新记忆',     color: '#e67e22' },
    memory_remove:    { icon: '🗑️', label: '删除记忆',     color: '#e74c3c' },
    read_url:         { icon: '📄', label: '读取网页',     color: '#1abc9c' },
    feishu_doc_create:{ icon: '📝', label: '创建飞书文档', color: '#3498db' },
  };
  return map[name] || { icon: '🔧', label: name, color: '#888' };
}

// ─── 复制到剪贴板 ───
function copyCode(text: string) {
  navigator.clipboard.writeText(text).catch(() => {});
}

// ─── 消息内容渲染（代码块高亮） ───
function MessageContent({ content }: { content: string }) {
  if (!content) return null;

  // 按 ``` 分割，解析代码块
  const parts: { type: 'code' | 'text'; content: string; lang?: string }[] = [];
  let remaining = content;
  const codeBlockRe = /^```(\w*)\n?([\s\S]*?)```/m;

  while (remaining.length > 0) {
    const match = remaining.match(codeBlockRe);
    if (match) {
      const before = remaining.slice(0, match.index);
      if (before) parts.push({ type: 'text', content: before });

      const lang = match[1] || '';
      const code = match[2].replace(/\n$/, '');
      parts.push({ type: 'code', content: code, lang });

      remaining = remaining.slice(match.index! + match[0].length);
    } else {
      parts.push({ type: 'text', content: remaining });
      break;
    }
  }

  return (
    <>
      {parts.map((part, i) => {
        if (part.type === 'code') {
          return (
            <div className="code-block" key={i}>
              <div className="code-block-header">
                <span className="code-block-lang">{part.lang || 'code'}</span>
                <button className="code-block-copy" onClick={() => copyCode(part.content)}>
                  复制
                </button>
              </div>
              <pre><code>{part.content}</code></pre>
            </div>
          );
        }
        // 文本段：渲染内联代码和普通文字
        return <InlineText key={i} text={part.content} />;
      })}
    </>
  );
}

// ─── 内联文字（支持 `code` 高亮） ───
function InlineText({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('`') && part.endsWith('`')) {
          return <code className="inline-code" key={i}>{part.slice(1, -1)}</code>;
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

// ─── 弹窗 ───
function Modal({ title, onClose, children, width }: { title: string; onClose: () => void; children: React.ReactNode; width?: number }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={width ? { width, maxWidth: '90vw' } : {}} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

// ─── 生成 ID ───
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ─── 从 localStorage 加载会话 ───
function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem('hermes-convs');
    if (raw) return JSON.parse(raw);
  } catch {}
  return [{ id: genId(), title: '新对话', messages: [] }];
}

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>(loadConversations);
  const [activeId, setActiveId] = useState(() => conversations[0]?.id || '');
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState(() => localStorage.getItem('hermes-model') || 'gemma4:26b');
  const [models, setModels] = useState<OllamaModel[]>([]);

  const [feishuId, setFeishuId] = useState('');
  const [feishuSecret, setFeishuSecret] = useState('');
  const [feishuStatus, setFeishuStatus] = useState('');

  const [showModel, setShowModel] = useState(false);
  const [showFeishu, setShowFeishu] = useState(false);
  const [showTavily, setShowTavily] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [modelChanged, setModelChanged] = useState(false);
  const [tavilyKey, setTavilyKey] = useState('');
  const [tavilyStatus, setTavilyStatus] = useState('');
  const [showRestart, setShowRestart] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [showBenchmark, setShowBenchmark] = useState(false);
  const [benchmarkRunning, setBenchmarkRunning] = useState(false);
  const [benchmarkResults, setBenchmarkResults] = useState<any[]>([]);
  const [benchmarkError, setBenchmarkError] = useState('');

  // ─── 微信连接状态 ───
  const [showWechat, setShowWechat] = useState(false);
  const [wechatStatus, setWechatStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [wechatQRUrl, setWechatQRUrl] = useState('');
  const [wechatError, setWechatError] = useState('');

  // ─── 登录状态 ───
  const [isLoggedIn, setLoggedIn] = useState(() => !!localStorage.getItem('hermes-user'));
  const [username, setUsername] = useState(() => localStorage.getItem('hermes-user') || '');
  const [userAvatar, setUserAvatar] = useState(() => localStorage.getItem('hermes-avatar') || '🐱');

  // ─── 主题切换 ───
  const [theme, setTheme] = useState(() => localStorage.getItem('hermes-theme') || 'dark');
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('hermes-theme', theme);
  }, [theme]);
  const toggleTheme = () => setTheme(prev => prev === 'dark' ? 'light' : 'dark');

  // ─── 设置下拉菜单 ───
  const [showSettings, setShowSettings] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const [thinkingOpen, setThinkingOpen] = useState(() => localStorage.getItem('hermes-thinking-open') !== 'false');
  useEffect(() => {
    localStorage.setItem('hermes-thinking-open', String(thinkingOpen));
  }, [thinkingOpen]);
  useEffect(() => {
    if (!showSettings) return;
    const handler = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setShowSettings(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSettings]);

  const handleLogin = (name: string, avatar: string) => {
    localStorage.setItem('hermes-user', name);
    localStorage.setItem('hermes-avatar', avatar);
    setUsername(name);
    setUserAvatar(avatar);
    setLoggedIn(true);
  };

  // ─── 技能管理状态 ───
  const [showSkills, setShowSkills] = useState(false);
  const [skillsList, setSkillsList] = useState<any[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [editingSkill, setEditingSkill] = useState<any | undefined>(undefined); // undefined = 列表, null = 新建, object = 编辑
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editBody, setEditBody] = useState('');

  // ─── 定时任务状态 ───
  const [showCron, setShowCron] = useState(false);
  const [cronList, setCronList] = useState<any[]>([]);
  const [cronLoading, setCronLoading] = useState(false);
  const [cronEditing, setCronEditing] = useState<any | undefined>(undefined);
  const [cronDeleteTarget, setCronDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [cronName, setCronName] = useState('');
  const [cronSchedule, setCronSchedule] = useState('');
  const [cronPrompt, setCronPrompt] = useState('');
  const [cronTriggers, setCronTriggers] = useState<any[]>([]);

  // ─── 权限确认状态 ───
  const [pendingApproval, setPendingApproval] = useState<{ approvalId: string; query: string } | null>(null);
  const [approvalTimeout, setApprovalTimeout] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    return parseInt(localStorage.getItem('hermes-sidebar-width') || '240', 10);
  });
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const thinkingContainerRef = useRef<HTMLDivElement | null>(null);

  const activeConv = conversations.find((c) => c.id === activeId) || conversations[0];
  const messages = activeConv?.messages || [];

  // 持久化会话（只存无图片的消息，避免大 base64 撑爆 localStorage）
  useEffect(() => {
    const storageData = conversations.map(c => ({
      ...c,
      messages: c.messages.map(({ images, ...rest }) => rest), // 去掉图片字段
    }));
    localStorage.setItem('hermes-convs', JSON.stringify(storageData));
  }, [conversations]);

  // 拉取本地模型列表
  useEffect(() => {
    fetch('/api/models').then(r => r.json()).then(data => {
      if (data.models?.length) {
        setModels(data.models);
        if (!data.models.find((m: OllamaModel) => m.name === model)) {
          setModel(data.models[0].name);
          localStorage.setItem('hermes-model', data.models[0].name);
        }
      }
    }).catch(() => {});
  }, []);

  // 读取飞书配置
  useEffect(() => {
    fetch('/api/config/feishu').then(r => r.json()).then(data => {
      if (data.appId) setFeishuId(data.appId);
    }).catch(() => {});
  }, []);

  // 监听飞书实时消息
  useEffect(() => {
    const ev = new EventSource('/api/events');
    ev.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'feishu_user' || data.type === 'feishu_assistant') {
          const role = data.type === 'feishu_user' ? 'user' : 'assistant';
          const msg: Message = { role, content: data.content };
          setConversations((prev) => {
            let conv = prev.find((c) => c.id === 'feishu');
            if (!conv) {
              conv = { id: 'feishu', title: '📱 飞书消息', messages: [] };
              return [{ ...conv, messages: [msg] }, ...prev];
            }
            return prev.map((c) =>
              c.id === 'feishu' ? { ...c, messages: [...c.messages, msg] } : c
            );
          });
        } else if (data.type === 'cron_message') {
          // 定时提醒：显示在聊天中
          setConversations((prev) => {
            let conv = prev.find((c) => c.id === 'cron');
            if (!conv) {
              conv = { id: 'cron', title: '⏰ 定时提醒', messages: [] };
              return [{ ...conv, messages: [{ role: 'assistant', content: data.message, time: Date.now() }] }, ...prev];
            }
            return prev.map((c) =>
              c.id === 'cron' ? { ...c, messages: [...c.messages, { role: 'assistant', content: data.message, time: Date.now() }] } : c
            );
          });
          // 也记录到旧版弹窗触发记录
          setCronTriggers((prev) => {
            const next = [{ jobName: data.jobName, prompt: data.prompt, time: Date.now() }, ...prev];
            return next.slice(0, 50);
          });
        } else if (data.type === 'wechat_qrcode') {
          setWechatQRUrl(data.url);
          setWechatStatus('connecting');
        } else if (data.type === 'wechat_status') {
          if (data.connected) {
            setWechatStatus('connected');
            setWechatQRUrl('');
          } else {
            setWechatStatus('idle');
          }
        }
      } catch {}
    };
    return () => ev.close();
  }, []);
  // 滚动到底部
  useEffect(() => {
    if (userScrolledUp.current) return;
    chatEndRef.current?.scrollIntoView({ behavior: loading ? 'auto' : 'smooth' });
  }, [messages, loading]);

  // 用户滚动时检测是否主动上拉了
  useEffect(() => {
    const el = chatContainerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      userScrolledUp.current = distFromBottom > 80;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // 新消息时恢复自动滚动
  useEffect(() => {
    if (!loading) userScrolledUp.current = false;
  }, [loading]);

  // 推理过程自动滚到底
  useEffect(() => {
    if (!loading || !thinkingContainerRef.current) return;
    thinkingContainerRef.current.scrollTop = thinkingContainerRef.current.scrollHeight;
  }, [messages, loading]);

  // 点击外部关闭菜单
  useEffect(() => {
    if (!openMenuId) return;
    const handler = () => setOpenMenuId(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [openMenuId]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
  };

  const updateConvMessages = useCallback((convId: string, updater: (prev: Message[]) => Message[]) => {
    setConversations((prev) =>
      prev.map((c) => (c.id === convId ? { ...c, messages: updater(c.messages) } : c))
    );
  }, []);

  // 文件上传处理
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // 重置 input，允许重复选同一个文件
    e.target.value = '';

    // 首条消息设为对话标题
    if (messages.length === 0) {
      const title = file.name.length > 20 ? file.name.slice(0, 20) + '…' : file.name;
      setConversations((prev) =>
        prev.map((c) => (c.id === activeConv.id ? { ...c, title } : c))
      );
    }

    // 显示上传中消息
    const uploadingMsg: Message = { role: 'user', content: '📎 正在上传…' };
    const uploadIdx = messages.length;
    updateConvMessages(activeConv.id, (prev) => [...prev, uploadingMsg]);

    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      if (!res.ok) throw new Error('上传失败');
      const result = await res.json();

      // 替换上传中消息为实际内容
      if (result.type === 'image') {
        // 图片：displayMessage 无图片（UI 显示），用 images 字段传给 API
        const displayMsg: Message = { role: 'user', content: `📷 图片: ${result.fileName}` };
        const apiMsg: Message = { role: 'user', content: '📷 图片', images: [result.data] };
        updateConvMessages(activeConv.id, (prev) => {
          const updated = [...prev];
          updated[uploadIdx] = displayMsg;
          return updated;
        });
        // 直接发送带图片的 API 请求
        await sendWithImages(apiMsg);
      } else {
        // 文字文件：显示内容
        const displayMsg: Message = { role: 'user', content: result.data || `📄 上传了: ${result.fileName}` };
        updateConvMessages(activeConv.id, (prev) => {
          const updated = [...prev];
          updated[uploadIdx] = displayMsg;
          return updated;
        });
        // 发送消息（不包含文件内容，因为已作为用户消息显示）
        await sendWithText(result.data || '');
      }
    } catch (err) {
      console.error('[上传] 失败:', err);
      updateConvMessages(activeConv.id, (prev) => {
        const updated = [...prev];
        updated[uploadIdx] = { role: 'user', content: '❌ 上传失败' };
        return updated;
      });
    }
  };

  // 发送带图片的消息
  const sendWithImages = async (userMsg: Message) => {
    if (loading || !activeConv) return;

    // 直接构建消息列表，不依赖闭包（React 18 concurrent mode 陷阱修复）
    const currentMessages = messages.filter(m => m.content !== '📎 正在上传…'); // 去掉已替换的上传中消息
    const newMessages = [...currentMessages, userMsg];

    updateConvMessages(activeConv.id, (prev) => [...prev, { role: 'assistant', content: '', thinking: '', done: false }]);
    setLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: newMessages, model }),
      });
      if (!res.ok) throw new Error('请求失败');
      await handleStreamResponse(res);
    } catch {
      updateConvMessages(activeConv.id, (prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: 'assistant', content: '⚠️ 连接失败，请检查服务是否运行' };
        return updated;
      });
    } finally {
      setLoading(false);
    }
  };

  // 发送文本消息
  const sendWithText = async (text: string) => {
    if (loading || !activeConv) return;
    const currentMessages = messages.filter(m => m.content !== '📎 正在上传…');
    const newMessages = [...currentMessages, { role: 'user' as const, content: text }];
    updateConvMessages(activeConv.id, (prev) => [...prev, { role: 'assistant', content: '', thinking: '', done: false }]);
    setInput('');
    setLoading(true);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: newMessages, model }),
      });
      if (!res.ok) throw new Error('请求失败');
      await handleStreamResponse(res);
    } catch {
      updateConvMessages(activeConv.id, (prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: 'assistant', content: '⚠️ 连接失败，请检查服务是否运行' };
        return updated;
      });
    } finally {
      setLoading(false);
    }
  };

  // 流式响应处理
  const handleStreamResponse = async (res: Response) => {
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let assistantContent = '';
    let thinkingContent = '';
    let lastStats: { tokens: number; tps: number } | undefined;
    let toolCallsAcc: { name: string; args: any }[] | undefined;

    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');
      let hasUpdate = false;
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') break;
          try {
            const parsed = JSON.parse(data);
            // ─── /new /reset 重置会话 ─────────────────────
            if (parsed.reset) {
              // 移除旧会话中预添加的 /new 消息和空 assistant
              updateConvMessages(activeConv.id, (prev) => prev.slice(0, -2));
              // 创建新会话，切换到新 session_id
              const conv: Conversation = { id: parsed.session_id || genId(), title: '新对话', messages: [] };
              setConversations((prev) => [conv, ...prev]);
              setActiveId(conv.id);
              setLoading(false);
              return; // /new 消息不需要留在对话中
            }
            if (parsed.type === 'approval') {
              // 将 approvalId 注入到对应的工具调用中，而不是显示独立卡片
              if (toolCallsAcc) {
                const webSearchCall = toolCallsAcc.find(tc => tc.name === 'web_search' && tc.needsApproval);
                if (webSearchCall) {
                  webSearchCall.approvalId = parsed.approvalId;
                  hasUpdate = true;
                }
              }
              continue;
            }
            if (parsed.type === 'tool_calls') {
              toolCallsAcc = parsed.calls;
              hasUpdate = true;
              continue;
            }
            if (parsed.content) {
              if (parsed.content.startsWith('__STATS__')) {
                const statsJson = parsed.content.slice(9);
                try { lastStats = JSON.parse(statsJson); } catch {}
                continue;
              }
              assistantContent += parsed.content;
              hasUpdate = true;
            }
            if (parsed.thinking) {
              thinkingContent += parsed.thinking;
              hasUpdate = true;
            }
            // done 信号（含 thinking）
            if (parsed.done) {
              if (parsed.thinking) thinkingContent = parsed.thinking;
            }
          } catch {}
        }
      }
      if (hasUpdate) {
        // 流式期间只更新推理窗和工具调用，内容等 DONE 再显示
        updateConvMessages(activeConv.id, (prev) => {
          const updated = [...prev];
          const prevMsg = updated[updated.length - 1];
          updated[updated.length - 1] = { ...prevMsg, role: 'assistant', content: '', thinking: thinkingContent, toolCalls: toolCallsAcc, done: false };
          return updated;
        });
      }
    }
    // 流结束，一次性显示完整内容
    updateConvMessages(activeConv.id, (prev) => {
      const updated = [...prev];
      const prevMsg = updated[updated.length - 1];
      updated[updated.length - 1] = { ...prevMsg, role: 'assistant', content: assistantContent, thinking: thinkingContent || undefined, toolCalls: toolCallsAcc, done: true, stats: lastStats };
      return updated;
    });
    if (inputRef.current) inputRef.current.style.height = 'auto';
  };

  // 主发送函数
  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading || !activeConv) return;

    const newMessages = [...messages, { role: 'user' as const, content: text, time: Date.now() }];
    updateConvMessages(activeConv.id, () => newMessages);
    setInput('');
    setLoading(true);

    // 如果是第一条消息，用前几个字作为标题
    if (messages.length === 0) {
      const title = text.length > 20 ? text.slice(0, 20) + '…' : text;
      setConversations((prev) =>
        prev.map((c) => (c.id === activeConv.id ? { ...c, title } : c))
      );
    }

    updateConvMessages(activeConv.id, (prev) => [...prev, { role: 'assistant', content: '', thinking: '', done: false, time: Date.now() }]);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: newMessages, model }),
      });
      if (!res.ok) throw new Error('请求失败');
      await handleStreamResponse(res);
    } catch {
      updateConvMessages(activeConv.id, (prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: 'assistant', content: '⚠️ 连接失败，请检查服务是否运行' };
        return updated;
      });
    } finally {
      setLoading(false);
    }
  }, [input, messages, loading, activeConv, model, updateConvMessages]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  // ─── 会话操作 ───
  const newConversation = () => {
    const conv: Conversation = { id: genId(), title: '新对话', messages: [] };
    setConversations((prev) => [conv, ...prev]);
    setActiveId(conv.id);
  };

  const deleteConversation = (id: string) => {
    setOpenMenuId(null);
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id);
      if (next.length === 0) {
        const conv: Conversation = { id: genId(), title: '新对话', messages: [] };
        return [conv];
      }
      return next;
    });
    if (activeId === id) {
      setActiveId(conversations.find((c) => c.id !== id)?.id || '');
    }
  };

  // ─── 模型 ───
  const changeModel = (m: string) => {
    setModel(m);
    localStorage.setItem('hermes-model', m);
    setModelChanged(true);
  };
  const closeModel = () => { setShowModel(false); setModelChanged(false); };

  // ─── 飞书 ───
  const saveTavily = async () => {
    setTavilyStatus('保存中...');
    try {
      const res = await fetch('/api/config/tavily', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: tavilyKey }),
      });
      const data = await res.json();
      if (data.ok) {
        setTavilyStatus('✅ 已保存，重启服务生效');
        setTimeout(() => { setShowTavily(false); setTavilyStatus(''); }, 1500);
      } else {
        setTavilyStatus('❌ ' + (data.error || '保存失败'));
      }
    } catch {
      setTavilyStatus('❌ 网络错误');
    }
  };

  const saveFeishu = async () => {
    setFeishuStatus('保存中...');
    try {
      const res = await fetch('/api/config/feishu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: feishuId, appSecret: feishuSecret }),
      });
      const data = await res.json();
      if (data.ok) {
        setFeishuStatus('✅ 已保存，重启服务生效');
        setTimeout(() => { setShowFeishu(false); setFeishuStatus(''); }, 1500);
      } else {
        setFeishuStatus('❌ ' + (data.error || '保存失败'));
      }
    } catch {
      setFeishuStatus('❌ 网络错误');
    }
  };

  // ─── 侧栏拖拽 ───
  // ─── 导出对话 ───
  const exportChat = () => {
    const firstMsg = messages.find(m => m.content);
    const timeStr = firstMsg?.time
      ? new Date(firstMsg.time).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/[/:]/g, '-').replace(/ /g, '_')
      : new Date().toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/[/:]/g, '-').replace(/ /g, '_');
    const fileName = `small_agent_${timeStr}.txt`;
    const lines = messages.map(m => {
      const role = m.role === 'user' ? '用户' : 'AI';
      const time = m.time ? new Date(m.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
      return `[${role} ${time}]\n${m.content || ''}`;
    });
    const text = lines.join('\n\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: sidebarWidth };
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', stopDrag);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  const onDrag = (e: MouseEvent) => {
    if (!dragRef.current) return;
    const newW = Math.max(160, Math.min(480, dragRef.current.startW + (e.clientX - dragRef.current.startX)));
    setSidebarWidth(newW);
  };
  const stopDrag = () => {
    dragRef.current = null;
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', stopDrag);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // 持久化宽度
    setSidebarWidth((w) => {
      localStorage.setItem('hermes-sidebar-width', String(w));
      return w;
    });
  };

  // ─── 未登录 → 显示登录页 ───
  if (!isLoggedIn) {
    return <LoginPage onLogin={handleLogin} />;
  }

  const loadSkills = async () => {
    setSkillsLoading(true);
    try {
      const res = await fetch('/api/skills');
      const data = await res.json();
      setSkillsList(data.skills || []);
    } catch {
      setSkillsList([]);
    } finally {
      setSkillsLoading(false);
    }
  };

  const openNewSkill = () => {
    setEditingSkill(null);
    setEditName('');
    setEditDesc('');
    setEditCategory('');
    setEditBody('');
  };

  const openEditSkill = async (name: string) => {
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(name)}`);
      const data = await res.json();
      if (data.error) return;
      setEditingSkill(data);
      setEditName(data.name);
      setEditDesc(data.description);
      setEditCategory(data.category || '');
      // 去掉 frontmatter 只留 body
      const bodyMatch = data.content.match(/^---[\s\S]*?---\n?/);
      setEditBody(bodyMatch ? data.content.slice(bodyMatch[0].length) : data.content);
    } catch {}
  };

  const saveSkill = async () => {
    if (!editName || !editDesc || !editBody) return;
    try {
      if (editingSkill) {
        await fetch(`/api/skills/${encodeURIComponent(editingSkill.name)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: editDesc, category: editCategory, body: editBody }),
        });
      } else {
        await fetch('/api/skills', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: editName, description: editDesc, category: editCategory, body: editBody }),
        });
      }
      setEditingSkill(undefined);
      await loadSkills();
    } catch {}
  };

  const deleteSkill = async (name: string) => {
    if (!confirm(`确定删除技能「${name}」？`)) return;
    try {
      await fetch(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
      await loadSkills();
    } catch {}
  };

  // ─── 权限确认 ───
  const handleApproval = async (approved: boolean) => {
    if (!pendingApproval) return;
    const { approvalId } = pendingApproval;
    setPendingApproval(null);
    setApprovalTimeout(false);
    try {
      await fetch('/api/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: approvalId, approved }),
      });
    } catch {}
  };

  // ─── 权限确认（工具面板内） ───
  const handleToolApprove = async (approvalId: string, approved: boolean) => {
    try {
      await fetch('/api/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: approvalId, approved }),
      });
    } catch {}
    // 清除该工具调用的 approvalId，让按钮消失
    updateConvMessages(activeConv.id, (prev) => {
      const updated = [...prev];
      const lastMsg = updated[updated.length - 1];
      if (lastMsg.role === 'assistant' && lastMsg.toolCalls) {
        const tool = lastMsg.toolCalls.find(tc => tc.approvalId === approvalId);
        if (tool) delete tool.approvalId;
      }
      return updated;
    });
  };

  // ─── 定时任务函数 ───
  const loadCron = async () => {
    setCronLoading(true);
    try {
      const res = await fetch('/api/cron');
      const data = await res.json();
      setCronList(data.jobs || []);
    } catch {
      setCronList([]);
    } finally {
      setCronLoading(false);
    }
  };

  const openNewCron = () => {
    setCronEditing(null);
    setCronName('');
    setCronSchedule('');
    setCronPrompt('');
  };

  const openEditCron = (job: any) => {
    setCronEditing(job);
    setCronName(job.name);
    setCronSchedule(job.schedule);
    setCronPrompt(job.prompt);
  };

  const saveCron = async () => {
    if (!cronName || !cronSchedule || !cronPrompt) return;
    try {
      if (cronEditing) {
        await fetch(`/api/cron/${cronEditing.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: cronName, schedule: cronSchedule, prompt: cronPrompt }),
        });
      } else {
        await fetch('/api/cron', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: cronName, schedule: cronSchedule, prompt: cronPrompt }),
        });
      }
      setCronEditing(undefined);
      await loadCron();
    } catch {}
  };

  const deleteCron = async (id: string, name: string) => {
    setCronDeleteTarget({ id, name });
  };
  const confirmDeleteCron = async () => {
    if (!cronDeleteTarget) return;
    try {
      await fetch(`/api/cron/${cronDeleteTarget.id}`, { method: 'DELETE' });
      setCronDeleteTarget(null);
      await loadCron();
    } catch {}
  };

  const toggleCron = async (job: any) => {
    try {
      await fetch(`/api/cron/${job.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !job.enabled }),
      });
      await loadCron();
    } catch {}
  };

  const formatNextRun = (nextRun: number | null): string => {
    if (!nextRun) return '—';
    const d = new Date(nextRun);
    const now = Date.now();
    const diff = nextRun - now;
    if (diff < 60000) return '即将触发';
    if (diff < 3600000) return `${Math.round(diff / 60000)} 分钟后`;
    if (diff < 86400000) return `${Math.round(diff / 3600000)} 小时后`;
    return d.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const formatSchedule = (s: string): string => {
    const m = s.match(/^(\d+)\s*(m|h|d)$/);
    if (m) {
      const n = m[1];
      const unit = { m: '分钟', h: '小时', d: '天' }[m[2] as string];
      return `每 ${n}${unit}`;
    }
    if (/^\d{2}:\d{2}$/.test(s)) {
      const h = parseInt(s.split(':')[0], 10);
      const period = h >= 6 && h < 12 ? '早上' : h >= 12 && h < 18 ? '下午' : h >= 18 && h < 22 ? '晚上' : '深夜';
      return `每天${period}${s}`;
    }
    return s || '—';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* ═══ 顶栏（全宽） ═══ */}
      <header className="toolbar" style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 16px', flexShrink: 0, gap: 8, height: 48,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <AppIcon size={20} />
          <h1 style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.2px' }}>Small Hermes</h1>
          <span style={{
            fontSize: 11, color: 'var(--text-muted)', background: 'var(--elevated)',
            padding: '2px 8px', borderRadius: 6,
          }}>{model}</span>
        </div>
        <div style={{ display: 'flex', gap: 2, position: 'relative' }} ref={settingsRef}>
          <button onClick={() => setShowSettings(prev => !prev)} style={{
            background: showSettings ? 'var(--elevated)' : 'transparent',
            border: 'none', cursor: 'pointer', padding: '4px 8px',
            borderRadius: 20, display: 'flex', alignItems: 'center', gap: 5,
            color: showSettings ? 'var(--text)' : 'var(--text-secondary)',
            fontSize: 12, fontWeight: 500, transition: 'all 0.15s',
            whiteSpace: 'nowrap',
          }}
            onMouseEnter={(e) => { if (!showSettings) { e.currentTarget.style.background = 'var(--elevated)'; e.currentTarget.style.color = 'var(--text)'; } }}
            onMouseLeave={(e) => { if (!showSettings) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)'; } }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            设置
          </button>

          {/* 下拉菜单 */}
          {showSettings && (
            <div style={{
              position: 'absolute', top: '100%', right: 0, marginTop: 6,
              background: 'var(--frosted)', backdropFilter: 'blur(40px)',
              WebkitBackdropFilter: 'blur(40px)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', padding: 6, zIndex: 200, minWidth: 190,
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
              animation: 'fadeIn 0.15s ease-out',
            }}>
              {/* 连接 */}
              <div style={{ fontSize: 10, color: 'var(--text-muted)', padding: '4px 12px 2px', letterSpacing: '0.5px', textTransform: 'uppercase' }}>连接</div>
              <SettingItem icon="🧠" label="模型切换" onClick={() => { setShowSettings(false); setShowModel(true); }} />
              <SettingItem icon="💬" label="飞书连接" onClick={() => { setShowSettings(false); setShowFeishu(true); }} />
              <SettingItem icon="💚" label="微信连接" onClick={() => { setShowSettings(false); setShowWechat(true); }} />
              <SettingItem icon="🔑" label="搜索密钥" onClick={() => { setShowSettings(false); setShowTavily(true); }} />
              <div style={{ height: 1, background: 'var(--border)', margin: '4px 8px' }} />

              {/* 工具 */}
              <div style={{ fontSize: 10, color: 'var(--text-muted)', padding: '4px 12px 2px', letterSpacing: '0.5px', textTransform: 'uppercase' }}>工具</div>
              <SettingItem icon="⚡" label="技能管理" onClick={() => { setShowSettings(false); setShowSkills(true); loadSkills(); }} />
              <SettingItem icon="⏰" label="定时任务" onClick={() => { setShowSettings(false); setShowCron(true); loadCron(); }} />
              <SettingItem icon="📊" label="测试模型" onClick={() => { setShowSettings(false); setShowBenchmark(true); }} />
              <div style={{ height: 1, background: 'var(--border)', margin: '4px 8px' }} />

              {/* 显示 */}
              <div style={{ fontSize: 10, color: 'var(--text-muted)', padding: '4px 12px 2px', letterSpacing: '0.5px', textTransform: 'uppercase' }}>显示</div>
              <SettingItem icon={thinkingOpen ? '📖' : '📕'} label="推理窗" onClick={() => { setThinkingOpen(prev => !prev); setShowSettings(false); }} />
              <SettingItem icon={theme === 'dark' ? '☀️' : '🌙'} label={theme === 'dark' ? '浅色模式' : '深色模式'} onClick={() => { setShowSettings(false); toggleTheme(); }} />
              <div style={{ height: 1, background: 'var(--border)', margin: '4px 8px' }} />

              {/* 系统 */}
              <div style={{ fontSize: 10, color: 'var(--text-muted)', padding: '4px 12px 2px', letterSpacing: '0.5px', textTransform: 'uppercase' }}>系统</div>
              <SettingItem icon="🔄" label="重启服务" onClick={() => { setShowSettings(false); setShowRestart(true); }} />
              <SettingItem icon="ℹ️" label="关于" onClick={() => { setShowSettings(false); setShowAbout(true); }} />
            </div>
          )}
        </div>
      </header>

      {/* ═══ 主体（侧栏 + 聊天） ═══ */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>

      {/* ═══ 左侧会话列表 ═══ */}
      <div className="conv-list" style={{ width: sidebarWidth, flexShrink: 0 }}>
        <button className="conv-new-btn" onClick={newConversation}>+ 新建对话</button>
        <div className="conv-items">
          {conversations.slice().sort((a, b) => {
            if (a.id === 'cron') return -1;
            if (b.id === 'cron') return 1;
            if (a.id === 'feishu') return -1;
            if (b.id === 'feishu') return 1;
            return 0;
          }).map((conv) => (
            <div
              key={conv.id}
              className={`conv-item${conv.id === activeId ? ' active' : ''}`}
              onClick={() => setActiveId(conv.id)}
            >
              <span className="conv-item-title">{conv.title}</span>
              <button
                className="conv-item-menu-btn"
                onClick={(e) => { e.stopPropagation(); setOpenMenuId(openMenuId === conv.id ? null : conv.id); }}
              >
                ⋯
              </button>
              {openMenuId === conv.id && (
                <div className="conv-menu" onClick={(e) => e.stopPropagation()}>
                  <button className="danger" onClick={() => deleteConversation(conv.id)}>删除</button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ═══ 拖拽分割线 ═══ */}
      <div
        onMouseDown={startDrag}
        style={{
          width: 4, cursor: 'col-resize', flexShrink: 0,
          background: 'transparent', transition: 'background 0.15s',
          position: 'relative',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--border)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      />

      {/* ═══ 主区域 ═══ */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* 聊天区域 */}
        <div ref={chatContainerRef} onClick={() => inputRef.current?.focus()} style={{ flex: 1, overflowY: 'auto', padding: '20px', background: 'var(--bg-chat)' }}>
          {messages.length === 0 && (
            <div className="empty-state">
              <AppIcon size={64} />
              <p className="empty-state-title">Small Hermes</p>
              <p className="empty-state-sub">本地模型，飞书互通 · 输入消息开始对话</p>
            </div>
          )}

          {messages.map((msg, i) => {
            const isLast = loading && i === messages.length - 1;
            return (
            <div key={i} className="msg-bubble" style={{
              display: 'flex', gap: 10, marginBottom: 16,
              flexDirection: msg.role === 'user' ? 'row-reverse' : 'row',
              alignItems: 'flex-start',
            }}>
              {/* 头像 */}
              <div className={`avatar ${msg.role === 'user' ? 'avatar-user' : 'avatar-assistant'}`}
                style={{ marginTop: 2, fontSize: 16, overflow: 'hidden' }}>
                {msg.role === 'user' ? userAvatar : (
                  <img src="/favicon.jpg" alt="AI" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                )}
              </div>

              <div style={{ maxWidth: '72%', minWidth: 0 }}>
                {msg.role === 'assistant' && (msg.thinking || isLast) && (
                  <details open={thinkingOpen} onToggle={(e) => setThinkingOpen((e.target as HTMLDetailsElement).open)} className="thinking-panel" style={{ marginBottom: 6, width: '100%', display: 'block' }}>
                    <summary
                      style={{
                        cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 12,
                        userSelect: 'none', padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 4, width: '100%',
                        background: 'var(--accent-dim)',
                        border: '1px solid var(--border)',
                      }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <ThinkingIcon />
                        <span>推理过程</span>
                      </span>
                      <span style={{
                        marginLeft: 'auto', fontSize: 11, color: msg.done !== undefined ? (msg.done ? '#4caf50' : '#ff9800') : (msg.content ? '#4caf50' : '#ff9800'),
                      }}>
                        {msg.done !== undefined ? (msg.done ? '✓ 完成' : '● 进行中') : (msg.content ? '✓ 完成' : '● 进行中')}
                      </span>
                    </summary>
                    <div ref={thinkingContainerRef} style={{
                      fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg-secondary)',
                      padding: '8px 12px', borderRadius: '0 0 var(--radius) var(--radius)',
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5,
                      maxHeight: '200px', overflow: 'auto', width: '100%', boxSizing: 'border-box',
                      border: '1px solid var(--border)', borderTop: 'none',
                      minHeight: '40px',
                    }}>
                      {msg.thinking ? msg.thinking : ''}
                    </div>
                    {msg.thinking && msg.thinking.length > 2000 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          e.currentTarget.parentElement!.querySelector('div')!.innerHTML = msg.thinking || '';
                          e.currentTarget.remove();
                        }}
                        style={{
                          fontSize: 11, color: 'var(--accent)', background: 'none', border: 'none',
                          cursor: 'pointer', padding: '4px 8px', margin: '4px 0 0 0',
                        }}
                      >
                        查看完整推理
                      </button>
                    )}
                  </details>
                )}
                {msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0 && (
                  <details className="tool-calls-panel" open style={{ marginBottom: 6, width: '100%', display: 'block' }}>
                    <summary style={{
                      cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 12,
                      userSelect: 'none', padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 4,
                      width: '100%',
                      background: 'var(--accent-dim)',
                      border: '1px solid var(--border)',
                    }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ fontSize: 14 }}>⚙️</span>
                        <span>工具调用 ({msg.toolCalls.length})</span>
                      </span>
                    </summary>
                    <div style={{
                      fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg-secondary)',
                      padding: '8px 12px', borderRadius: '0 0 var(--radius) var(--radius)',
                      lineHeight: 1.5, maxHeight: '200px', overflow: 'auto', width: '100%', boxSizing: 'border-box',
                      border: '1px solid var(--border)', borderTop: 'none',
                    }}>
                      {msg.toolCalls.map((tc, j) => {
                        const d = getToolDisplay(tc.name);
                        const argsStr = typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args, null, 2);
                        const shortArgs = argsStr.length > 120 ? argsStr.slice(0, 120) + '…' : argsStr;
                        return (
                          <div key={j} style={{
                            padding: '6px 0', borderBottom: j < msg.toolCalls!.length - 1 ? '1px solid var(--border-light)' : 'none',
                          }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                              <span style={{ fontSize: 16 }}>{d.icon}</span>
                              <span style={{ fontWeight: 600, color: d.color, fontSize: 13 }}>{d.label}</span>
                              {tc.needsApproval && !tc.approvalId && (
                                <span style={{ fontSize: 11, color: '#ff9800', marginLeft: 4 }}>⏳ 等待确认...</span>
                              )}
                            </div>
                            <div style={{
                              padding: '4px 8px', margin: '4px 0 0 0',
                              background: 'var(--bg)', borderRadius: 6,
                              fontFamily: 'monospace', fontSize: 11,
                              whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                              color: 'var(--text-muted)',
                            }}>
                              {shortArgs}
                            </div>
                            {tc.needsApproval && tc.approvalId && (
                              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                                <button onClick={() => handleToolApprove(tc.approvalId!, true)} style={{
                                  flex: 1, padding: '4px 0', borderRadius: 6,
                                  border: 'none', background: 'var(--accent)', color: '#fff',
                                  cursor: 'pointer', fontSize: 12, fontWeight: 600,
                                }}>✅ 允许搜索</button>
                                <button onClick={() => handleToolApprove(tc.approvalId!, false)} style={{
                                  flex: 1, padding: '4px 0', borderRadius: 6,
                                  border: '1px solid var(--border)', background: 'none',
                                  color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12,
                                }}>❌ 拒绝</button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </details>
                )}
                <div style={{
                  padding: msg.role === 'user' ? '9px 16px' : '10px 16px',
                  borderRadius: 'var(--radius)',
                  background: msg.role === 'user' ? 'var(--user-bubble)' : 'var(--assistant-bubble)',
                  color: msg.role === 'user' ? 'var(--user-bubble-text)' : 'var(--text)',
                  border: msg.role === 'assistant' ? '1px solid var(--border)' : 'none',
                  lineHeight: 1.6, fontSize: 14, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>
                  <MessageContent content={msg.content} />
                  {!msg.content && msg.role === 'assistant' && isLast ? (
                    <span className="thinking-dots" style={{ color: 'var(--text-muted)' }}>
                      <span>●</span><span>●</span><span>●</span>
                    </span>
                  ) : null}
                </div>
                {msg.role === 'assistant' && msg.stats && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    {msg.time && <span>{new Date(msg.time).toLocaleTimeString()}</span>}
                    <span>{msg.stats.tokens} tokens · {msg.stats.tps} tok/s</span>
                  </div>
                )}
                {msg.role === 'assistant' && !msg.stats && msg.done && msg.time && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, textAlign: 'right' }}>
                    {new Date(msg.time).toLocaleTimeString()}
                  </div>
                )}
                {msg.role === 'user' && msg.time && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, textAlign: 'right' }}>
                    {new Date(msg.time).toLocaleTimeString()}
                  </div>
                )}
              </div>
            </div>
          )})}
          <div ref={chatEndRef} />
        </div>

        {/* 权限确认已移入工具调用面板 */}

        {/* 输入区域 */}
        <div style={{
          padding: '12px 20px 16px', background: 'linear-gradient(0deg, var(--bg-chat) 60%, transparent)', flexShrink: 0,
        }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', maxWidth: 800, margin: '0 auto' }}>
            {/* 附件按钮 */}
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={loading || activeConv?.id === 'feishu' || activeConv?.id === 'cron'}
              title="上传文件"
              style={{
                background: 'var(--elevated)', border: 'none', borderRadius: 'var(--radius)',
                width: 36, height: 36, flexShrink: 0,
                cursor: loading ? 'not-allowed' : 'pointer',
                color: 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                opacity: loading ? 0.4 : 1, transition: 'all 0.15s',
              }}
              onMouseEnter={(e) => { if (!loading) e.currentTarget.style.background = 'var(--border)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--elevated)'; }}
            >
              <IconAttach />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,.pdf,.docx,.txt,.md,.json,.js,.ts,.py,.html,.css,.csv,.xml,.yaml,.yml,.log"
              style={{ display: 'none' }}
              onChange={handleFileSelect}
            />
            <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center' }}>
              <textarea
                ref={inputRef} value={input} onChange={handleInputChange} onKeyDown={handleKeyDown}
                placeholder={activeConv?.id === 'feishu' ? '飞书消息只读，请在飞书客户端回复' : activeConv?.id === 'cron' ? '定时提醒只读' : '输入消息...'}
                rows={1} disabled={loading || activeConv?.id === 'feishu' || activeConv?.id === 'cron'}
                style={{
                  width: '100%', background: 'var(--elevated)', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)', padding: '10px 44px 10px 16px', color: 'var(--text)', fontSize: 14,
                  resize: 'none', outline: 'none', fontFamily: 'inherit', lineHeight: 1.5,
                  maxHeight: 120, overflow: 'hidden', transition: 'border-color 0.2s',
                }}
                onFocus={(e) => { e.target.style.borderColor = 'var(--accent)'; }}
                onBlur={(e) => { e.target.style.borderColor = 'var(--border)'; }}
              />
              <button onClick={sendMessage} disabled={loading || !input.trim() || activeConv?.id === 'feishu' || activeConv?.id === 'cron'} style={{
                position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)',
                background: (loading || !input.trim() || activeConv?.id === 'feishu' || activeConv?.id === 'cron') ? 'var(--elevated)' : 'var(--accent)',
                color: (loading || !input.trim() || activeConv?.id === 'feishu' || activeConv?.id === 'cron') ? 'var(--text-muted)' : '#fff',
                border: 'none', borderRadius: 18, width: 28, height: 28,
                cursor: loading ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 600,
                transition: 'all 0.15s', display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 0,
              }}>
                ↑
              </button>
            </div>
            {/* 导出按钮 */}
            <button
              onClick={exportChat}
              disabled={messages.length === 0}
              title="导出对话"
              style={{
                background: 'var(--elevated)', border: 'none', borderRadius: 'var(--radius)',
                width: 36, height: 36, flexShrink: 0,
                cursor: messages.length === 0 ? 'not-allowed' : 'pointer',
                color: 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                opacity: messages.length === 0 ? 0.4 : 1, transition: 'all 0.15s',
              }}
              onMouseEnter={(e) => { if (messages.length > 0) e.currentTarget.style.background = 'var(--border)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--elevated)'; }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </button>
          </div>
        </div>
      </div>
      </div>  {/* end body wrapper */}

      {/* ═══ 弹窗 ═══ */}
      {showModel && (
        <Modal title="模型选择" onClose={closeModel}>
          <label>本地模型（共 {models.length} 个）</label>
          <select value={model} onChange={(e) => changeModel(e.target.value)}>
            {models.length === 0 && <option value="">未检测到模型</option>}
            {models.map((m) => <option key={m.name} value={m.name}>{m.name}（{(m.size / 1e9).toFixed(1)} GB）</option>)}
          </select>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: -8 }}>
            数据来自 Ollama · ollama pull 拉取新模型
          </p>
          <div className="modal-actions">
            <button className={modelChanged ? 'btn-primary' : 'btn-ghost'} onClick={closeModel}>{modelChanged ? '确认' : '关闭'}</button>
          </div>
        </Modal>
      )}

      {showFeishu && (
        <Modal title="飞书配置" onClose={() => { setShowFeishu(false); setFeishuStatus(''); }}>
          <label>App ID</label>
          <input value={feishuId} onChange={(e) => setFeishuId(e.target.value)} placeholder="cli_xxxxxxxx" />
          <label>App Secret</label>
          <input type="password" value={feishuSecret} onChange={(e) => setFeishuSecret(e.target.value)} placeholder="输入密钥" />
          {feishuStatus && (
            <p style={{ fontSize: 13, color: feishuStatus.startsWith('✅') ? '#4caf50' : feishuStatus.startsWith('❌') ? '#e74c3c' : 'var(--text-muted)', marginBottom: 12 }}>
              {feishuStatus}
            </p>
          )}
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
            保存后需重启服务生效
          </p>
          <div className="modal-actions">
            <button className="btn-ghost" onClick={() => { setShowFeishu(false); setFeishuStatus(''); }}>取消</button>
            <button className="btn-primary" onClick={saveFeishu}>保存</button>
          </div>
        </Modal>
      )}

      {showTavily && (
        <Modal title="搜索配置 (Tavily)" onClose={() => { setShowTavily(false); setTavilyStatus(''); }}>
          <label>API Key</label>
          <input type="password" value={tavilyKey} onChange={(e) => setTavilyKey(e.target.value)} placeholder="tvly-dev-xxxxx" />
          {tavilyStatus && (
            <p style={{ fontSize: 13, color: tavilyStatus.startsWith('✅') ? '#4caf50' : tavilyStatus.startsWith('❌') ? '#e74c3c' : 'var(--text-muted)', marginBottom: 12 }}>
              {tavilyStatus}
            </p>
          )}
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
            配置后模型可联网搜索 · tavily.com 免费注册
          </p>
          <div className="modal-actions">
            <button className="btn-ghost" onClick={() => { setShowTavily(false); setTavilyStatus(''); }}>取消</button>
            <button className="btn-primary" onClick={saveTavily}>保存</button>
          </div>
        </Modal>
      )}

      {showRestart && (
        <Modal title="重启服务" onClose={() => setShowRestart(false)}>
          <p style={{ fontSize: 14, color: 'var(--text)', marginBottom: 20, textAlign: 'center', padding: '8px 0' }}>
            确定要重启服务吗？
          </p>
          <div className="modal-actions">
            <button className="btn-ghost" onClick={() => setShowRestart(false)}>取消</button>
            <button className="btn-primary" onClick={async () => {
              setShowRestart(false);
              await fetch('/api/restart', { method: 'POST' });
              setTimeout(() => location.reload(), 2000);
            }}>确认重启</button>
          </div>
        </Modal>
      )}

      {showBenchmark && (
        <Modal title="模型跑分" onClose={() => { setShowBenchmark(false); setBenchmarkResults([]); setBenchmarkError(''); }}>
          {!benchmarkRunning && benchmarkResults.length === 0 && !benchmarkError && (
            <div>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16, lineHeight: 1.6 }}>
                选择模型进行速度测试，测试前会先发一条消息暖机：
              </p>
              <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: 13, fontWeight: 500, marginBottom: 6, display: 'block' }}>选择模型</label>
                <select
                  id="benchmark-model"
                  defaultValue={model}
                  style={{
                    width: '100%', padding: '8px 10px', borderRadius: 6,
                    border: '1px solid var(--border)', background: 'var(--bg)',
                    color: 'var(--text)', fontSize: 13, outline: 'none',
                  }}
                >
                  {models.length === 0 && <option value="">未检测到模型</option>}
                  {models.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
                </select>
              </div>
              <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 20, lineHeight: 1.5 }}>
                测试内容：发送 small-hermes 项目介绍文本<br />
                测试指标：首 token 时间（ms）+ tok/s
              </div>
              <div className="modal-actions">
                <button className="btn-ghost" onClick={() => setShowBenchmark(false)}>关闭</button>
                <button className="btn-primary" onClick={async () => {
                  const sel = document.getElementById('benchmark-model') as HTMLSelectElement;
                  const selectedModel = sel?.value || model;
                  setBenchmarkRunning(true);
                  setBenchmarkResults([]);
                  setBenchmarkError('');
                  try {
                    const res = await fetch('/api/benchmark', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ model: selectedModel }),
                    });
                    const reader = res.body?.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';
                    while (reader) {
                      const { done, value } = await reader.read();
                      if (done) break;
                      buffer += decoder.decode(value, { stream: true });
                      const lines = buffer.split('\n');
                      buffer = lines.pop() || '';
                      for (const line of lines) {
                        if (line.startsWith('data: ')) {
                          try {
                            const data = JSON.parse(line.slice(6));
                            if (data.type === 'warmup') {
                              setBenchmarkResults(prev => {
                                const existing = prev.find(r => r._warmup);
                                if (existing) {
                                  existing.message = data.message;
                                  return [...prev];
                                }
                                return [...prev, { _warmup: true, label: '暖机', message: data.message }];
                              });
                            } else if (data.type === 'progress') {
                              setBenchmarkResults(prev => {
                                const idx = prev.findIndex(r => r.label === data.label);
                                if (idx >= 0) {
                                  const next = [...prev];
                                  next[idx] = data;
                                  return next;
                                }
                                return [...prev, data];
                              });
                            } else if (data.type === 'done') {
                              setBenchmarkResults(data.results.map((r: any) => ({ ...r, _model: selectedModel })));
                            } else if (data.type === 'error') {
                              setBenchmarkError(data.error);
                            }
                          } catch {}
                        }
                      }
                    }
                  } catch (err: any) {
                    setBenchmarkError(err.message || '请求失败');
                  } finally {
                    setBenchmarkRunning(false);
                  }
                }}>开始测试</button>
              </div>
            </div>
          )}

          {benchmarkRunning && (
            <div>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>测试进行中…</p>
              {benchmarkResults.map((r, i) => (
                <div key={i} style={{
                  padding: '8px 12px', marginBottom: 8, borderRadius: 6,
                  background: 'var(--bg-secondary)', fontSize: 13,
                  border: r.error ? '1px solid #e74c3c' : !r.tps && !r._warmup ? '1px solid #ff9800' : '1px solid var(--border)',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontWeight: 500 }}>{r._warmup ? '🔥 暖机' : r.label}</span>
                    {r.error ? <span style={{ color: '#e74c3c' }}>❌</span>
                    : r._warmup ? <span style={{ color: '#ff9800' }}>⏳</span>
                    : r.tps ? <span style={{ color: '#4caf50' }}>✓</span>
                    : <span style={{ color: '#ff9800' }}>⏳</span>}
                  </div>
                  {r._warmup && <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>{r.message}</div>}
                  {r.error && <div style={{ color: '#e74c3c', fontSize: 12 }}>{r.error}</div>}
                  {r.tps && (
                    <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                      📦 {r.bodySizeKB}KB · ⏱ 首token {r.firstTokenMs}ms · 🚀 {r.tps} tok/s
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {!benchmarkRunning && benchmarkResults.length > 0 && (
            <div>
              <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12, textAlign: 'center' }}>
                {benchmarkResults[0]?._model || model} 跑分
              </h3>
              <div style={{ marginBottom: 12 }}>
                {benchmarkResults.map((r, i) => (
                  <div key={i} style={{
                    padding: '8px 12px', marginBottom: 8, borderRadius: 6,
                    background: 'var(--bg-secondary)', fontSize: 13,
                    border: r.error ? '1px solid #e74c3c' : '1px solid var(--border)',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                      <span style={{ fontWeight: 500 }}>{r.label}</span>
                      {r.error ? <span style={{ color: '#e74c3c' }}>❌</span> : <span style={{ color: '#4caf50' }}>✓</span>}
                    </div>
                    {r.error ? (
                      <div style={{ color: '#e74c3c', fontSize: 12 }}>{r.error}</div>
                    ) : (
                      <div style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.7 }}>
                        📦 {r.bodySizeKB}KB · {r.inputChars}字<br />
                        ⏱ 首token <strong>{r.firstTokenMs}ms</strong> · 🚀 <strong>{r.tps} tok/s</strong>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                首 token 越低 → 响应越快 &nbsp;|&nbsp; tok/s 越高 → 输出越快
              </div>
              <div className="modal-actions">
                <button className="btn-ghost" onClick={() => { setShowBenchmark(false); setBenchmarkResults([]); }}>关闭</button>
                <button className="btn-primary" onClick={() => { setBenchmarkResults([]); setBenchmarkError(''); }}>重新测试</button>
              </div>
            </div>
          )}

          {benchmarkError && (
            <div>
              <p style={{ color: '#e74c3c', fontSize: 13, marginBottom: 16 }}>❌ {benchmarkError}</p>
              <div className="modal-actions">
                <button className="btn-ghost" onClick={() => { setShowBenchmark(false); setBenchmarkError(''); setBenchmarkResults([]); }}>关闭</button>
              </div>
            </div>
          )}
        </Modal>
      )}

      {showSkills && (
        <Modal title={editingSkill === null ? '新建技能' : editingSkill ? '编辑技能' : '技能管理'} onClose={() => { setShowSkills(false); setEditingSkill(undefined); }} width={560}>
          {/* 编辑/新建模式 */}
          {editingSkill !== undefined && (
            <div>
              <label>技能名称</label>
              <input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="my-skill" disabled={editingSkill !== null} style={{ opacity: editingSkill !== null ? 0.5 : 1 }} />
              <label>描述</label>
              <input value={editDesc} onChange={(e) => setEditDesc(e.target.value)} placeholder="简短描述这个技能的用途" />
              <label>分类</label>
              <input value={editCategory} onChange={(e) => setEditCategory(e.target.value)} placeholder="software-development, devops, 等" />
              <label>内容（Markdown）</label>
              <textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} placeholder={'## 步骤\n1. ...\n2. ...\n\n## 注意事项\n...'}
                style={{ width: '100%', height: 240, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'monospace', resize: 'vertical', outline: 'none', marginBottom: 16 }}
              />
              <div className="modal-actions">
                <button className="btn-ghost" onClick={() => setEditingSkill(undefined)}>取消</button>
                <button className="btn-primary" onClick={saveSkill} disabled={!editName || !editDesc || !editBody}>保存</button>
              </div>
            </div>
          )}

          {/* 列表模式 */}
          {editingSkill === undefined && (
            <div>
              {skillsLoading ? (
                <p style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', padding: 20 }}>加载中...</p>
              ) : skillsList.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 20 }}>
                  <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>还没有技能，创建一个吧</p>
                  <button className="btn-primary" style={{ padding: '8px 20px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13 }} onClick={openNewSkill}>+ 新建技能</button>
                </div>
              ) : (
                <div>
                  <button className="btn-primary" style={{ padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, marginBottom: 12, width: '100%' }} onClick={openNewSkill}>+ 新建技能</button>
                  <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                    {skillsList.map((sk: any, i: number) => (
                      <div key={i} style={{ padding: '10px 12px', marginBottom: 6, borderRadius: 8, background: 'var(--bg)', border: '1px solid var(--border)', cursor: 'pointer' }}
                        onClick={() => openEditSkill(sk.name)}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                          <span style={{ fontWeight: 600, fontSize: 13 }}>{sk.name}</span>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            {sk.category && <span style={{ fontSize: 11, color: 'var(--accent)', background: 'var(--accent-dim)', padding: '1px 6px', borderRadius: 4 }}>{sk.category}</span>}
                            <button onClick={(e) => { e.stopPropagation(); deleteSkill(sk.name); }} style={{ background: 'none', border: 'none', color: '#e74c3c', cursor: 'pointer', fontSize: 13, padding: '2px 6px', borderRadius: 4 }} title="删除">✕</button>
                          </div>
                        </div>
                        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>{sk.description}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </Modal>
      )}

      {showCron && (
        <Modal title={cronEditing === null ? '新建定时任务' : cronEditing ? '编辑任务' : '定时任务'} onClose={() => { setShowCron(false); setCronEditing(undefined); }} width={560}>
          {/* 编辑/新建模式 */}
          {cronEditing !== undefined && (
            <div>
              <label>任务名称</label>
              <input value={cronName} onChange={(e) => setCronName(e.target.value)} placeholder="每日提醒" disabled={cronEditing !== null} style={{ opacity: cronEditing !== null ? 0.5 : 1 }} />
              <label>触发间隔</label>
              <input value={cronSchedule} onChange={(e) => setCronSchedule(e.target.value)} placeholder="例：每30分钟 或 每天早上9点" />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, marginBottom: 16 }}>
                {[
                  { label: '⏰ 每30分钟', val: '30m' },
                  { label: '⏰ 每小时', val: '1h' },
                  { label: '☀️ 每早8点', val: '08:00' },
                  { label: '📅 每天一次', val: '1d' },
                  { label: '🌙 每晚10点', val: '22:00' },
                ].map((preset) => (
                  <button key={preset.val} onClick={() => setCronSchedule(preset.val)}
                    style={{
                      background: cronSchedule === preset.val ? 'var(--accent-dim)' : 'var(--bg)',
                      border: cronSchedule === preset.val ? '1px solid var(--accent)' : '1px solid var(--border)',
                      borderRadius: 8, padding: '6px 12px', cursor: 'pointer',
                      fontSize: 12, color: cronSchedule === preset.val ? 'var(--accent)' : 'var(--text-secondary)',
                      transition: 'all 0.15s',
                    }}>
                    {preset.label}
                  </button>
                ))}
              </div>
              <label>触发消息</label>
              <textarea value={cronPrompt} onChange={(e) => setCronPrompt(e.target.value)} placeholder="早上好！记得开会"
                style={{ width: '100%', height: 100, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'inherit', resize: 'vertical', outline: 'none', marginBottom: 16 }}
              />
              <div className="modal-actions">
                <button className="btn-ghost" onClick={() => setCronEditing(undefined)}>取消</button>
                <button className="btn-primary" onClick={saveCron} disabled={!cronName || !cronSchedule || !cronPrompt}>保存</button>
              </div>
            </div>
          )}

          {/* 列表模式 */}
          {cronEditing === undefined && (
            <div>
              {cronLoading ? (
                <p style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', padding: 20 }}>加载中...</p>
              ) : (
                <div>
                  <button className="btn-primary" style={{ padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, marginBottom: 12, width: '100%' }} onClick={openNewCron}>+ 新建任务</button>

                  {/* 最近触发记录 */}
                  {cronTriggers.length > 0 && (
                    <details style={{ marginBottom: 12 }}>
                      <summary style={{ fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }}>触发记录（{cronTriggers.length}）</summary>
                      <div style={{ maxHeight: 120, overflowY: 'auto', marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                        {cronTriggers.map((t, i) => (
                          <div key={i} style={{ padding: '4px 8px', borderBottom: '1px solid var(--border)' }}>
                            <span style={{ color: 'var(--accent)' }}>⏰ {t.jobName}</span>
                            <span style={{ marginLeft: 8 }}>{t.prompt.slice(0, 40)}</span>
                            <span style={{ float: 'right', fontSize: 11 }}>{new Date(t.time).toLocaleTimeString()}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}

                  {cronList.length === 0 ? (
                    <p style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', padding: 20 }}>还没有定时任务</p>
                  ) : (
                    <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                      {cronList.map((j: any, i: number) => (
                        <div key={i} style={{ padding: '10px 12px', marginBottom: 6, borderRadius: 8, background: 'var(--bg)', border: '1px solid var(--border)', opacity: j.enabled ? 1 : 0.5 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span onClick={() => toggleCron(j)} style={{ cursor: 'pointer', fontSize: 14, color: j.enabled ? '#4caf50' : 'var(--text-muted)' }} title={j.enabled ? '点击暂停' : '点击启用'}>{j.enabled ? '⏰' : '🔕'}</span>
                              <span style={{ fontWeight: 600, fontSize: 13, cursor: 'pointer' }} onClick={() => openEditCron(j)}>{j.name}</span>
                            </div>
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{formatSchedule(j.schedule)}</span>
                              <button onClick={() => deleteCron(j.id, j.name)} style={{ background: 'none', border: 'none', color: '#e74c3c', cursor: 'pointer', fontSize: 13, padding: '2px 6px', borderRadius: 4 }} title="删除">✕</button>
                            </div>
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                            下次: {formatNextRun(j.nextRun)} · 消息: {j.prompt.slice(0, 50)}{j.prompt.length > 50 ? '…' : ''}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </Modal>
      )}

      {/* 删除定时任务确认 */}
      {cronDeleteTarget && (
        <Modal title="删除定时任务" onClose={() => setCronDeleteTarget(null)}>
          <p style={{ fontSize: 14, color: 'var(--text)', textAlign: 'center', padding: '12px 0 20px' }}>
            确定删除「{cronDeleteTarget.name}」？
          </p>
          <div className="modal-actions">
            <button className="btn-ghost" onClick={() => setCronDeleteTarget(null)}>取消</button>
            <button className="btn-primary" onClick={confirmDeleteCron} style={{ background: '#ff453a' }}>删除</button>
          </div>
        </Modal>
      )}

      {showWechat && (
        <Modal title="💚 微信连接" onClose={() => setShowWechat(false)} width={400}>
          {wechatStatus === 'idle' && (
            <div>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16, lineHeight: 1.6 }}>
                通过 OpenClaw 协议连接微信，扫码登录后即可在微信中与 Small Hermes 对话。
              </p>
              <div style={{ textAlign: 'center', marginBottom: 16 }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>💚</div>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 }}>点击下方按钮，终端将显示二维码</p>
                <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>用微信扫一扫登录</p>
              </div>
              <div className="modal-actions">
                <button className="btn-ghost" onClick={() => setShowWechat(false)}>取消</button>
                <button className="btn-primary" onClick={async () => {
                  setWechatStatus('connecting');
                  setWechatError('');
                  setWechatQRUrl('');
                  try {
                    const res = await fetch('/api/wechat/start', { method: 'POST' });
                    const data = await res.json();
                    if (data.success) {
                      // 后台开始连接，轮询等待结果（SSE 可能延迟）
                      for (let i = 0; i < 15; i++) {
                        await new Promise(r => setTimeout(r, 2000));
                        try {
                          const statusRes = await fetch('/api/wechat/status');
                          const status = await statusRes.json();
                          if (status.connected) {
                            setWechatStatus('connected');
                            setWechatQRUrl('');
                            return;
                          }
                        } catch {}
                      }
                    } else {
                      setWechatStatus('error');
                      setWechatError(data.error || '启动失败');
                    }
                  } catch (err: any) {
                    setWechatStatus('error');
                    setWechatError(err.message || '网络错误');
                  }
                }}>连接微信</button>
              </div>
            </div>
          )}

          {wechatStatus === 'connecting' && (
            <div style={{ textAlign: 'center' }}>
              {wechatQRUrl ? (
                <>
                  <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>请用微信扫一扫下方二维码登录</p>
                  <div style={{
                    display: 'inline-block', padding: 12, background: '#fff', borderRadius: 12,
                    marginBottom: 12, boxShadow: '0 2px 12px rgba(0,0,0,0.2)',
                  }}>
                    <WechatQRCanvas url={wechatQRUrl} />
                  </div>
                  <p style={{ fontSize: 12, color: '#ff9800', marginBottom: 8 }}>
                    ⏳ 等待扫码...
                  </p>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 48, marginBottom: 12, opacity: 0.5 }}>💚</div>
                  <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
                    正在连接微信...
                  </p>
                  <div className="thinking-dots" style={{ fontSize: 24, color: 'var(--text-muted)', marginBottom: 16 }}>
                    <span>●</span><span>●</span><span>●</span>
                  </div>
                </>
              )}
              <button className="btn-ghost" onClick={() => {
                setWechatStatus('idle');
                setWechatQRUrl('');
                fetch('/api/wechat/stop', { method: 'POST' }).catch(() => {});
              }}>取消</button>
            </div>
          )}

          {wechatStatus === 'connected' && (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
              <p style={{ fontSize: 15, fontWeight: 600, color: '#4caf50', marginBottom: 8 }}>微信已连接</p>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>
                现在可以在微信中与 Small Hermes 对话了
              </p>
              <div className="modal-actions" style={{ flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 10, width: '100%' }}>
                  <button className="btn-ghost" style={{ flex: 1 }} onClick={() => setShowWechat(false)}>关闭</button>
                  <button className="btn-danger" style={{ flex: 1 }} onClick={async () => {
                    try {
                      await fetch('/api/wechat/stop', { method: 'POST' });
                    } catch {}
                    setWechatStatus('idle');
                    setWechatQRUrl('');
                  }}>断开连接</button>
                </div>
                <button className="btn-primary" style={{ width: '100%' }} onClick={async () => {
                  setWechatError('');
                  setWechatQRUrl('');
                  setWechatStatus('connecting');
                  try {
                    const res = await fetch('/api/wechat/reset', { method: 'POST' });
                    const data = await res.json();
                    if (!data.success) {
                      setWechatStatus('error');
                      setWechatError(data.error || '重置失败');
                    }
                  } catch (err: any) {
                    setWechatStatus('error');
                    setWechatError(err.message || '网络错误');
                  }
                }}>🔄 切换账号</button>
              </div>
            </div>
          )}

          {wechatStatus === 'error' && (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>❌</div>
              <p style={{ fontSize: 14, color: '#e74c3c', marginBottom: 8 }}>连接失败</p>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>{wechatError}</p>
              <div className="modal-actions">
                <button className="btn-ghost" onClick={() => setShowWechat(false)}>关闭</button>
                <button className="btn-primary" onClick={() => {
                  setWechatStatus('idle');
                  setWechatError('');
                  setWechatQRUrl('');
                }}>重试</button>
              </div>
            </div>
          )}
        </Modal>
      )}

      {showAbout && (
        <Modal title="关于 Small Hermes" onClose={() => setShowAbout(false)}>
          <div style={{ textAlign: 'center', padding: '12px 0' }}>
            <AppIcon size={64} />
            <p style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>Small Hermes</p>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>v{VERSION}</p>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.8 }}>
              本地模型 · 飞书互通 · 无记忆直传
            </p>
          </div>
          <div className="modal-actions">
            <button className="btn-ghost" onClick={() => setShowAbout(false)}>关闭</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── 顶栏按钮（Apple 风格） ───
function HeaderBtn({ label, onClick }: { label: string; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: '4px 14px', borderRadius: 20, border: 'none',
        background: hover ? 'var(--elevated)' : 'transparent',
        color: hover ? 'var(--text)' : 'var(--text-secondary)',
        cursor: 'pointer', fontSize: 12, fontWeight: 500,
        transition: 'all 0.15s', whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}

// ─── 微信二维码画布 ───
function WechatQRCanvas({ url }: { url: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvasRef.current || !url) return;
    QRCode.toCanvas(canvasRef.current, url, { width: 220, margin: 1 }, (err) => {
      if (err) console.error('[QR] 渲染失败:', err);
    });
  }, [url]);
  if (!url) {
    return <div style={{ width: 220, height: 220, background: '#eee', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: '#999' }}>生成二维码中...</div>;
  }
  return <canvas ref={canvasRef} style={{ width: 220, height: 220, borderRadius: 8 }} />;
}

// ─── 设置菜单项 ───
function SettingItem({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%',
        padding: '8px 12px', borderRadius: 'var(--radius)', border: 'none',
        background: hover ? 'var(--accent-dim)' : 'transparent',
        color: hover ? 'var(--accent)' : 'var(--text)',
        cursor: 'pointer', fontSize: 13, transition: 'all 0.1s',
        textAlign: 'left',
      }}
    >
      <span style={{ fontSize: 15, flexShrink: 0 }}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}
