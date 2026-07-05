import { useEffect, useState } from 'react';
import { API_BASE } from './config';
import { ui } from './ui';

// 大厅:选游戏 → 创建房间,或用房间码加入。
// props: me, connected, onCreate(gameId), onJoin(code), initialRoom, onLogout, onCalc
export default function Lobby({ me, connected, onCreate, onJoin, initialRoom, onLogout, onCalc }) {
  const [games, setGames] = useState([]);
  const [code, setCode] = useState(initialRoom || '');

  useEffect(() => {
    fetch(`${API_BASE}/api/games`).then((r) => r.json()).then(setGames).catch(() => {});
  }, []);

  // 若 URL 带 ?room=,自动聚焦加入
  useEffect(() => { if (initialRoom) setCode(initialRoom); }, [initialRoom]);

  return (
    <div style={ui.narrow}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 18, color: 'var(--primary-light)' }}>🎨 Playground</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {me.name} {connected ? '· 已连接' : '· 连接中…'}
          </div>
        </div>
        <button style={{ ...ui.btnGhost, marginLeft: 'auto' }} onClick={onLogout}>登出</button>
      </div>

      <label style={ui.label}>选择游戏</label>
      {games.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 13 }}>加载中…(确认后端已启动)</p>}
      {games.map((g) => (
        <div key={g.id} style={{ ...ui.card, display: 'flex', alignItems: 'center' }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 16 }}>🎨 {g.displayName}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>{g.minPlayers}-{g.maxPlayers} 人 · 实时多人</div>
          </div>
          <button style={{ ...ui.btnAccent, marginLeft: 'auto' }} disabled={!connected}
            onClick={() => onCreate(g.id)}>创建房间</button>
        </div>
      ))}

      <div style={ui.card}>
        <label style={ui.label}>用房间码加入</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={{ ...ui.input, marginBottom: 0, letterSpacing: 4, textTransform: 'uppercase' }}
            value={code} maxLength={6} placeholder="ABC123"
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === 'Enter' && code.length >= 4 && onJoin(code)} />
          <button style={ui.btn} disabled={!connected || code.length < 4} onClick={() => onJoin(code)}>加入</button>
        </div>
      </div>

      {/* 低调的工具入口(算法演示,非游戏门面) */}
      {onCalc && (
        <div style={{ textAlign: 'center', marginTop: 24 }}>
          <button onClick={onCalc}
            style={{ background: 'transparent', border: 'none', color: 'var(--muted)',
              fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }}>
            🀄 麻将番型计算器(算法工具)
          </button>
        </div>
      )}
    </div>
  );
}
