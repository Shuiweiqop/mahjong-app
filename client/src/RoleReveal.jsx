import { useState, useEffect } from 'react';
import { ui } from './ui';
import { useT } from './i18n.jsx';

// Role-reveal intro: shuffle -> a card flies to the front -> tap to flip it and see
// the role -> enter the game.
// props: role('wolf'|'seer'|'villager'), onDone(), ready (this player is ready),
//        readyCount/readyTotal (how many others are ready)
// Tapping "enter game" calls onDone(), which tells the server this player is ready;
// once everyone is, the parent switches away from this intro.
// The card face is an image at client/public/games/cards/card-<role>.webp, falling back
// to emoji plus text if it fails to load.
// Role colour and emoji are language-independent; the name and description come from
// the string table (role.<id> / role.<id>.desc).
const ROLE_META = {
  wolf: { emoji: '🐺', color: '#c0392b' },
  seer: { emoji: '🔮', color: '#8b5cf6' },
  witch: { emoji: '🧪', color: '#8b5cf6' },
  hunter: { emoji: '🔫', color: '#c0392b' },
  villager: { emoji: '👤', color: '#3ecf8e' },
};

const CARD_W = 200;
const CARD_H = 300;

export default function RoleReveal({ role, onDone, ready = false, readyCount, readyTotal }) {
  const t = useT();
  const key = ROLE_META[role] ? role : 'villager';
  const meta = {
    ...ROLE_META[key],
    name: t(`role.${key}`),
    desc: t(`role.${key}.desc`),
  };
  // Stages: shuffle -> deal (the card flies into place) -> flipped
  const [stage, setStage] = useState('shuffle');
  const [backImgOk, setBackImgOk] = useState(true);
  const [faceImgOk, setFaceImgOk] = useState(true);

  useEffect(() => {
    const t1 = setTimeout(() => setStage('deal'), 1100);      // deal 1.1s after the shuffle starts
    return () => clearTimeout(t1);
  }, []);

  const flip = () => { if (stage === 'deal') setStage('flipped'); };

  const flipped = stage === 'flipped';

  return (
    <div style={overlay}>
      <style>{keyframes}</style>

      {stage === 'shuffle' ? (
        // ── Shuffling: a stack of card backs jitters slightly out of alignment ──
        <div style={{ position: 'relative', width: CARD_W, height: CARD_H }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} style={{
              ...cardBackStyle(backImgOk), position: 'absolute', inset: 0,
              animation: `shuffle 0.5s ease-in-out ${i * 0.05}s infinite alternate`,
            }}>
              {backImgOk
                ? <img src="/games/cards/card-back.webp" alt="" style={imgStyle} onError={() => setBackImgOk(false)} />
                : <div style={backFallback}>🌙</div>}
            </div>
          ))}
          <p style={hint}>{t('reveal.shuffling')}</p>
        </div>
      ) : (
        // ── Card dealt into place, now flippable ──
        <div style={{ textAlign: 'center' }}>
          <div style={{ perspective: 1000, width: CARD_W, height: CARD_H, margin: '0 auto',
            animation: stage === 'deal' ? 'dealIn 0.6s cubic-bezier(0.2,0.8,0.2,1)' : 'none' }}>
            <div onClick={flip} style={{
              position: 'relative', width: '100%', height: '100%', cursor: flipped ? 'default' : 'pointer',
              transformStyle: 'preserve-3d', transition: 'transform 0.6s',
              transform: flipped ? 'rotateY(180deg)' : 'rotateY(0deg)',
            }}>
              {/* Back of the card */}
              <div style={{ ...cardBackStyle(backImgOk), position: 'absolute', inset: 0, backfaceVisibility: 'hidden' }}>
                {backImgOk
                  ? <img src="/games/cards/card-back.webp" alt="" style={imgStyle} onError={() => setBackImgOk(false)} />
                  : <div style={backFallback}>🌙</div>}
              </div>
              {/* Front of the card (the role) */}
              <div style={{
                position: 'absolute', inset: 0, backfaceVisibility: 'hidden', transform: 'rotateY(180deg)',
                borderRadius: 16, overflow: 'hidden', border: `2px solid ${meta.color}`,
                background: 'var(--surface-2)', display: 'grid', placeItems: 'center',
              }}>
                {faceImgOk ? (
                  <img src={`/games/cards/card-${role}.webp`} alt={meta.name} style={imgStyle}
                    onError={() => setFaceImgOk(false)} />
                ) : (
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 72 }}>{meta.emoji}</div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: meta.color }}>{meta.name}</div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {!flipped ? (
            <p style={hint}>{t('reveal.tapToFlip')}</p>
          ) : (
            <div style={{ marginTop: 20, animation: 'fadeUp 0.4s' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: meta.color, marginBottom: 4 }}>
                {t('reveal.youAre', { emoji: meta.emoji, role: meta.name })}
              </div>
              <div style={{ color: 'var(--muted)', fontSize: 14, marginBottom: 18 }}>{meta.desc}</div>
              {ready ? (
                <p style={{ color: 'var(--muted)', fontSize: 14 }}>
                  {t('reveal.ready')}
                  {readyTotal ? ` (${readyCount}/${readyTotal})` : ''}
                </p>
              ) : (
                <button style={ui.btnAccent} onClick={onDone}>{t('reveal.enterGame')}</button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const overlay = {
  position: 'fixed', inset: 0, background: 'rgba(10,12,30,0.94)', zIndex: 50,
  display: 'grid', placeItems: 'center',
};
const cardBackStyle = () => ({
  width: CARD_W, height: CARD_H, borderRadius: 16, overflow: 'hidden',
  border: '2px solid var(--primary)', background: 'var(--surface-2)',
});
const imgStyle = { width: '100%', height: '100%', objectFit: 'cover', display: 'block' };
const backFallback = {
  position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 72,
};
const hint = { color: 'var(--muted)', marginTop: 18, fontSize: 14, textAlign: 'center' };

const keyframes = `
@keyframes shuffle { from { transform: translate(-6px,-3px) rotate(-3deg); } to { transform: translate(6px,3px) rotate(3deg); } }
@keyframes dealIn { from { transform: translateY(120%) scale(0.6); opacity: 0; } to { transform: translateY(0) scale(1); opacity: 1; } }
@keyframes fadeUp { from { transform: translateY(10px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
`;
