import { useEffect, useReducer, useState } from 'react';
import { ui } from './ui';
import { useT } from './i18n.jsx';

// Exploding Kittens game view (during a match).
// props: state (per-player view), act(action=>void), me{id,name}, onLeave
// state.phase: playing | nope (the nope window) | defusing (someone is defusing) | ended
//
// Information hiding: the view contains only myHand (your own cards) and everyone else's handCount (a
// card count). The server never sends the deck order -- only deckCount. The three cards from See the
// Future are delivered only to the player who played it.
// Card emoji are language-independent; card names are looked up in the message catalog as
// kittens.card.<id>.
// The key order here is also the display order of the "name a card" list, so do not casually reorder it.
const CARD_EMOJI = {
  bomb: '💣', defuse: '🙅', nope: '🚫', attack: '⚔️', skip: '⏭️',
  favor: '🤲', shuffle: '🔀', future: '🔮',
  cat_taco: '🌮', cat_melon: '🍉', cat_beard: '🧔', cat_rainbow: '🌈', cat_potato: '🥔',
  cat_pair: '🐾', cat_three: '🐾', cat_five: '🐾',
};
// infoOf(t, 'bomb') → { name, emoji }; an unknown card falls back to its raw id, which makes a missing
// entry easy to spot
const infoOf = (t, c) => ({
  name: CARD_EMOJI[c] ? t(`kittens.card.${c}`) : c,
  emoji: CARD_EMOJI[c] || '🂠',
});
const ACTION_CARDS = ['attack', 'skip', 'favor', 'shuffle', 'future'];
const needsTarget = (c) => c === 'favor' || c === 'cat_pair';
// Extracted into a function so that Date.now() is not called directly inside a component's render
// (react-hooks would flag that as a purity error)
const remain = (deadline) => deadline == null ? 0 : Math.max(0, Math.ceil((deadline - Date.now()) / 1000));

function Countdown({ deadline }) {
  const [, tick] = useReducer((n) => n + 1, 0);
  const active = deadline != null;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(tick, 400);
    return () => clearInterval(t);
  }, [active]);
  if (!active) return null;
  const left = remain(deadline);
  const danger = left <= 5;
  return (
    <span style={{ ...ui.badge, fontSize: 15, fontWeight: 800, padding: '6px 14px',
      background: danger ? 'var(--danger)' : 'var(--surface-2)',
      color: danger ? '#fff' : 'var(--text)',
      animation: danger ? 'pulse 1s ease-in-out infinite' : 'none' }}>
      ⏱ {left}s
    </span>
  );
}

