import { useState } from 'react';

// ─── 应用图标 ───
function AppIcon({ size = 32 }: { size?: number }) {
  return (
    <img src="/favicon.jpg" width={size} height={size} alt="Small Hermes" style={{
      borderRadius: size * 0.2, display: 'block',
    }} />
  );
}

// ─── 动物头像 ───
const ANIMALS = [
  { emoji: '🐱', name: '小猫' },
  { emoji: '🐶', name: '小狗' },
  { emoji: '🐰', name: '兔子' },
  { emoji: '🐼', name: '熊猫' },
  { emoji: '🦊', name: '狐狸' },
  { emoji: '🐸', name: '青蛙' },
  { emoji: '🐵', name: '猴子' },
  { emoji: '🦁', name: '狮子' },
  { emoji: '🐯', name: '老虎' },
  { emoji: '🐮', name: '奶牛' },
  { emoji: '🐷', name: '小猪' },
  { emoji: '🐹', name: '仓鼠' },
  { emoji: '🐻', name: '小熊' },
  { emoji: '🐨', name: '考拉' },
  { emoji: '🐲', name: '龙' },
  { emoji: '🦄', name: '独角兽' },
];

// ─── 登录页（Apple 风格） ───
function LoginPage({ onLogin }: { onLogin: (username: string, avatar: string) => void }) {
  const [username, setUsername] = useState('1');
  const [password, setPassword] = useState('1');
  const [avatar, setAvatar] = useState('🐱');
  const [error, setError] = useState('');

  const handleLogin = () => {
    if (username === '1' && password === '1') {
      setError('');
      onLogin(username, avatar);
    } else {
      setError('用户名或密码错误');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleLogin();
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100vh',
      background: 'linear-gradient(145deg, #1c1c1e 0%, #141416 100%)',
    }}>
      <div style={{
        width: 360, maxWidth: '90vw',
        animation: 'fadeIn 0.5s ease-out',
      }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
            <AppIcon size={80} />
          </div>
          <h1 style={{
            fontSize: 24, fontWeight: 700, color: '#f5f5f7',
            letterSpacing: '-0.5px', marginBottom: 4,
          }}>
            Small Hermes
          </h1>
          <p style={{ fontSize: 14, color: '#98989d' }}>
            本地模型 · 隐私优先
          </p>
        </div>

        {/* 卡片 */}
        <div style={{
          background: 'var(--frosted)',
          backdropFilter: 'blur(40px)',
          WebkitBackdropFilter: 'blur(40px)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', padding: '28px 24px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        }}>
          {/* 用户名 */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6, fontWeight: 500 }}>
              用户名
            </label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="用户名"
              style={{
                width: '100%', background: 'var(--elevated)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius)', padding: '11px 14px', color: 'var(--text)', fontSize: 15,
                fontFamily: 'inherit', outline: 'none', transition: 'border-color 0.2s',
              }}
              onFocus={(e) => { e.target.style.borderColor = 'var(--accent)'; }}
              onBlur={(e) => { e.target.style.borderColor = 'var(--border)'; }}
            />
          </div>

          {/* 密码 */}
          <div style={{ marginBottom: 24 }}>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6, fontWeight: 500 }}>
              密码
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="密码"
              style={{
                width: '100%', background: 'var(--elevated)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius)', padding: '11px 14px', color: 'var(--text)', fontSize: 15,
                fontFamily: 'inherit', outline: 'none', transition: 'border-color 0.2s',
              }}
              onFocus={(e) => { e.target.style.borderColor = '#007aff'; }}
              onBlur={(e) => { e.target.style.borderColor = 'var(--border)'; }}
            />
          </div>

          {error && (
            <p style={{ fontSize: 13, color: '#ff453a', marginBottom: 16, textAlign: 'center' }}>
              {error}
            </p>
          )}

          {/* 头像选择 */}
          <div style={{ marginBottom: 24 }}>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10, fontWeight: 500 }}>
              选择头像
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
              {ANIMALS.map((a) => (
                <button
                  key={a.emoji}
                  onClick={() => setAvatar(a.emoji)}
                  title={a.name}
                  style={{
                    background: avatar === a.emoji ? 'var(--accent-dim)' : 'var(--elevated)',
                    border: avatar === a.emoji ? '2px solid var(--accent)' : '1px solid var(--border)',
                    borderRadius: 'var(--radius)', padding: '8px 0', cursor: 'pointer',
                    fontSize: 24, transition: 'all 0.15s',
                  }}
                  onMouseEnter={(e) => { if (avatar !== a.emoji) e.currentTarget.style.borderColor = 'var(--text-muted)'; }}
                  onMouseLeave={(e) => { if (avatar !== a.emoji) e.currentTarget.style.borderColor = 'var(--border)'; }}
                >
                  {a.emoji}
                </button>
              ))}
            </div>
          </div>

          {/* 登录按钮 */}
          <button
            onClick={handleLogin}
            style={{
              width: '100%', background: 'var(--accent)', color: '#fff',
              border: 'none', borderRadius: 'var(--radius)', padding: '12px 0',
              fontSize: 15, fontWeight: 600, cursor: 'pointer',
              transition: 'opacity 0.2s, transform 0.1s',
              letterSpacing: '-0.2px',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.85'; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
            onMouseDown={(e) => { e.currentTarget.style.transform = 'scale(0.97)'; }}
            onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
          >
            进入
          </button>

          <p style={{ fontSize: 11, color: '#6c6c70', textAlign: 'center', marginTop: 16 }}>
            调试阶段 · 用户名和密码均为 1
          </p>
        </div>
      </div>
    </div>
  );
}

export default LoginPage;
