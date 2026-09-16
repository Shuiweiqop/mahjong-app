import { useEffect, useRef, useState } from 'react';
import DrawCanvas from './DrawCanvas';
import { ui } from './ui';
import { useT } from './i18n.jsx';

// Draw & Guess match view (in progress / finished).
// props: state (the view), act(action=>void), me{id,name}, socket (ref, used to bind the stroke/chat
// events), onLeave
// This component subscribes to the Draw & Guess specific socket events itself: stroke/clear/chat/
// guessed/reveal and so on.
export default function DrawGuessGame({ state, act, me, socket, onLeave }) {
  const t = useT();
  const [messages, setMessages] = useState([]);
  const [guess, setGuess] = useState('');
  const [nowTs, setNowTs] = useState(Date.now());
  const strokeApi = useRef(null);
  const chatEndRef = useRef(null);
  const membersRef = useRef(state?.players || []);
  membersRef.current = state?.players || membersRef.current;
  // The socket listeners below are registered only once, so their closures would freeze whatever `t` was
  // current at registration time; read the current one through a ref instead
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; }, [t]);

  // Messages are stored as { key, vars } rather than as already-assembled strings, and only translated at
  // render time -- that way, if the language is switched mid-match, the history that has already scrolled
  // up changes along with it instead of ending up a mix of two languages.
  // Plain-text messages (actual chat content) are stored verbatim under `raw`, since they should never be
  // translated in the first place.
  const addMsg = (msg) => setMessages((m) => [...m.slice(-40), { ...msg, id: Math.random() }]);
  // The score bump that pops on the scoreboard. It removes itself once the animation finishes.
  const [pops, setPops] = useState([]);

  useEffect(() => {
    const t = setInterval(() => setNowTs(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  // Subscribe to the Draw & Guess specific socket events (strokes / clear / chat / correct guess / reveal)
  useEffect(() => {
    const s = socket.current;
    if (!s) return;
    const nameOf = (id) => membersRef.current.find((p) => p.id === id)?.name
      || tRef.current('common.player');
    const onStroke = (strokes) => {
      const arr = Array.isArray(strokes) ? strokes : [strokes];
      arr.forEach((st) => strokeApi.current?.applyRemoteStroke(st));
    };
    const onClear = () => strokeApi.current?.clear();
    const onChat = ({ playerId, text }) => addMsg({ raw: `${nameOf(playerId)}: ${text}` });
    const onGuessed = ({ playerId, points }) => {
      addMsg({ key: 'draw.guessed', vars: { name: nameOf(playerId), points }, kind: 'success' });
      // Pop the score bump on the scoreboard. Keyed by a timestamp so that consecutive correct guesses
      // each get their own pop.
      setPops((prev) => [...prev.slice(-5), { id: Math.random(), playerId, points }]);
    };
    const onReveal = ({ word }) => addMsg({ key: 'draw.answerWas', vars: { word }, kind: 'accent' });
    const onGameOver = () => addMsg({ key: 'draw.gameOver', kind: 'accent' });
    s.on('stroke', onStroke); s.on('clear', onClear); s.on('chat', onChat);
    s.on('guessed', onGuessed); s.on('reveal', onReveal); s.on('game_over', onGameOver);
    return () => {
      s.off('stroke', onStroke); s.off('clear', onClear); s.off('chat', onChat);
      s.off('guessed', onGuessed); s.off('reveal', onReveal); s.off('game_over', onGameOver);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  // Catch-up redraw: only runs when the server actually sent a full canvas (joining
  // mid-round, reconnecting, or the clear between rounds).
  // The dependency must not be the whole state object: a new state is broadcast every
  // time anyone guesses, which would mean redrawing the entire canvas on every guess --
  // clearly janky on a low-end phone once the drawing gets busy.
  // Ordinary incremental updates arrive on the 'stroke' event (see onStroke above) and
  // never come through here.
  const strokes = state?.strokes;
  const strokeRev = state?.strokeRev;
  useEffect(() => {
    if (strokes) strokeApi.current?.redrawAll(strokes);
  }, [strokes, strokeRev]);

  const members = state?.players || [];
  const nameOf = (id) => members.find((p) => p.id === id)?.name || t('common.player');
  const isDrawer = state?.isDrawer;
  const secondsLeft = state?.deadline ? Math.max(0, Math.ceil((state.deadline - nowTs) / 1000)) : null;

  const sendGuess = () => {
    const t = guess.trim();
    if (!t) return;
    act({ type: 'guess', text: t });
    setGuess('');
  };

  // Final leaderboard
  if (state?.phase === 'ended') {
    return (
      <div>
        <div style={ui.card}>
          <h2 style={{ textAlign: 'center', marginBottom: 16 }}>{t('draw.finalRanking')}</h2>
          {(state.ranking || []).map((p, i) => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
              <span>{['🥇', '🥈', '🥉'][i] || `${i + 1}.`} {p.name}</span>
              <b style={{ color: 'var(--accent)' }}>{p.score}</b>
            </div>
          ))}
        </div>
        <button style={{ ...ui.btnGhost, width: '100%' }} onClick={onLeave}>{t('draw.backToLobby')}</button>
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
        <span style={ui.badge}>{t('draw.round', { n: (state?.roundsDone ?? 0) + 1, total: state?.roundsTotal })}</span>
        {secondsLeft !== null && <span style={{ ...ui.badge, color: secondsLeft <= 10 ? 'var(--danger)' : 'var(--muted)' }}>⏱ {secondsLeft}s</span>}
        <span style={ui.badge}>✏️ {nameOf(state?.drawerId)}{isDrawer ? t('common.you') : ''}</span>
        <span style={{ marginLeft: 'auto', fontSize: 20, letterSpacing: 4, fontWeight: 800, color: 'var(--text)' }}>{wordHint()}</span>
      </div>

      <div className="game-layout" style={{ '--side': '240px' }}>
        <div>
          {state?.phase === 'pick' && isDrawer ? (
            <div style={{ ...ui.card, textAlign: 'center' }}>
              <p style={{ marginBottom: 12, fontWeight: 700 }}>{t('draw.pickWord')}</p>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
                {(state.wordChoices || []).map((w) => (
                  <button key={w} style={ui.btnAccent} onClick={() => act({ type: 'pick', word: w })}>{w}</button>
                ))}
              </div>
            </div>
          ) : state?.phase === 'pick' ? (
            <div style={{ ...ui.card, textAlign: 'center', color: 'var(--muted)' }}>
              {t('draw.picking', { name: nameOf(state?.drawerId) })}
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
            <label style={ui.label}>{t('draw.scoreboard')}</label>
            {[...members].sort((a, b) => (state?.scores?.[b.id] || 0) - (state?.scores?.[a.id] || 0)).map((p) => (
              <div key={p.id} style={{ position: 'relative', display: 'flex', justifyContent: 'space-between',
                fontSize: 14, padding: '3px 0',
                color: state?.guessed?.includes(p.id) ? 'var(--success)' : 'var(--text)' }}>
                <span>{p.id === state?.drawerId ? '✏️' : state?.guessed?.includes(p.id) ? '✅' : '·'} {p.name}</span>
                <b>{state?.scores?.[p.id] || 0}</b>
                {pops.filter((x) => x.playerId === p.id).map((x) => (
                  <span key={x.id} className="score-pop"
                    onAnimationEnd={() => setPops((prev) => prev.filter((y) => y.id !== x.id))}>
                    +{x.points}
                  </span>
                ))}
              </div>
            ))}
          </div>

          <div style={{ ...ui.card, marginBottom: 0, padding: 12, flex: 1, display: 'flex', flexDirection: 'column', minHeight: 200 }}>
            <div style={{ flex: 1, overflowY: 'auto', maxHeight: 220, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {messages.map((m) => (
                <div key={m.id} style={{ color: m.kind === 'success' ? 'var(--success)' : m.kind === 'danger' ? 'var(--danger)' : m.kind === 'accent' ? 'var(--accent)' : 'var(--muted)' }}>
                  {m.raw ?? t(m.key, m.vars)}
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            {!isDrawer && !state?.spectator && state?.phase === 'draw' && !state?.guessed?.includes(me.id) && (
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <input style={{ ...ui.input, marginBottom: 0 }} value={guess} placeholder={t('draw.guessPlaceholder')}
                  onChange={(e) => setGuess(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendGuess()} />
                <button style={ui.btn} onClick={sendGuess}>{t('draw.guess')}</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
