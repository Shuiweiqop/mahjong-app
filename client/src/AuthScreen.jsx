import { useState } from 'react';

const BASE = 'https://mahjong-app-production.up.railway.app';

const s = {
  wrap: { maxWidth: 400, margin: '0 auto', padding: '40px 16px' },
  header: { textAlign: 'center', marginBottom: 32 },
  title: { fontSize: 32, color: 'var(--gold)', letterSpacing: 2 },
  sub: { color: 'var(--muted)', fontSize: 12, marginTop: 4 },
  tabs: { display: 'flex', border: '1px solid var(--border)', marginBottom: 24 },
  tab: (active) => ({
    flex: 1, padding: '10px 0', textAlign: 'center', cursor: 'pointer',
    fontSize: 12, letterSpacing: 1, fontFamily: 'DM Mono, monospace',
    background: active ? 'var(--gold)' : 'var(--surface)',
    color: active ? '#000' : 'var(--muted)', border: 'none',
  }),
  label: { fontSize: 11, color: 'var(--muted)', letterSpacing: 1, marginBottom: 4, display: 'block' },
  input: {
    background: 'var(--surface)', border: '1px solid var(--border)',
    color: 'var(--text)', padding: '12px', width: '100%',
    fontSize: 16, fontFamily: 'DM Mono, monospace', marginBottom: 12,
    outline: 'none',
  },
  btnGold: {
    background: 'var(--gold)', color: '#000', border: 'none',
    padding: 14, width: '100%', cursor: 'pointer', fontSize: 13,
    fontFamily: 'DM Mono, monospace', letterSpacing: 1, marginBottom: 12,
  },
  error: {
    color: 'var(--red)', fontSize: 13, padding: '10px 12px',
    border: '1px solid var(--red)', background: '#1a0000', marginBottom: 12,
  },
  skip: {
    textAlign: 'center', color: 'var(--muted)', fontSize: 12,
    cursor: 'pointer', textDecoration: 'underline', marginTop: 8,
  },
};

export default function AuthScreen({ onLogin, onSkip }) {
  const [tab, setTab] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    setError('');
    setLoading(true);
    try {
      const endpoint = tab === 'login' ? '/api/auth/login' : '/api/auth/register';
      const body = tab === 'login'
        ? { email, password }
        : { email, password, name };

      const res = await fetch(`${BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(r => r.json());

      if (res.error) {
        setError(res.error);
        return;
      }

      localStorage.setItem('token', res.token);
      localStorage.setItem('user', JSON.stringify(res.user));
      onLogin(res.user);
    } catch {
      setError('连接失败，请检查网络');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <h1 style={s.title}>🀄 麻将记分</h1>
        <p style={s.sub}>MAHJONG SCORE TRACKER</p>
      </div>

      <div style={s.tabs}>
        <button style={s.tab(tab === 'login')} onClick={() => { setTab('login'); setError(''); }}>
          登录
        </button>
        <button style={s.tab(tab === 'register')} onClick={() => { setTab('register'); setError(''); }}>
          注册
        </button>
      </div>

      {tab === 'register' && (
        <>
          <label style={s.label}>名字</label>
          <input style={s.input} value={name}
            onChange={e => setName(e.target.value)} placeholder="你的名字" />
        </>
      )}

      <label style={s.label}>邮箱</label>
      <input style={s.input} type="email" value={email}
        onChange={e => setEmail(e.target.value)} placeholder="email@example.com" />

      <label style={s.label}>密码</label>
      <input style={s.input} type="password" value={password}
        onChange={e => setPassword(e.target.value)} placeholder="••••••••"
        onKeyDown={e => e.key === 'Enter' && handleSubmit()}
      />

      {error && <div style={s.error}>{error}</div>}

      <button style={s.btnGold} onClick={handleSubmit} disabled={loading}>
        {loading ? '请稍候...' : tab === 'login' ? '登录' : '注册'}
      </button>

      {onSkip && (
        <div style={s.skip} onClick={onSkip}>
          暂时不登录，继续使用
        </div>
      )}
    </div>
  );
}
