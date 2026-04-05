import { useState, useEffect, useCallback, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { io } from 'socket.io-client';

const BASE = 'http://localhost:3001';

// ── Styles ───────────────────────────────────────────────
const s = {
  wrap: { maxWidth: 480, margin: '0 auto', padding: '20px 12px' },
  backBtn: {
    background: 'transparent', color: 'var(--muted)',
    border: '1px solid var(--border)', padding: '7px 14px',
    cursor: 'pointer', fontSize: 12, fontFamily: 'DM Mono, monospace', marginBottom: 20,
  },
  title: { color: 'var(--gold)', fontSize: 22, marginBottom: 4, fontFamily: 'Noto Serif SC, serif' },
  sub: { color: 'var(--muted)', fontSize: 11, letterSpacing: 1, marginBottom: 20 },

  tabs: { display: 'flex', border: '1px solid var(--border)', marginBottom: 20 },
  tab: (active) => ({
    flex: 1, padding: '10px 0', textAlign: 'center', cursor: 'pointer',
    fontSize: 12, letterSpacing: 1, fontFamily: 'DM Mono, monospace',
    background: active ? 'var(--gold)' : 'var(--surface)',
    color: active ? '#000' : 'var(--muted)', border: 'none',
  }),

  card: { border: '1px solid var(--border)', padding: 16, marginBottom: 12, background: 'var(--surface)' },
  input: {
    background: 'var(--surface)', border: '1px solid var(--border)',
    color: 'var(--text)', padding: '12px', width: '100%',
    fontSize: 16, fontFamily: 'DM Mono, monospace', marginBottom: 10,
    outline: 'none',
  },
  label: { fontSize: 11, color: 'var(--muted)', letterSpacing: 1, marginBottom: 4, display: 'block' },
  btnGold: {
    background: 'var(--gold)', color: '#000', border: 'none',
    padding: '12px 20px', cursor: 'pointer', fontSize: 13,
    fontFamily: 'DM Mono, monospace', letterSpacing: 1, width: '100%',
  },
  btnRed: {
    background: 'var(--red)', color: '#fff', border: 'none',
    padding: '12px 20px', cursor: 'pointer', fontSize: 13,
    fontFamily: 'DM Mono, monospace', letterSpacing: 1, width: '100%',
  },
  btnGhost: {
    background: 'transparent', color: 'var(--muted)',
    border: '1px solid var(--border)', padding: '8px 16px',
    cursor: 'pointer', fontSize: 12, fontFamily: 'DM Mono, monospace',
  },

  // room code display
  roomCodeBox: {
    textAlign: 'center', padding: '20px 16px',
    border: '1px solid var(--gold)', background: '#1a1200', marginBottom: 16,
  },
  roomCodeLabel: { fontSize: 11, color: 'var(--muted)', letterSpacing: 2, marginBottom: 8 },
  roomCode: {
    fontSize: 40, fontWeight: 'bold', color: 'var(--gold-light)',
    fontFamily: 'DM Mono, monospace', letterSpacing: 8,
  },
  qrWrap: {
    display: 'flex', justifyContent: 'center', padding: 16,
    background: '#fff', marginBottom: 16,
  },

  // scoreboard
  scoreGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)',
    gap: 8, marginBottom: 16,
  },
  scoreCard: {
    border: '1px solid var(--border)', padding: '14px 8px',
    background: 'var(--surface)', textAlign: 'center',
  },
  playerName: { fontSize: 11, color: 'var(--muted)', marginBottom: 6, letterSpacing: 1 },
  playerScore: (score) => ({
    fontSize: 26, fontWeight: 'bold', fontFamily: 'DM Mono, monospace',
    color: score > 0 ? 'var(--gold-light)' : score < 0 ? 'var(--red)' : 'var(--muted)',
  }),

  // history
  historyTable: { border: '1px solid var(--border)', overflow: 'hidden', marginBottom: 16 },
  historyHeader: { background: 'var(--surface)', padding: '8px 12px' },
  historyRow: { padding: '10px 12px', borderTop: '1px solid var(--border)' },

  // live badge
  liveBadge: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    background: '#1a0000', border: '1px solid var(--red)',
    padding: '4px 10px', fontSize: 11, color: 'var(--red)',
    fontFamily: 'DM Mono, monospace', marginBottom: 16,
  },
  liveDot: {
    width: 6, height: 6, borderRadius: '50%',
    background: 'var(--red)', animation: 'pulse 1.5s infinite',
  },

  error: {
    color: 'var(--red)', fontSize: 13, padding: '10px 12px',
    border: '1px solid var(--red)', background: '#1a0000', marginBottom: 12,
  },
};

