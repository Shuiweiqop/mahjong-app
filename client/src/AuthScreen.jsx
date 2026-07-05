import { useState } from 'react';
import { API_BASE } from './config';
import { ui } from './ui';

export default function AuthScreen({ onLogin, onGuest }) {
  const [tab, setTab] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [guestName, setGuestName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setError(''); setLoading(true);
    try {
      const endpoint = tab === 'login' ? '/api/auth/login' : '/api/auth/register';
      const body = tab === 'login' ? { email, password } : { email, password, name };
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json());
      if (res.error) { setError(res.error); return; }
      localStorage.setItem('token', res.token);
      localStorage.setItem('user', JSON.stringify(res.user));
      onLogin(res.user, res.token);
    } catch {
      setError('连接失败,请确认后端已启动');
    } finally { setLoading(false); }
  };

  const tabStyle = (active) => ({
    flex: 1, padding: '10px 0', textAlign: 'center', cursor: 'pointer',
    fontSize: 14, fontWeight: 700, borderRadius: 8, border: 'none',
    background: active ? 'var(--primary)' : 'transparent',
    color: active ? '#fff' : 'var(--muted)',
  });

  return (
    <div style={ui.narrow}>
      <div style={ui.header}>
        <h1 style={ui.title}>🎨 Playground</h1>
        <p style={ui.sub}>多人实时游戏平台</p>
      </div>

      <div style={{ ...ui.card }}>
        <div style={{ display: 'flex', gap: 6, background: 'var(--surface-2)', borderRadius: 10, padding: 4, marginBottom: 18 }}>
          <button style={tabStyle(tab === 'login')} onClick={() => { setTab('login'); setError(''); }}>登录</button>
          <button style={tabStyle(tab === 'register')} onClick={() => { setTab('register'); setError(''); }}>注册</button>
        </div>

        {tab === 'register' && (
          <>
            <label style={ui.label}>昵称</label>
            <input style={ui.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="你的名字" />
          </>
        )}
        <label style={ui.label}>邮箱</label>
        <input style={ui.input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@example.com" />
        <label style={ui.label}>密码</label>
        <input style={ui.input} type="password" value={password} onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••" onKeyDown={(e) => e.key === 'Enter' && submit()} />

        {error && <div style={ui.error}>{error}</div>}

        <button style={{ ...ui.btn, width: '100%' }} onClick={submit} disabled={loading}>
          {loading ? '请稍候…' : tab === 'login' ? '登录' : '注册'}
        </button>
      </div>

      <div style={{ ...ui.card, textAlign: 'center' }}>
        <label style={ui.label}>或者直接以访客身份进入</label>
        <input style={ui.input} value={guestName} onChange={(e) => setGuestName(e.target.value)}
          placeholder="输入昵称" maxLength={12} onKeyDown={(e) => e.key === 'Enter' && guestName.trim() && onGuest(guestName.trim())} />
        <button style={{ ...ui.btnGhost, width: '100%' }} disabled={!guestName.trim()}
          onClick={() => guestName.trim() && onGuest(guestName.trim())}>
          以访客身份玩
        </button>
      </div>
    </div>
  );
}