export default function KittensGame({ state, act, me }) {
  const t = useT();
  const info = (c) => infoOf(t, c);
  const players = state.players || [];
  const nameOf = (id) => players.find((p) => p.id === id)?.name || t('common.player');
  const [selected, setSelected] = useState([]);      // indices of the selected cards in hand
  const [targeting, setTargeting] = useState(null);  // when a target is needed: the card about to be played
  const isSpectator = !!state.spectator;

  const hand = state.myHand || [];
  const myTurn = state.isMyTurn;

  // Explosion animation: played once whenever a new explosion shows up in the log
  const lastBoom = [...(state.log || [])].reverse().find((e) => e.type === 'eliminated' && e.reason === 'bomb');
  const boomKey = lastBoom ? `${lastBoom.playerId}-${state.log.length}` : null;
  const [shownBoom, setShownBoom] = useState(null);
  const showBoom = boomKey && shownBoom !== boomKey;

  if (state.phase === 'ended') {
    const ranking = state.ranking || [];
    return (
      <div>
        <div style={{ ...ui.card, textAlign: 'center' }}>
          <h2 style={{ marginBottom: 8 }}>{t('kittens.winner', { name: ranking[0]?.name })}</h2>
        </div>
        <div style={ui.card}>
          <label style={ui.label}>{t('kittens.ranking')}</label>
          {ranking.map((p, i) => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
              <span>{i + 1}. {p.name}{p.id === me.id ? t('common.you') : ''}</span>
              <span>{i === 0 ? '🏆' : '💀'}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const toggleCard = (i) => {
    setSelected((prev) => prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]);
  };

  const selectedCards = selected.map((i) => hand[i]);
  const comboOf = (cards) => {
    const allCats = cards.length > 0 && cards.every((c) => c.startsWith('cat_'));
    const same = allCats && cards.every((c) => c === cards[0]);
    if (cards.length === 2 && same) return 'cat_pair';
    if (cards.length === 3 && same) return 'cat_three';
    if (cards.length === 5 && allCats && new Set(cards).size === 5) return 'cat_five';
    if (cards.length === 1 && ACTION_CARDS.includes(cards[0])) return cards[0];
    return null;
  };
  const combo = comboOf(selectedCards);

  const playSelected = () => {
    if (!combo) return;
    // A three-of-a-kind has to name a card first and a five-card set has to pick from the discard pile,
    // so both need one extra selection step
    if (combo === 'cat_three' || combo === 'cat_five' || needsTarget(combo)) {
      setTargeting({ cards: selectedCards, card: combo, target: null });
      return;
    }
    act({ type: 'play', cards: selectedCards });
    setSelected([]);
  };

  const finishPlay = (extra) => {
    act({ type: 'play', cards: targeting.cards, ...extra });
    setTargeting(null);
    setSelected([]);
  };

  const canPlay = !!combo;

  return (
    <div>
      {/* Status bar */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={ui.badge}>{t('kittens.deck', { n: state.deckCount })}</span>
        <span style={ui.badge}>
          {state.phase === 'nope' ? t('kittens.nopeWindow')
            : state.phase === 'defusing' ? t('kittens.defusing')
            : myTurn ? t('kittens.yourTurn') : t('kittens.theirTurn', { name: nameOf(state.currentPlayer) })}
        </span>
        <Countdown deadline={state.deadline} />
        {state.turnsLeft > 1 && <span style={{ ...ui.badge, background: 'var(--danger)', color: '#fff' }}>
          {t('kittens.extraTurns', { n: state.turnsLeft })}
        </span>}
      </div>

      <div className="game-layout" style={{ '--side': '200px' }}>
        <div style={ui.card}>
          {/* Explosion animation */}
          {showBoom && (
            <BoomReveal name={nameOf(lastBoom.playerId)} t={t} onDone={() => setShownBoom(boomKey)} />
          )}

          {/* Nope window: visible to everyone, and anyone holding a Nope card can interrupt */}
          {state.phase === 'nope' && state.pending && (
            <div style={{ padding: 12, borderRadius: 10, background: 'var(--surface-2)', marginBottom: 12, textAlign: 'center' }}>
              <div style={{ fontWeight: 800, marginBottom: 4 }}>
                {t('kittens.played', {
                  name: nameOf(state.pending.by),
                  emoji: info(state.pending.card).emoji,
                  card: info(state.pending.card).name,
                })}
                {state.pending.target && ` → ${nameOf(state.pending.target)}`}
                {state.pending.wanted && t('kittens.wanted', { card: info(state.pending.wanted).name })}
              </div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8 }}>
                {state.pending.nopeCount > 0
                  ? t('kittens.nopedTimes', {
                      n: state.pending.nopeCount,
                      effect: state.pending.nopeCount % 2
                        ? t('kittens.willNotResolve') : t('kittens.willResolve'),
                    })
                  : t('kittens.resolvesAfter')}
              </div>
              {state.iCanNope && (
                <button style={{ ...ui.btnAccent, background: 'var(--danger)' }}
                  onClick={() => act({ type: 'nope' })}>{t('kittens.nope')}</button>
              )}
            </div>
          )}

          {/* Favor: the player being asked picks a card to give away themselves (the asker cannot see
              what they hold) */}
          {state.phase === 'favor' && (
            state.iAmGiving ? (
              <div style={{ padding: 12, borderRadius: 10, background: 'var(--surface-2)', marginBottom: 12 }}>
                <div style={{ fontWeight: 800, marginBottom: 4, textAlign: 'center' }}>
                  {t('kittens.favorAsked', { name: nameOf(state.favorTo) })}
                </div>
                <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8, textAlign: 'center' }}>
                  {t('kittens.favorPick')}
                </div>
              </div>
            ) : (
              <p style={{ textAlign: 'center', color: 'var(--muted)', marginBottom: 12 }}>
                {t('kittens.favorWaiting', {
                  to: nameOf(state.favorTo), from: nameOf(state.favorFrom),
                })}
              </p>
            )
          )}

          {/* Defusing: only the player involved gets to choose the position */}
          {state.phase === 'defusing' && (
            state.iAmDefusing
              ? <DefusePicker deckSize={state.deckSize ?? 0} act={act} t={t} />
              : <p style={{ textAlign: 'center', color: 'var(--muted)' }}>
                  {t('kittens.defusedBy', { name: nameOf(state.defusingBy) })}
                </p>
          )}

          {/* The result of See the Future: visible only to you */}
          {state.myFuture && (
            <div style={{ padding: 10, borderRadius: 10, background: 'var(--surface-2)', marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{t('kittens.futureTitle')}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                {state.myFuture.map((c, i) => (
                  <span key={i} style={{ ...ui.badge, background: c === 'bomb' ? 'var(--danger)' : 'var(--surface)',
                    color: c === 'bomb' ? '#fff' : 'var(--text)' }}>
                    {i + 1}. {info(c).emoji} {info(c).name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Second step of playing a card: pick a target / name a card / pick from the discard pile */}
          {targeting && (
            <div style={{ padding: 12, borderRadius: 10, background: 'var(--surface-2)', marginBottom: 12 }}>
              {targeting.card === 'cat_five' ? (
                <>
                  <div style={{ fontWeight: 700, marginBottom: 8, textAlign: 'center' }}>
                    {t('kittens.pickFromDiscard')}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                    {[...new Set(state.discard || [])].map((c) => (
                      <button key={c} style={{ ...ui.btnGhost, padding: '6px 10px' }}
                        onClick={() => finishPlay({ wanted: c })}>
                        {info(c).emoji} {info(c).name}
                      </button>
                    ))}
                    {!(state.discard || []).length && (
                      <span style={{ color: 'var(--muted)', fontSize: 13 }}>{t('kittens.discardEmpty')}</span>
                    )}
                  </div>
                </>
              ) : !targeting.target ? (
                <>
                  <div style={{ fontWeight: 700, marginBottom: 8, textAlign: 'center' }}>{t('kittens.pickTarget')}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                    {players.filter((p) => p.alive && p.id !== me.id).map((p) => (
                      <button key={p.id} style={ui.btnGhost}
                        onClick={() => targeting.card === 'cat_three'
                          ? setTargeting({ ...targeting, target: p.id })
                          : finishPlay({ target: p.id })}>
                        {t('kittens.handCount', { name: p.name, n: p.handCount })}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontWeight: 700, marginBottom: 4, textAlign: 'center' }}>
                    {t('kittens.nameACard', { name: nameOf(targeting.target) })}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8, textAlign: 'center' }}>
                    {t('kittens.nameACardHint')}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                    {/* cat_pair/cat_three/cat_five are pseudo card names produced by combinations, not
                        real cards, so they cannot be asked for */}
                    {Object.keys(CARD_EMOJI).filter((c) => !['cat_pair', 'cat_three', 'cat_five'].includes(c)).map((c) => (
                      <button key={c} style={{ ...ui.btnGhost, padding: '6px 10px' }}
                        onClick={() => finishPlay({ target: targeting.target, wanted: c })}>
                        {info(c).emoji} {info(c).name}
                      </button>
                    ))}
                  </div>
                </>
              )}
              <button style={{ ...ui.btnGhost, color: 'var(--muted)', width: '100%' }}
                onClick={() => setTargeting(null)}>{t('common.cancel')}</button>
            </div>
          )}

          {/* My hand */}
          {!isSpectator && state.alive && (
            <>
              <label style={ui.label}>
                {t('kittens.myHand', { n: hand.length })}
                {state.phase === 'favor' && state.iAmGiving && t('kittens.handGiveHint')}
              </label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                {hand.map((c, i) => {
                  const on = selected.includes(i);
                  const giving = state.phase === 'favor' && state.iAmGiving;
                  return (
                    <button key={i}
                      onClick={() => giving ? act({ type: 'give_card', index: i }) : toggleCard(i)}
                      className={c === 'bomb' ? 'kitten-bomb' : undefined}
                      style={{
                        padding: '8px 10px', borderRadius: 10, fontSize: 13, fontWeight: 700,
                        border: `2px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                        background: on ? 'var(--accent)' : 'var(--surface-2)',
                        color: on ? '#fff' : 'var(--text)',
                        transform: on ? 'translateY(-4px)' : 'none',
                        transition: 'transform 0.15s, background 0.15s',
                        cursor: 'pointer',
                      }}>
                      <div style={{ fontSize: 20 }}>{info(c).emoji}</div>
                      {info(c).name}
                    </button>
                  );
                })}
              </div>

              {myTurn && !targeting && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button style={{ ...ui.btnGhost, flex: 1, opacity: canPlay ? 1 : 0.45 }}
                    disabled={!canPlay} onClick={playSelected}>
                    {t('kittens.play')}{selected.length ? t('kittens.playCount', { n: selected.length }) : ''}
                  </button>
                  <button style={{ ...ui.btnAccent, flex: 1 }}
                    onClick={() => { setSelected([]); act({ type: 'draw' }); }}>
                    {t('kittens.drawEndTurn')}
                  </button>
                </div>
              )}
              {!myTurn && state.phase === 'playing' && (
                <p style={{ color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>
                  {t('kittens.waitingFor', { name: nameOf(state.currentPlayer) })}
                </p>
              )}
            </>
          )}
          {!isSpectator && !state.alive && (
            <p style={{ color: 'var(--muted)', textAlign: 'center' }}>{t('kittens.youExploded')}</p>
          )}
          {isSpectator && (
            <p style={{ color: 'var(--muted)', textAlign: 'center' }}>{t('kittens.spectatorNoHands')}</p>
          )}
        </div>

        {/* Player list */}
        <div style={{ ...ui.card, marginBottom: 0, padding: 12 }}>
          <label style={ui.label}>{t('common.players')}</label>
          {players.map((p) => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '4px 0',
              color: p.alive ? 'var(--text)' : 'var(--muted)',
              textDecoration: p.alive ? 'none' : 'line-through',
              fontWeight: p.id === state.currentPlayer ? 800 : 400 }}>
              <span>
                {!p.alive ? '💀' : p.id === state.currentPlayer ? '🎯' : '🙂'} {p.name}
                {p.id === me.id ? t('common.you') : ''}{p.absent ? ' ⚠️' : ''}
              </span>
              <span>{p.alive ? `🂠 ${p.handCount}` : ''}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// After defusing, choose where the bomb goes back into the deck. Only you know that position -- it is the
// defuser's one and only informational advantage.
function DefusePicker({ deckSize, act, t }) {
  const spots = [
    { pos: 0, label: t('kittens.spotTop') },
    { pos: 1, label: t('kittens.spotSecond') },
    { pos: 2, label: t('kittens.spotThird') },
    { pos: Math.floor(deckSize / 2), label: t('kittens.spotMiddle') },
    { pos: deckSize, label: t('kittens.spotBottom') },
  ];
  return (
    <div style={{ padding: 12, borderRadius: 10, background: 'var(--surface-2)', marginBottom: 12 }}>
      <div style={{ fontWeight: 800, marginBottom: 4, textAlign: 'center' }}>{t('kittens.defuseSuccess')}</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8, textAlign: 'center' }}>
        {t('kittens.defusePlace')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {spots.map((s) => (
          <button key={s.label} style={ui.btnGhost}
            onClick={() => act({ type: 'place_bomb', position: s.pos })}>{s.label}</button>
        ))}
      </div>
    </div>
  );
}

// Explosion animation: the card blows up and the fragments scatter.
function BoomReveal({ name, onDone, t }) {
  const [stage, setStage] = useState('idle');
  useEffect(() => {
    const t1 = setTimeout(() => setStage('boom'), 120);
    const t2 = setTimeout(() => { setStage('done'); onDone?.(); }, 1900);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [onDone]);
  if (stage === 'done') return null;
  return (
    <div style={{ position: 'relative', width: 180, height: 130, margin: '0 auto 12px' }}>
      <div className={stage === 'boom' ? 'kitten-boom' : undefined} style={{
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 6,
        background: 'var(--surface-2)', border: '2px solid var(--danger)', borderRadius: 12,
      }}>
        <div style={{ fontSize: 38 }}>💥</div>
        <div style={{ fontWeight: 800 }}>{name}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t('kittens.blownUp')}</div>
      </div>
      {stage === 'boom' && (
        <div className="kitten-blast" style={{
          position: 'absolute', left: '50%', top: '50%', width: 14, height: 14,
          marginLeft: -7, marginTop: -7, borderRadius: '50%', pointerEvents: 'none',
          background: 'radial-gradient(circle, #fff 0%, #ffd76a 35%, #ff6b3d 60%, transparent 72%)',
        }} />
      )}
    </div>
  );
}
