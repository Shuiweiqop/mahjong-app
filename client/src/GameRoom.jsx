import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import LobbySettings from './LobbySettings';
import DrawGuessGame from './DrawGuessGame';
import WerewolfGame from './WerewolfGame';
import { ui } from './ui';

// 房间路由器:管理通用的大厅(房间码/成员/设置/开始)与房间级 socket 事件
// (lobby / game_state / kicked),并按 gameId 把对局界面分发给各游戏组件。
// 新增游戏 = 写一个 <XxxGame> 组件 + 在下方 GAME_VIEWS 注册一行。
// props: socket(ref), roomCode, me{id,name}, onLeave
const GAME_VIEWS = {
  drawguess: DrawGuessGame,
  werewolf: WerewolfGame,
};

export default function GameRoom({ socket, roomCode, me, onLeave }) {
  const [lobby, setLobby] = useState(null);   // 未开始时的大厅信息
  const [state, setState] = useState(null);   // 对局状态视图(分角色)
  const [gameId, setGameId] = useState(null); // 房间的游戏类型
  const membersRef = useRef([]);

  // 房间级 socket 事件(通用):lobby / game_state / kicked
  useEffect(() => {
    const s = socket.current;
    if (!s) return;
    const onLobby = (l) => { membersRef.current = l.members || []; if (l.gameId) setGameId(l.gameId); setLobby(l); setState(null); };
    const onState = (st) => { if (st.players) membersRef.current = st.players; setState(st); setLobby(null); };
    const onKicked = () => { alert('你已被房主移出房间'); onLeave(); };
    s.on('lobby', onLobby);
    s.on('game_state', onState);
    s.on('kicked', onKicked);
    s.emit('sync'); // 监听器就绪后拉当前状态,避免错过首个广播(竞态)
    return () => { s.off('lobby', onLobby); s.off('game_state', onState); s.off('kicked', onKicked); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const members = state?.players || lobby?.members || [];
  const hostId = lobby?.hostId || state?.hostId;
  const minPlayers = lobby?.minPlayers ?? 2;
  const isHost = hostId === me.id;
  const joinUrl = `${window.location.origin}?room=${roomCode}`;

  const act = (action) => socket.current?.emit('game_action', { action }, (res) => {
    if (res?.error) alert(res.error);
  });

  // ── 大厅/等待:无进行中对局(state 缺失或仍 lobby 阶段)即显示大厅 ──
  if (!state || state.phase === 'lobby') {
    return (
      <div style={ui.wrap}>
        <TopBar roomCode={roomCode} onLeave={onLeave} />
        <div style={ui.card}>
          <div style={{ textAlign: 'center', marginBottom: 12 }}>
            <div style={{ background: '#fff', display: 'inline-block', padding: 10, borderRadius: 12 }}>
              <QRCodeSVG value={joinUrl} size={140} />
            </div>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 10 }}>扫码或用房间码 <b style={{ color: 'var(--accent)' }}>{roomCode}</b> 加入</p>
          </div>
        </div>
        <div style={ui.card}>
          <label style={ui.label}>玩家 ({members.length}/{lobby?.maxPlayers ?? 8})</label>
          {members.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 13 }}>连接中…</p>}
          {members.map((p) => (
            <div key={p.id} style={{ padding: '8px 0', display: 'flex', gap: 8, alignItems: 'center' }}>
              <span>{p.id === hostId ? '👑' : '🙂'}</span>
              <span>{p.name}{p.id === me.id ? ' (你)' : ''}</span>
              {isHost && p.id !== me.id && (
                <button
                  onClick={() => socket.current?.emit('kick_player', { playerId: p.id })}
                  style={{ marginLeft: 'auto', background: 'transparent', color: 'var(--danger)',
                    border: '1px solid var(--border)', borderRadius: 8, padding: '2px 10px',
                    cursor: 'pointer', fontSize: 12 }}>踢出</button>
              )}
            </div>
          ))}
        </div>

        <LobbySettings lobby={lobby} isHost={isHost}
          onChange={(config) => socket.current?.emit('set_config', { config })} />

        {isHost ? (
          <button style={{ ...ui.btnAccent, width: '100%' }} disabled={members.length < minPlayers}
            onClick={() => act({ type: 'start' })}>
            {members.length < minPlayers ? `至少需要 ${minPlayers} 人` : '开始游戏'}
          </button>
        ) : (
          <p style={{ textAlign: 'center', color: 'var(--muted)' }}>等待房主开始…</p>
        )}
      </div>
    );
  }

  // ── 对局中:按 gameId 分发给对应游戏组件 ──
  const GameView = GAME_VIEWS[gameId];
  return (
    <div style={ui.wrap}>
      <TopBar roomCode={roomCode} onLeave={onLeave} />
      {GameView
        ? <GameView state={state} act={act} me={me} socket={socket} onLeave={onLeave} />
        : <p style={{ color: 'var(--muted)', textAlign: 'center' }}>未知游戏类型:{gameId}</p>}
    </div>
  );
}

function TopBar({ roomCode, onLeave }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
      <button style={ui.btnGhost} onClick={onLeave}>← 离开</button>
      <span style={{ marginLeft: 'auto', ...ui.badge }}>房间 {roomCode}</span>
    </div>
  );
}
