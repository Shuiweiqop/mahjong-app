import { useEffect, useRef, useState } from 'react';
import DrawCanvas from './DrawCanvas';
import { ui } from './ui';

// 你画我猜对局界面(进行中/结束)。
// props: state(视图), act(action=>void), me{id,name}, socket(ref,用于绑定笔画/聊天事件), onLeave
// 该组件自行订阅 stroke/clear/chat/guessed/reveal 等你画我猜专属 socket 事件。
export default function DrawGuessGame({ state, act, me, socket, onLeave }) {
  const [messages, setMessages] = useState([]);
  const [guess, setGuess] = useState('');
  const [nowTs, setNowTs] = useState(Date.now());
  const strokeApi = useRef(null);
  const chatEndRef = useRef(null);
  const membersRef = useRef(state?.players || []);
  membersRef.current = state?.players || membersRef.current;

  const addMsg = (text, kind) => setMessages((m) => [...m.slice(-40), { text, kind, id: Math.random() }]);

  useEffect(() => {
    const t = setInterval(() => setNowTs(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  // 订阅你画我猜专属 socket 事件(笔画/清空/聊天/猜中/揭晓)
  useEffect(() => {
    const s = socket.current;
    if (!s) return;
    const nameOf = (id) => membersRef.current.find((p) => p.id === id)?.name || '玩家';
    const onStroke = (strokes) => {
      const arr = Array.isArray(strokes) ? strokes : [strokes];
      arr.forEach((st) => strokeApi.current?.applyRemoteStroke(st));
    };
    const onClear = () => strokeApi.current?.clear();
    const onChat = ({ playerId, text }) => addMsg(`${nameOf(playerId)}: ${text}`);
    const onGuessed = ({ playerId, points }) => addMsg(`✅ ${nameOf(playerId)} 猜中了! (+${points})`, 'success');
    const onReveal = ({ word }) => addMsg(`本轮答案是:${word}`, 'accent');
    const onGameOver = () => addMsg('🏁 游戏结束!', 'accent');
    s.on('stroke', onStroke); s.on('clear', onClear); s.on('chat', onChat);
    s.on('guessed', onGuessed); s.on('reveal', onReveal); s.on('game_over', onGameOver);
    return () => {
      s.off('stroke', onStroke); s.off('clear', onClear); s.off('chat', onChat);
      s.off('guessed', onGuessed); s.off('reveal', onReveal); s.off('game_over', onGameOver);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  // 补画:只在服务端真的下发了全量画布时重绘(中途加入/重连/换轮清屏)。
  // 依赖不能是整个 state —— 每次有人猜词都会广播新 state,那样等于每猜一次
  // 就把整块画布重绘一遍,画到后期在低端手机上会明显卡顿。
  // 常规增量走 'stroke' 事件(见上面的 onStroke),不经过这里。
  const strokes = state?.strokes;
  const strokeRev = state?.strokeRev;
  useEffect(() => {
    if (strokes) strokeApi.current?.redrawAll(strokes);
  }, [strokes, strokeRev]);

  const members = state?.players || [];
  const nameOf = (id) => members.find((p) => p.id === id)?.name || '玩家';
  const isDrawer = state?.isDrawer;
  const secondsLeft = state?.deadline ? Math.max(0, Math.ceil((state.deadline - nowTs) / 1000)) : null;

  const sendGuess = () => {
    const t = guess.trim();
    if (!t) return;
    act({ type: 'guess', text: t });
    setGuess('');
  };

  // 结束排行榜
  if (state?.phase === 'ended') {
    return (
      <div>
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

  const wordHint = () => {
    if (state?.word) return state.word;
    if (state?.wordLength) return Array(state.wordLength).fill('＿').join(' ');
    return '';
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={ui.badge}>第 {(state?.roundsDone ?? 0) + 1}/{state?.roundsTotal} 轮</span>
        {secondsLeft !== null && <span style={{ ...ui.badge, color: secondsLeft <= 10 ? 'var(--danger)' : 'var(--muted)' }}>⏱ {secondsLeft}s</span>}
        <span style={ui.badge}>✏️ {nameOf(state?.drawerId)} {isDrawer ? '(你)' : ''}</span>
        <span style={{ marginLeft: 'auto', fontSize: 20, letterSpacing: 4, fontWeight: 800, color: 'var(--text)' }}>{wordHint()}</span>
      </div>

      <div className="game-layout" style={{ '--side': '240px' }}>
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
            {!isDrawer && !state?.spectator && state?.phase === 'draw' && !state?.guessed?.includes(me.id) && (
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