// ── Create Room ──────────────────────────────────────────
function CreateRoom({ onCreated }) {
  const [name, setName] = useState('');
  const [players, setPlayers] = useState(['', '', '', '']);
  const [loading, setLoading] = useState(false);

  const handleCreate = async () => {
    const filled = players.filter(p => p.trim());
    if (filled.length < 2) return alert('至少填 2 个玩家');
    setLoading(true);
    try {
      const res = await fetch(`${BASE}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name || '新局', players: filled }),
      }).then(r => r.json());
      onCreated(res.sessionId, res.roomCode);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
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

      <button style={s.btnGold} onClick={handleCreate} disabled={loading}>
        {loading ? '创建中...' : '创建房间'}
      </button>
    </div>
  );
}

// ── Join Room ────────────────────────────────────────────
function JoinRoom({ onJoined }) {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleJoin = async () => {
    if (code.trim().length < 4) return;
    setLoading(true); setError('');
    try {
      const res = await fetch(`${BASE}/api/rooms/${code.trim().toUpperCase()}`).then(r => r.json());
      if (res.error) { setError(res.error); return; }
      onJoined(res.sessionId, res.roomCode);
    } catch {
      setError('连接失败，请检查网络');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <label style={s.label}>输入房间码</label>
      <input style={{ ...s.input, fontSize: 24, letterSpacing: 8, textTransform: 'uppercase' }}
        value={code} maxLength={6}
        onChange={e => setCode(e.target.value.toUpperCase())}
        placeholder="ABC123"
      />
      {error && <div style={s.error}>{error}</div>}
      <button style={s.btnGold} onClick={handleJoin} disabled={loading || code.length < 4}>
        {loading ? '加入中...' : '加入房间'}
      </button>
    </div>
  );
}

// ── Room Scoreboard (live) ───────────────────────────────
function RoomScoreboard({ sessionId, roomCode, onBack }) {
  const [data, setData] = useState(null);
  const [scores, setScores] = useState({});
  const [adding, setAdding] = useState(false);
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);

  // 加载初始数据
  const load = useCallback(() => {
    fetch(`${BASE}/api/sessions/${sessionId}`)
      .then(r => r.json())
      .then(d => {
        setData(d);
        const init = {};
        d.players.forEach(p => init[p.id] = '');
        setScores(init);
      });
  }, [sessionId]);

 useEffect(() => {
  load();

  const sock = io(BASE);
  socketRef.current = sock;  // 用 ref，不用 setState

  sock.on('connect', () => {
    setConnected(true);
    sock.emit('join_room', roomCode);
  });

  sock.on('disconnect', () => setConnected(false));

  sock.on('score_updated', (newData) => {
    setData(newData);
    const init = {};
    newData.players.forEach(p => init[p.id] = '');
    setScores(init);
    setAdding(false);
  });

  return () => {
    sock.emit('leave_room', roomCode);
    sock.disconnect();
  };
}, [sessionId, roomCode, load]);

  const handleAddRound = async () => {
    const entries = data.players.map(p => ({
      playerId: p.id,
      score: parseInt(scores[p.id]) || 0,
    }));
    await fetch(`${BASE}/api/sessions/${sessionId}/rounds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scores: entries }),
    });
    // 不需要手动 load()，socket 会推送更新
  };

  const handleUndo = async () => {
    if (!confirm('删除最后一局？')) return;
    await fetch(`${BASE}/api/sessions/${sessionId}/rounds/last`, { method: 'DELETE' });
  };

  if (!data) return (
    <div style={{ textAlign: 'center', paddingTop: 60, color: 'var(--muted)' }}>加载中...</div>
  );

  const roundMap = {};
  data.rounds.forEach(r => {
    if (!roundMap[r.round_number]) roundMap[r.round_number] = {};
    roundMap[r.round_number][r.player_id] = r.score;
  });
  const roundNumbers = [...new Set(Object.keys(roundMap))].map(Number).sort((a, b) => a - b);

  const joinUrl = `${window.location.origin}?room=${roomCode}`;

  return (
    <div style={s.wrap}>
      <button style={s.backBtn} onClick={onBack}>← 返回</button>

      {/* 房间码 + 二维码 */}
      <div style={s.roomCodeBox}>
        <div style={s.roomCodeLabel}>ROOM CODE</div>
        <div style={s.roomCode}>{roomCode}</div>
      </div>

      <div style={s.qrWrap}>
        <QRCodeSVG value={joinUrl} size={160} />
      </div>

      <p style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', marginBottom: 16 }}>
        朋友扫码或输入房间码加入
      </p>

      {/* 实时状态 */}
      <div style={s.liveBadge}>
        <div style={s.liveDot} />
        {connected ? `LIVE · 房间 ${roomCode}` : '连接中...'}
      </div>

      {/* 总分 */}
      <div style={s.scoreGrid}>
        {data.players.map(p => {
          const total = data.totals[p.id] ?? 0;
          return (
            <div key={p.id} style={s.scoreCard}>
              <div style={s.playerName}>{p.name}</div>
              <div style={s.playerScore(total)}>
                {total > 0 ? '+' : ''}{total}
              </div>
            </div>
          );
        })}
      </div>

      {/* 操作 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button style={{ ...s.btnGold, width: 'auto', flex: 1, padding: '10px' }}
          onClick={() => setAdding(!adding)}>
          {adding ? '取消' : '+ 记录本局'}
        </button>
        {roundNumbers.length > 0 && (
          <button style={s.btnGhost} onClick={handleUndo}>撤销</button>
        )}
      </div>

      {/* 输入分数 */}
      {adding && (
        <div style={{ ...s.card, marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
            输入本局得分
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
          <button style={{ ...s.btnRed, marginTop: 8 }} onClick={handleAddRound}>
            确认记录
          </button>
        </div>
      )}

      {/* 历史记录 */}
      {roundNumbers.length > 0 && (
        <>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8, letterSpacing: 1 }}>
            历史记录
          </div>
          <div style={s.historyTable}>
            <div style={{
              ...s.historyHeader,
              display: 'grid',
              gridTemplateColumns: `36px repeat(${data.players.length}, 1fr)`,
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
                ...s.historyRow,
                display: 'grid',
                gridTemplateColumns: `36px repeat(${data.players.length}, 1fr)`,
              }}>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{rn}</span>
                {data.players.map(p => {
                  const sc = roundMap[rn][p.id] ?? 0;
                  return (
                    <span key={p.id} style={{
                      fontSize: 13, textAlign: 'center',
                      color: sc > 0 ? 'var(--gold-light)' : sc < 0 ? 'var(--red)' : 'var(--muted)',
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

// ── Main RoomScreen ──────────────────────────────────────
export default function RoomScreen({ onBack, initialRoom }) {
  const [tab, setTab] = useState(initialRoom ? 'join' : 'create');
  const [roomData, setRoomData] = useState(
    initialRoom ? { sessionId: null, roomCode: initialRoom, joining: true } : null
  );

  // 如果 URL 带有 ?room=XXX，自动填入
  useEffect(() => {
    if (initialRoom) {
      fetch(`${BASE}/api/rooms/${initialRoom}`)
        .then(r => r.json())
        .then(res => {
          if (!res.error) setRoomData({ sessionId: res.sessionId, roomCode: res.roomCode });
        });
    }
  }, [initialRoom]);

  if (roomData?.sessionId) {
    return (
      <RoomScoreboard
        sessionId={roomData.sessionId}
        roomCode={roomData.roomCode}
        onBack={() => setRoomData(null)}
      />
    );
  }

  return (
    <div style={s.wrap}>
      <button style={s.backBtn} onClick={onBack}>← 返回</button>
      <h2 style={s.title}>房间系统</h2>
      <p style={{ ...s.sub }}>ROOM · REAL-TIME SYNC</p>

      <div style={s.tabs}>
        <button style={s.tab(tab === 'create')} onClick={() => setTab('create')}>
          创建房间
        </button>
        <button style={s.tab(tab === 'join')} onClick={() => setTab('join')}>
          加入房间
        </button>
      </div>

      {tab === 'create' ? (
        <CreateRoom onCreated={(sessionId, roomCode) => setRoomData({ sessionId, roomCode })} />
      ) : (
        <JoinRoom onJoined={(sessionId, roomCode) => setRoomData({ sessionId, roomCode })} />
      )}
    </div>
  );
}