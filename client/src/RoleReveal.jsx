import { useState, useEffect } from 'react';
import { ui } from './ui';

// 发身份序幕:洗牌 → 一张牌飞到面前 → 点击翻开露出角色 → 进入游戏。
// props: role('wolf'|'seer'|'villager'), onDone()
// 牌面用图片 client/public/games/cards/card-<role>.png,加载失败回退 emoji+文字。
const ROLE_META = {
  wolf: { emoji: '🐺', name: '狼人', color: '#c0392b', desc: '夜晚与同伴猎杀一名玩家' },
  seer: { emoji: '🔮', name: '预言家', color: '#8b5cf6', desc: '每晚查验一名玩家的身份' },
  villager: { emoji: '👤', name: '平民', color: '#3ecf8e', desc: '白天找出并投票放逐狼人' },
};

const CARD_W = 200;
const CARD_H = 300;

export default function RoleReveal({ role, onDone }) {
  const meta = ROLE_META[role] || ROLE_META.villager;
  // 阶段: shuffle(洗牌) → deal(飞牌就位) → flipped(已翻开)
  const [stage, setStage] = useState('shuffle');
  const [backImgOk, setBackImgOk] = useState(true);
  const [faceImgOk, setFaceImgOk] = useState(true);

  useEffect(() => {
    const t1 = setTimeout(() => setStage('deal'), 1100);      // 洗牌 1.1s 后发牌
    return () => clearTimeout(t1);
  }, []);

  const flip = () => { if (stage === 'deal') setStage('flipped'); };

  const flipped = stage === 'flipped';

  return (
    <div style={overlay}>
      <style>{keyframes}</style>

      {stage === 'shuffle' ? (
        // ── 洗牌:一叠牌背轻微错位抖动 ──
        <div style={{ position: 'relative', width: CARD_W, height: CARD_H }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} style={{
              ...cardBackStyle(backImgOk), position: 'absolute', inset: 0,
              animation: `shuffle 0.5s ease-in-out ${i * 0.05}s infinite alternate`,
            }}>
              {!backImgOk && <div style={backFallback}>🀄</div>}
              <img src="/games/cards/card-back.png" alt="" style={imgStyle}
                onError={() => setBackImgOk(false)} />
            </div>
          ))}
          <p style={hint}>洗牌中…</p>
        </div>
      ) : (
        // ── 发牌就位 + 可翻转 ──
        <div style={{ textAlign: 'center' }}>
          <div style={{ perspective: 1000, width: CARD_W, height: CARD_H, margin: '0 auto',
            animation: stage === 'deal' ? 'dealIn 0.6s cubic-bezier(0.2,0.8,0.2,1)' : 'none' }}>
            <div onClick={flip} style={{
              position: 'relative', width: '100%', height: '100%', cursor: flipped ? 'default' : 'pointer',
              transformStyle: 'preserve-3d', transition: 'transform 0.6s',
              transform: flipped ? 'rotateY(180deg)' : 'rotateY(0deg)',
            }}>
              {/* 背面 */}
              <div style={{ ...cardBackStyle(backImgOk), position: 'absolute', inset: 0, backfaceVisibility: 'hidden' }}>
                {!backImgOk && <div style={backFallback}>🀄</div>}
                <img src="/games/cards/card-back.png" alt="" style={imgStyle} onError={() => setBackImgOk(false)} />
              </div>
              {/* 正面(角色) */}
              <div style={{
                position: 'absolute', inset: 0, backfaceVisibility: 'hidden', transform: 'rotateY(180deg)',
                borderRadius: 16, overflow: 'hidden', border: `2px solid ${meta.color}`,
                background: 'var(--surface-2)', display: 'grid', placeItems: 'center',
              }}>
                {faceImgOk ? (
                  <img src={`/games/cards/card-${role}.png`} alt={meta.name} style={imgStyle}
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
            <p style={hint}>👆 点击翻开你的身份</p>
          ) : (
            <div style={{ marginTop: 20, animation: 'fadeUp 0.4s' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: meta.color, marginBottom: 4 }}>
                你是 {meta.emoji} {meta.name}
              </div>
              <div style={{ color: 'var(--muted)', fontSize: 14, marginBottom: 18 }}>{meta.desc}</div>
              <button style={ui.btnAccent} onClick={onDone}>进入游戏</button>
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
