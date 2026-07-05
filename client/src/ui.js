// 共享内联样式 —— 中性游戏平台风格,各组件复用,保持一致。
export const ui = {
  wrap: { maxWidth: 900, margin: '0 auto', padding: '20px 16px' },
  narrow: { maxWidth: 420, margin: '0 auto', padding: '40px 16px' },
  header: { textAlign: 'center', marginBottom: 28 },
  title: { fontSize: 30, color: 'var(--primary-light)', letterSpacing: 0.5 },
  sub: { color: 'var(--muted)', fontSize: 13, marginTop: 6 },
  card: {
    border: '1px solid var(--border)', borderRadius: 14, padding: 18,
    marginBottom: 14, background: 'var(--surface)',
  },
  btn: {
    background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 10,
    padding: '12px 20px', cursor: 'pointer', fontSize: 15, fontWeight: 700,
  },
  btnAccent: {
    background: 'var(--accent)', color: '#3a2600', border: 'none', borderRadius: 10,
    padding: '12px 20px', cursor: 'pointer', fontSize: 15, fontWeight: 800,
  },
  btnGhost: {
    background: 'transparent', color: 'var(--muted)', border: '1px solid var(--border)',
    borderRadius: 10, padding: '10px 16px', cursor: 'pointer', fontSize: 14, fontWeight: 600,
  },
  input: {
    background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10,
    color: 'var(--text)', padding: '12px 14px', width: '100%', fontSize: 16,
    marginBottom: 12, outline: 'none',
  },
  label: { fontSize: 12, color: 'var(--muted)', fontWeight: 700, marginBottom: 6, display: 'block', letterSpacing: 0.5 },
  error: {
    color: 'var(--danger)', fontSize: 14, padding: '10px 12px', borderRadius: 10,
    border: '1px solid var(--danger)', background: 'rgba(255,107,107,0.08)', marginBottom: 12,
  },
  badge: {
    display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--surface-2)',
    borderRadius: 999, padding: '4px 12px', fontSize: 12, color: 'var(--muted)', fontWeight: 700,
  },
};
