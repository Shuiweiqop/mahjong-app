import { useState, useEffect } from 'react';
import CalculatorScreen from './CalculatorScreen.jsx';
import RoomScreen from './RoomScreen.jsx';
import './index.css';

const BASE = 'https://mahjong-app-production.up.railway.app';
const api = {
  getSessions: () => fetch(`${BASE}/api/sessions`).then(r => r.json()),
  getSession: (id) => fetch(`${BASE}/api/sessions/${id}`).then(r => r.json()),
  createSession: (name, players) =>
    fetch(`${BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, players }),
    }).then(r => r.json()),
  addRound: (sessionId, scores) =>
    fetch(`${BASE}/api/sessions/${sessionId}/rounds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scores }),
    }).then(r => r.json()),
  deleteLastRound: (sessionId) =>
    fetch(`${BASE}/api/sessions/${sessionId}/rounds/last`, {
      method: 'DELETE',
    }).then(r => r.json()),
    deleteSession: (id) =>
  fetch(`${BASE}/api/sessions/${id}`, { method: 'DELETE' }).then(r => r.json()),
};

// ── Styles ──────────────────────────────────────────────
const s = {
  wrap: { maxWidth: 480, margin: '0 auto', padding: '20px 12px' },
  header: { textAlign: 'center', marginBottom: 32 },
  title: { fontSize: 32, color: 'var(--gold)', letterSpacing: 2 },
  sub: { color: 'var(--muted)', fontSize: 12, marginTop: 4 },
  btn: {
    background: 'var(--red)', color: '#fff', border: 'none',
    padding: '10px 20px', cursor: 'pointer', fontSize: 13,
    fontFamily: 'DM Mono, monospace', letterSpacing: 1,
  },
  btnGold: {
    background: 'var(--gold)', color: '#000', border: 'none',
    padding: '10px 20px', cursor: 'pointer', fontSize: 13,
    fontFamily: 'DM Mono, monospace', letterSpacing: 1,
  },
  btnGhost: {
    background: 'transparent', color: 'var(--muted)',
    border: '1px solid var(--border)', padding: '8px 16px',
    cursor: 'pointer', fontSize: 12, fontFamily: 'DM Mono, monospace',
  },
  card: {
    border: '1px solid var(--border)', padding: 16,
    marginBottom: 12, background: 'var(--surface)',
  },
  input: {
    background: 'var(--surface)', border: '1px solid var(--border)',
    color: 'var(--text)', padding: '10px 12px', width: '100%',
    fontSize: 16, fontFamily: 'DM Mono, monospace', marginBottom: 10,
  },
  label: { fontSize: 11, color: 'var(--muted)', letterSpacing: 1, marginBottom: 4, display: 'block' },
};

