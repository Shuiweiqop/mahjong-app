import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import DrawCanvas from './DrawCanvas';
import LobbySettings from './LobbySettings';
import { ui } from './ui';

// 你画我猜房间。socket 已连接并已 create/join。
// props: socket(ref), roomCode, me(玩家 {id,name}), onLeave
export default function GameRoom({ socket, roomCode, me, onLeave }) {
  const [lobby, setLobby] = useState(null);   // 未开始时的成员列表
  const [state, setState] = useState(null);   // 对局状态视图
  const [messages, setMessages] = useState([]); // 聊天/系统消息
  const [guess, setGuess] = useState('');
  const [nowTs, setNowTs] = useState(Date.now());
  const strokeApi = useRef(null);
  const chatEndRef = useRef(null);
  const membersRef = useRef([]); // 最新成员列表(供 socket 回调闭包读取,避免陈旧闭包)

  // 每秒刷新一次用于倒计时显示
  useEffect(() => {
    const t = setInterval(() => setNowTs(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const s = socket.current;
    if (!s) return;

    const localName = (id) => membersRef.current.find((p) => p.id === id)?.name || '玩家';
    const onLobby = (l) => { membersRef.current = l.members || []; setLobby(l); setState(null); };
    const onState = (st) => {
      if (st.players) membersRef.current = st.players;
      setState(st);
      setLobby(null);
      // 补画:收到全量 strokes 时重绘(中途加入/换轮)
      if (strokeApi.current) strokeApi.current.redrawAll(st.strokes || []);
    };
    const onStroke = (strokes) => {
      // 收到一批笔画(或兼容单笔),逐笔重绘
      const arr = Array.isArray(strokes) ? strokes : [strokes];
      arr.forEach((s) => strokeApi.current?.applyRemoteStroke(s));
    };
    const onClear = () => strokeApi.current?.clear();
    const onChat = ({ playerId, text }) => addMsg(`${localName(playerId)}: ${text}`);
    const onGuessed = ({ playerId, points }) => addMsg(`✅ ${localName(playerId)} 猜中了! (+${points})`, 'success');
    const onReveal = ({ word }) => addMsg(`本轮答案是:${word}`, 'accent');
    const onGameOver = () => addMsg('🏁 游戏结束!', 'accent');

    s.on('lobby', onLobby);
    s.on('game_state', onState);
    s.on('stroke', onStroke);
    s.on('clear', onClear);
    s.on('chat', onChat);
    s.on('guessed', onGuessed);
    s.on('reveal', onReveal);
    s.on('game_over', onGameOver);
    // 监听器就绪后主动拉一次当前状态(修复:错过创建/加入时首个 lobby 广播的竞态)
    s.emit('sync');
    return () => {
      s.off('lobby', onLobby); s.off('game_state', onState); s.off('stroke', onStroke);
      s.off('clear', onClear); s.off('chat', onChat); s.off('guessed', onGuessed);
      s.off('reveal', onReveal); s.off('game_over', onGameOver);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const addMsg = (text, kind) => setMessages((m) => [...m.slice(-40), { text, kind, id: Math.random() }]);
  const members = state?.players || lobby?.members || [];
  const nameOf = (id) => members.find((p) => p.id === id)?.name || '玩家';

  const act = (action) => socket.current?.emit('game_action', { action }, (res) => {
    if (res?.error) addMsg('⚠️ ' + res.error, 'danger');
  });

  const sendGuess = () => {
    const t = guess.trim();
    if (!t) return;
    act({ type: 'guess', text: t });
    setGuess('');
  };

  const secondsLeft = state?.deadline ? Math.max(0, Math.ceil((state.deadline - nowTs) / 1000)) : null;
  const isDrawer = state?.isDrawer;
  const hostId = lobby?.hostId || state?.hostId;
  const minPlayers = lobby?.minPlayers ?? 2;
  const isHost = hostId === me.id;
  const joinUrl = `${window.location.origin}?room=${roomCode}`;

  // ── 大厅/等待(游戏未真正开始):只要没有进行中的对局(无 state 或仍 lobby 阶段)就显示大厅。
  // 这样即使 lobby 事件还没到(sync 延迟),也不会错误掉进空白游戏界面。
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
            </div>
          ))}
        </div>

        <LobbySettings
          lobby={lobby}
          isHost={isHost}
          onChange={(config) => socket.current?.emit('set_config', { config })}
        />

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

  // ── 结束排行榜 ──
  if (state?.phase === 'ended') {
    return (
      <div style={ui.wrap}>
        <TopBar roomCode={roomCode} onLeave={onLeave} />
        <div style={ui.card}>
          <h2 style={{ textAlign: 'center', marginBottom: 16 }}>🏁 最终排名</h2>
          {(state.ranking || []).map((p, i) => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
              <span>{['🥇', '🥈', '🥉'][i] || `${i + 1}.`} {p.name}</span>
              <b style={{ color: 'var(--accent)' }}>{p.score}</b>
            </div>
          ))}
        </div>
        <button style={{ ...ui.btnGhost, width: '100%' }} onClick={onLeave}>返回大厅</button>
      </div>
    );
  }

  // ── 对局中(pick / draw / reveal) ──
  const wordHint = () => {
    if (state?.word) return state.word;               // 画手 or 已猜中
    if (state?.wordLength) return Array(state.wordLength).fill('＿').join(' ');
    return '';
  };

  return (
    <div style={ui.wrap}>
      <TopBar roomCode={roomCode} onLeave={onLeave} />

      {/* 状态条 */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={ui.badge}>第 {(state?.roundsDone ?? 0) + 1}/{state?.roundsTotal} 轮</span>
        {secondsLeft !== null && <span style={{ ...ui.badge, color: secondsLeft <= 10 ? 'var(--danger)' : 'var(--muted)' }}>⏱ {secondsLeft}s</span>}
        <span style={ui.badge}>✏️ {nameOf(state?.drawerId)} {isDrawer ? '(你)' : ''}</span>
        <span style={{ marginLeft: 'auto', fontSize: 20, letterSpacing: 4, fontWeight: 800, color: 'var(--text)' }}>{wordHint()}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 240px', gap: 14 }}>
        {/* 左:画布 + 选词 */}
        <div>
          {state?.phase === 'pick' && isDrawer ? (
            <div style={{ ...ui.card, textAlign: 'center' }}>
              <p style={{ marginBottom: 12, fontWeight: 700 }}>选一个词来画:</p>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
                {(state.wordChoices || []).map((w) => (
                  <button key={w} style={ui.btnAccent} onClick={() => act({ type: 'pick', word: w })}>{w}</button>
                ))}
              </div>
            </div>
          ) : state?.phase === 'pick' ? (
            <div style={{ ...ui.card, textAlign: 'center', color: 'var(--muted)' }}>
              {nameOf(state?.drawerId)} 正在选词…
            </div>
          ) : (
            <DrawCanvas
              canDraw={isDrawer && state?.phase === 'draw'}
              onStroke={(strokes) => act({ type: 'stroke', strokes })}
              onClear={() => act({ type: 'clear' })}
              strokeApiRef={strokeApi}
            />
          )}
        </div>

        {/* 右:计分 + 聊天/猜词 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ ...ui.card, marginBottom: 0, padding: 12 }}>
            <label style={ui.label}>计分板</label>
            {[...members].sort((a, b) => (state?.scores?.[b.id] || 0) - (state?.scores?.[a.id] || 0)).map((p) => (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '3px 0',
                color: state?.guessed?.includes(p.id) ? 'var(--success)' : 'var(--text)' }}>
                <span>{p.id === state?.drawerId ? '✏️' : state?.guessed?.includes(p.id) ? '✅' : '·'} {p.name}</span>
                <b>{state?.scores?.[p.id] || 0}</b>
              </div>
            ))}
          </div>

          <div style={{ ...ui.card, marginBottom: 0, padding: 12, flex: 1, display: 'flex', flexDirection: 'column', minHeight: 200 }}>
            <div style={{ flex: 1, overflowY: 'auto', maxHeight: 220, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {messages.map((m) => (
                <div key={m.id} style={{ color: m.kind === 'success' ? 'var(--success)' : m.kind === 'danger' ? 'var(--danger)' : m.kind === 'accent' ? 'var(--accent)' : 'var(--muted)' }}>{m.text}</div>
              ))}
              <div ref={chatEndRef} />
            </div>
            {!isDrawer && state?.phase === 'draw' && !state?.guessed?.includes(me.id) && (
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <input style={{ ...ui.input, marginBottom: 0 }} value={guess} placeholder="输入你的猜测…"
                  onChange={(e) => setGuess(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendGuess()} />
                <button style={ui.btn} onClick={sendGuess}>猜</button>
              </div>
            )}
          </div>
        </div>
      </div>
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
