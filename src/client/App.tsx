import { useState, useRef, useEffect, useCallback } from 'react';
import { flushSync } from 'react-dom';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  stats?: { tokens: number; tps: number };
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
function ThinkingIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="4" />
    </svg>
  );
}

// ─── 弹窗 ───
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
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

  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const thinkingContainerRef = useRef<HTMLDivElement | null>(null);
  const [streamTick, setStreamTick] = useState(0);

  const activeConv = conversations.find((c) => c.id === activeId) || conversations[0];
  const messages = activeConv?.messages || [];

  // 持久化会话
  useEffect(() => {
    localStorage.setItem('hermes-convs', JSON.stringify(conversations));
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
        }
      } catch {}
    };
    return () => ev.close();
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
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

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading || !activeConv) return;

    const userMessage: Message = { role: 'user', content: text };
    const newMessages = [...messages, userMessage];
    updateConvMessages(activeConv.id, () => newMessages);
    setInput('');
    setLoading(true);
    if (inputRef.current) inputRef.current.style.height = 'auto';

    // 如果是第一条消息，用前几个字作为标题
    if (messages.length === 0) {
      const title = text.length > 20 ? text.slice(0, 20) + '…' : text;
      setConversations((prev) =>
        prev.map((c) => (c.id === activeConv.id ? { ...c, title } : c))
      );
    }

    updateConvMessages(activeConv.id, (prev) => [...prev, { role: 'assistant', content: '' }]);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: newMessages, model }),
      });
      if (!res.ok) throw new Error('请求失败');

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let assistantContent = '';
      let thinkingContent = '';
      let assistantStats: { tokens: number; tps: number } | undefined;

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
              if (parsed.content) {
                if (parsed.content.startsWith('__STATS__')) {
                  try { assistantStats = JSON.parse(parsed.content.slice(9)); } catch {}
                  continue;
                }
                assistantContent += parsed.content;
                hasUpdate = true;
              }
              if (parsed.thinking) {
                thinkingContent += parsed.thinking;
                hasUpdate = true;
              }
            } catch {}
          }
        }
        // 每收到一个完整的 SSE chunk，强制立即渲染
        if (hasUpdate) {
          flushSync(() => {
            updateConvMessages(activeConv.id, (prev) => {
              const updated = [...prev];
              updated[updated.length - 1] = { role: 'assistant', content: assistantContent, thinking: thinkingContent };
              return updated;
            });
            setStreamTick((n) => n + 1);
          });
          // 自动滚动到推理内容底部
          requestAnimationFrame(() => {
            thinkingContainerRef.current?.scrollTo(0, thinkingContainerRef.current.scrollHeight);
          });
        }
      }
      if (assistantStats) {
        updateConvMessages(activeConv.id, (prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: 'assistant', content: assistantContent, thinking: thinkingContent || undefined, stats: assistantStats };
          return updated;
        });
      }
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

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      {/* ═══ 左侧会话列表 ═══ */}
      <div className="conv-list">
        <button className="conv-new-btn" onClick={newConversation}>+ 新建对话</button>
        <div className="conv-items">
          {conversations.map((conv) => (
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

      {/* ═══ 主区域 ═══ */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* 顶栏 */}
        <header style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)',
          flexShrink: 0, gap: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 20 }}>🏛️</span>
            <h1 style={{ fontSize: 16, fontWeight: 600 }}>Small Hermes</h1>
            <span style={{
              fontSize: 11, color: 'var(--text-muted)', background: 'var(--border)',
              padding: '2px 8px', borderRadius: 6,
            }}>{model}</span>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <HeaderBtn icon={<IconModel />} label="模型" onClick={() => setShowModel(true)} />
            <HeaderBtn icon={<IconFeishu />} label="飞书" onClick={() => setShowFeishu(true)} />
            <HeaderBtn icon={<IconSearch />} label="搜索" onClick={() => setShowTavily(true)} />
            <HeaderBtn icon={<IconRestart />} label="重启" onClick={() => setShowRestart(true)} />
            <HeaderBtn icon={<IconAbout />} label="关于" onClick={() => setShowAbout(true)} />
          </div>
        </header>

        {/* 聊天区域 */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px', background: 'var(--bg-chat)' }}>
          {messages.length === 0 && (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', height: '100%', color: 'var(--text-muted)', gap: 12,
            }}>
              <span style={{ fontSize: 48 }}>🏛️</span>
              <p style={{ fontSize: 16 }}>Small Hermes — 本地模型，飞书互通</p>
              <p style={{ fontSize: 13 }}>输入消息开始对话</p>
            </div>
          )}

          {messages.map((msg, i) => {
            // 调试日志
            return (
            <div key={i} style={{
              display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start', marginBottom: 12,
            }}>
              <div style={{ maxWidth: '75%' }}>
                {msg.role === 'assistant' && (msg.thinking || streamTick > 0) && (
                  <details open style={{ marginBottom: 6 }}>
                    <summary
                      style={{
                        cursor: 'pointer', color: 'var(--text-muted)', fontSize: 12,
                        userSelect: 'none', padding: '2px 0', display: 'flex', alignItems: 'center', gap: 4,
                      }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <ThinkingIcon />
                        <span>推理过程</span>
                      </span>
                      <span style={{
                        marginLeft: 'auto', fontSize: 11, color: msg.content ? '#4caf50' : '#ff9800',
                      }}>
                        {msg.content ? '✓ 完成' : '● 进行中'}
                      </span>
                    </summary>
                    <div ref={thinkingContainerRef} style={{
                      fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg-secondary)',
                      padding: '8px 12px', marginTop: 4, borderRadius: '0 6px 6px 0',
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5,
                      maxHeight: '200px', overflow: 'auto',
                      border: '1px solid var(--border)', borderLeft: '3px solid #ff9800',
                    }}>
                      {msg.thinking ? msg.thinking : ''}
                    </div>
                    {msg.thinking && msg.thinking.length > 2000 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          e.currentTarget.parentElement!.querySelector('div')!.innerHTML = msg.thinking;
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
                <div style={{
                  padding: '10px 16px', borderRadius: 'var(--radius)',
                  background: msg.role === 'user' ? 'var(--user-bubble)' : 'var(--assistant-bubble)',
                  border: msg.role === 'assistant' ? '1px solid var(--border)' : 'none',
                  lineHeight: 1.6, fontSize: 14, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>
                  {msg.content ? msg.content : msg.role === 'assistant' && loading && i === messages.length - 1 ? (
                    <span className="thinking-dots" style={{ color: 'var(--text-muted)' }}>
                      <span>●</span><span>●</span><span>●</span>
                    </span>
                  ) : null}
                </div>
                {msg.role === 'assistant' && msg.stats && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, textAlign: 'right' }}>
                    {msg.stats.tokens} tokens · {msg.stats.tps} tok/s
                  </div>
                )}
              </div>
            </div>
          )})}
          <div ref={chatEndRef} />
        </div>

        {/* 输入区域 */}
        <div style={{
          padding: '16px 20px', borderTop: '1px solid var(--border)', background: 'var(--bg-secondary)', flexShrink: 0,
        }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', maxWidth: 800, margin: '0 auto' }}>
            <textarea
              ref={inputRef} value={input} onChange={handleInputChange} onKeyDown={handleKeyDown}
              placeholder={activeConv?.id === 'feishu' ? '飞书消息只读，请在飞书客户端回复' : '输入消息... (Enter 发送，Shift+Enter 换行)'}
              rows={1} disabled={loading || activeConv?.id === 'feishu'}
              style={{
                flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                padding: '10px 14px', color: 'var(--text)', fontSize: 14, resize: 'none', outline: 'none',
                fontFamily: 'inherit', lineHeight: 1.5, maxHeight: 160, overflow: 'hidden',
              }}
            />
            <button onClick={sendMessage} disabled={loading || !input.trim() || activeConv?.id === 'feishu'} style={{
              background: (loading || !input.trim() || activeConv?.id === 'feishu') ? 'var(--border)' : 'var(--accent)',
              color: '#fff', border: 'none', borderRadius: 'var(--radius)', padding: '10px 20px',
              cursor: loading ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 500, transition: 'background 0.2s',
            }}>
              发送
            </button>
          </div>
        </div>
      </div>

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
            <button className="btn-primary" onClick={() => { setShowRestart(false); fetch('/api/restart', { method: 'POST' }); }}>确认重启</button>
          </div>
        </Modal>
      )}

      {showAbout && (
        <Modal title="关于 Small Hermes" onClose={() => setShowAbout(false)}>
          <div style={{ textAlign: 'center', padding: '12px 0' }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>🏛️</div>
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

// ─── 顶栏按钮 ───
function HeaderBtn({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 5,
        padding: '5px 10px', borderRadius: 6, border: 'none',
        background: hover ? 'var(--border)' : 'transparent',
        color: 'var(--text-muted)', cursor: 'pointer',
        fontSize: 12, transition: 'all 0.15s',
      }}
    >
      {icon}
      {label}
    </button>
  );
}