// ── Home Screen ─────────────────────────────────────────
function HomeScreen({ onNewGame, onOpenGame, onCalc, onRoom }) {
  const [sessions, setSessions] = useState([]);

  useEffect(() => {
    api.getSessions().then(setSessions);
  }, []);

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <h1 style={s.title}>🀄 麻将记分</h1>
        <p style={s.sub}>MAHJONG SCORE TRACKER</p>
      </div>

      <button style={{ ...s.btnGold, width: '100%', marginBottom: 10, padding: 14 }}
        onClick={onNewGame}>
        + 开新局
      </button>

      <button style={{ ...s.btnGhost, width: '100%', marginBottom: 10, padding: 14 }}
        onClick={onRoom}>
        🔗 房间模式（多人实时）
      </button>

      <button style={{ ...s.btnGhost, width: '100%', marginBottom: 24, padding: 14 }}
        onClick={onCalc}>
        🀄 番型计算器
      </button>

      {sessions.length === 0 ? (
        <p style={{ color: 'var(--muted)', textAlign: 'center', fontSize: 13 }}>还没有记录</p>
      ) : (
        sessions.map(s2 => (
          <div key={s2.id} style={{ ...s.card, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            {/* 点击进入游戏 */}
            <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => onOpenGame(s2.id)}>
              <div style={{ color: 'var(--text)', fontSize: 14 }}>
                {s2.name || `游戏 #${s2.id}`}
                {s2.room_code && (
                  <span style={{ fontSize: 10, color: 'var(--gold)', marginLeft: 8,
                    border: '1px solid var(--gold)', padding: '1px 6px' }}>
                    {s2.room_code}
                  </span>
                )}
              </div>
              <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 4 }}>
                {new Date(s2.created_at).toLocaleDateString('zh-CN')}
              </div>
            </div>

            {/* 右边：箭头 + 删除 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <span style={{ color: 'var(--gold)', fontSize: 18, cursor: 'pointer' }}
                onClick={() => onOpenGame(s2.id)}>›</span>
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  if (!confirm(`删除「${s2.name || '游戏 #' + s2.id}」？`)) return;
                  await api.deleteSession(s2.id);
                  setSessions(prev => prev.filter(x => x.id !== s2.id));
                }}
                style={{
                  background: 'transparent', border: 'none',
                  color: 'var(--muted)', cursor: 'pointer',
                  fontSize: 20, padding: '2px 6px', lineHeight: 1,
                }}
              >×</button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ── New Game Screen ──────────────────────────────────────
function NewGameScreen({ onBack, onCreated }) {
  const [name, setName] = useState('');
  const [players, setPlayers] = useState(['', '', '', '']);

  const handleCreate = async () => {
    const filled = players.filter(p => p.trim());
    if (filled.length < 2) return alert('至少填 2 个玩家');
    const res = await api.createSession(name || '新局', filled);
    onCreated(res.sessionId);
  };

  return (
    <div style={s.wrap}>
      <button style={s.btnGhost} onClick={onBack}>← 返回</button>
      <h2 style={{ color: 'var(--gold)', margin: '20px 0 24px', fontSize: 22 }}>开新局</h2>

      <label style={s.label}>游戏名称（可选）</label>
      <input style={s.input} value={name}
        onChange={e => setName(e.target.value)} placeholder="例：周五麻将" />

      <label style={{ ...s.label, marginTop: 8 }}>玩家名字</label>
      {players.map((p, i) => (
        <input key={i} style={s.input} value={p}
          placeholder={`玩家 ${i + 1}`}
          onChange={e => {
            const next = [...players];
            next[i] = e.target.value;
            setPlayers(next);
          }} />
      ))}

      <button style={{ ...s.btnGold, width: '100%', padding: 14, marginTop: 8 }}
        onClick={handleCreate}>
        开始游戏
      </button>
    </div>
  );
}

// ── Game Screen ──────────────────────────────────────────
function GameScreen({ sessionId, onBack }) {
  const [data, setData] = useState(null);
  const [scores, setScores] = useState({});
  const [adding, setAdding] = useState(false);

  const load = () => api.getSession(sessionId).then(d => {
    setData(d);
    const init = {};
    d.players.forEach(p => init[p.id] = '');
    setScores(init);
  });

  useEffect(() => { load(); }, [sessionId]);

  const handleAddRound = async () => {
    const entries = data.players.map(p => ({
      playerId: p.id,
      score: parseInt(scores[p.id]) || 0,
    }));
    await api.addRound(sessionId, entries);
    setAdding(false);
    load();
  };

  const handleUndo = async () => {
    if (!confirm('删除最后一局？')) return;
    await api.deleteLastRound(sessionId);
    load();
  };

  if (!data) return (
    <div style={{ ...s.wrap, textAlign: 'center', paddingTop: 60, color: 'var(--muted)' }}>
      加载中...
    </div>
  );

  const roundMap = {};
  data.rounds.forEach(r => {
    if (!roundMap[r.round_number]) roundMap[r.round_number] = {};
    roundMap[r.round_number][r.player_id] = r.score;
  });
  const roundNumbers = [...new Set(Object.keys(roundMap))].map(Number).sort((a, b) => a - b);

  return (
    <div style={s.wrap}>
      <button style={s.btnGhost} onClick={onBack}>← 返回</button>
      <h2 style={{ color: 'var(--gold)', margin: '16px 0 20px', fontSize: 20 }}>记分板</h2>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 20 }}>
        {data.players.map(p => {
          const total = data.totals[p.id] ?? 0;
          return (
            <div key={p.id} style={{ ...s.card, textAlign: 'center', padding: '16px 8px', marginBottom: 0 }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6, letterSpacing: 1 }}>
                {p.name}
              </div>
              <div style={{
                fontSize: 26, fontWeight: 'bold',
                color: total > 0 ? 'var(--gold-light)' : total < 0 ? 'var(--red)' : 'var(--muted)'
              }}>
                {total > 0 ? '+' : ''}{total}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <button style={{ ...s.btnGold, flex: 1 }} onClick={() => setAdding(!adding)}>
          {adding ? '取消' : '+ 记录本局'}
        </button>
        {roundNumbers.length > 0 && (
          <button style={s.btnGhost} onClick={handleUndo}>撤销</button>
        )}
      </div>

      {adding && (
        <div style={{ ...s.card, marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
            输入本局得分（可为负数）
          </div>
          {data.players.map(p => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
              <span style={{ width: 80, fontSize: 13, color: 'var(--text)', flexShrink: 0 }}>
                {p.name}
              </span>
              <input type="number" inputMode="numeric"
                style={{ ...s.input, marginBottom: 0, flex: 1, padding: '12px' }}
                value={scores[p.id]}
                onChange={e => setScores({ ...scores, [p.id]: e.target.value })}
                placeholder="0"
              />
            </div>
          ))}
          <button style={{ ...s.btn, width: '100%', marginTop: 8, padding: 14 }}
            onClick={handleAddRound}>
            确认记录
          </button>
        </div>
      )}

      {roundNumbers.length > 0 && (
        <>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8, letterSpacing: 1 }}>
            历史记录
          </div>
          <div style={{ border: '1px solid var(--border)', overflow: 'hidden' }}>
            <div style={{
              display: 'grid',
              gridTemplateColumns: `36px repeat(${data.players.length}, 1fr)`,
              background: 'var(--surface)', padding: '8px 12px'
            }}>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>#</span>
              {data.players.map(p => (
                <span key={p.id} style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center' }}>
                  {p.name}
                </span>
              ))}
            </div>
            {roundNumbers.map(rn => (
              <div key={rn} style={{
                display: 'grid',
                gridTemplateColumns: `36px repeat(${data.players.length}, 1fr)`,
                padding: '10px 12px', borderTop: '1px solid var(--border)'
              }}>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{rn}</span>
                {data.players.map(p => {
                  const sc = roundMap[rn][p.id] ?? 0;
                  return (
                    <span key={p.id} style={{
                      fontSize: 13, textAlign: 'center',
                      color: sc > 0 ? 'var(--gold-light)' : sc < 0 ? 'var(--red)' : 'var(--muted)'
                    }}>
                      {sc > 0 ? '+' : ''}{sc}
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── App ──────────────────────────────────────────────────
export default function App() {
  // 必须先定义 initialRoom，再用它初始化 useState
  const urlParams = new URLSearchParams(window.location.search);
  const initialRoom = urlParams.get('room');

  const [screen, setScreen] = useState(initialRoom ? 'room' : 'home');
  const [sessionId, setSessionId] = useState(null);

  // 删掉 useEffect，不再需要

  if (screen === 'calc') return (
    <CalculatorScreen onBack={() => setScreen('home')} />
  );

  if (screen === 'room') return (
    <RoomScreen
      onBack={() => setScreen('home')}
      initialRoom={initialRoom}
    />
  );

  if (screen === 'new') return (
    <NewGameScreen
      onBack={() => setScreen('home')}
      onCreated={id => { setSessionId(id); setScreen('game'); }}
    />
  );

  if (screen === 'game') return (
    <GameScreen
      sessionId={sessionId}
      onBack={() => setScreen('home')}
    />
  );

  return (
    <HomeScreen
      onNewGame={() => setScreen('new')}
      onOpenGame={id => { setSessionId(id); setScreen('game'); }}
      onCalc={() => setScreen('calc')}
      onRoom={() => setScreen('room')}
    />
  );
}