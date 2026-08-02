import { useEffect, useReducer, useState } from 'react';
import { ui } from './ui';

// 炸弹猫游戏界面(对局中)。
// props: state(分玩家视图), act(action=>void), me{id,name}, onLeave
// state.phase: playing | nope(否决窗口) | defusing(有人在拆弹) | ended
//
// 信息隔离:视图里只有 myHand(自己的手牌)和别人的 handCount(张数)。
// 牌堆顺序服务端从不下发 —— 只有 deckCount。洞悉未来的三张只有用牌者收得到。
const CARD_INFO = {
  bomb:    { name: '炸弹猫', emoji: '💣' },
  defuse:  { name: '拆弹',   emoji: '🙅' },
  nope:    { name: '否决',   emoji: '🚫' },
  attack:  { name: '攻击',   emoji: '⚔️' },
  skip:    { name: '跳过',   emoji: '⏭️' },
  favor:   { name: '索要',   emoji: '🤲' },
  shuffle: { name: '洗牌',   emoji: '🔀' },
  future:  { name: '洞悉未来', emoji: '🔮' },
  cat_taco:    { name: '塔可猫', emoji: '🌮' },
  cat_melon:   { name: '西瓜猫', emoji: '🍉' },
  cat_beard:   { name: '胡须猫', emoji: '🧔' },
  cat_rainbow: { name: '彩虹猫', emoji: '🌈' },
  cat_potato:  { name: '土豆猫', emoji: '🥔' },
  cat_pair:    { name: '偷牌',   emoji: '🐾' },
  cat_three:   { name: '指名要牌', emoji: '🐾' },
  cat_five:    { name: '弃牌堆捡牌', emoji: '🐾' },
};
const info = (c) => CARD_INFO[c] || { name: c, emoji: '🂠' };
const ACTION_CARDS = ['attack', 'skip', 'favor', 'shuffle', 'future'];
const needsTarget = (c) => c === 'favor' || c === 'cat_pair';
// 抽出成函数,避免在组件 render 里直接调 Date.now()(react-hooks 会报纯度错误)
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
  const players = state.players || [];
  const nameOf = (id) => players.find((p) => p.id === id)?.name || '玩家';
  const [selected, setSelected] = useState([]);      // 选中的手牌索引
  const [targeting, setTargeting] = useState(null);  // 需要选目标时:待出的牌
  const isSpectator = !!state.spectator;

  const hand = state.myHand || [];
  const myTurn = state.isMyTurn;

  // 爆炸动画:log 里出现新的爆炸就播一次
  const lastBoom = [...(state.log || [])].reverse().find((e) => e.type === 'eliminated' && e.reason === 'bomb');
  const boomKey = lastBoom ? `${lastBoom.playerId}-${state.log.length}` : null;
  const [shownBoom, setShownBoom] = useState(null);
  const showBoom = boomKey && shownBoom !== boomKey;

  if (state.phase === 'ended') {
    const ranking = state.ranking || [];
    return (
      <div>
        <div style={{ ...ui.card, textAlign: 'center' }}>
          <h2 style={{ marginBottom: 8 }}>🏆 {ranking[0]?.name} 活到了最后</h2>
        </div>
        <div style={ui.card}>
          <label style={ui.label}>名次</label>
          {ranking.map((p, i) => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
              <span>{i + 1}. {p.name}{p.id === me.id ? ' (你)' : ''}</span>
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
    // 三张要先报牌名、五张要先从弃牌堆挑,都要多一步选择
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
      {/* 状态条 */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={ui.badge}>🂠 牌堆 {state.deckCount}</span>
        <span style={ui.badge}>
          {state.phase === 'nope' ? '🚫 否决窗口'
            : state.phase === 'defusing' ? '🙅 拆弹中'
            : myTurn ? '🎯 轮到你' : `⏳ ${nameOf(state.currentPlayer)} 的回合`}
        </span>
        <Countdown deadline={state.deadline} />
        {state.turnsLeft > 1 && <span style={{ ...ui.badge, background: 'var(--danger)', color: '#fff' }}>
          ⚔️ 还要打 {state.turnsLeft} 回合
        </span>}
      </div>

      <div className="game-layout" style={{ '--side': '200px' }}>
        <div style={ui.card}>
          {/* 爆炸动画 */}
          {showBoom && (
            <BoomReveal name={nameOf(lastBoom.playerId)} onDone={() => setShownBoom(boomKey)} />
          )}

          {/* 否决窗口:所有人可见,有否决牌的人可以打断 */}
          {state.phase === 'nope' && state.pending && (
            <div style={{ padding: 12, borderRadius: 10, background: 'var(--surface-2)', marginBottom: 12, textAlign: 'center' }}>
              <div style={{ fontWeight: 800, marginBottom: 4 }}>
                {nameOf(state.pending.by)} 打出了 {info(state.pending.card).emoji} {info(state.pending.card).name}
                {state.pending.target && ` → ${nameOf(state.pending.target)}`}
                {state.pending.wanted && `,要「${info(state.pending.wanted).name}」`}
              </div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8 }}>
                {state.pending.nopeCount > 0
                  ? `已被否决 ${state.pending.nopeCount} 次 —— ${state.pending.nopeCount % 2 ? '当前不会生效' : '当前会生效'}`
                  : '窗口结束后生效'}
              </div>
              {state.iCanNope && (
                <button style={{ ...ui.btnAccent, background: 'var(--danger)' }}
                  onClick={() => act({ type: 'nope' })}>🚫 否决!</button>
              )}
            </div>
          )}

          {/* 拆弹:只有当事人能选位置 */}
          {state.phase === 'defusing' && (
            state.iAmDefusing
              ? <DefusePicker deckSize={state.deckSize ?? 0} act={act} />
              : <p style={{ textAlign: 'center', color: 'var(--muted)' }}>
                  🙅 {nameOf(state.defusingBy)} 拆掉了炸弹,正在把它塞回牌堆…
                </p>
          )}

          {/* 洞悉未来的结果:只有自己看得到 */}
          {state.myFuture && (
            <div style={{ padding: 10, borderRadius: 10, background: 'var(--surface-2)', marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>🔮 牌堆顶三张(只有你看得到)</div>
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

          {/* 出牌的第二步:选目标 / 报牌名 / 从弃牌堆挑 */}
          {targeting && (
            <div style={{ padding: 12, borderRadius: 10, background: 'var(--surface-2)', marginBottom: 12 }}>
              {targeting.card === 'cat_five' ? (
                <>
                  <div style={{ fontWeight: 700, marginBottom: 8, textAlign: 'center' }}>
                    🐾 从弃牌堆挑一张
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                    {[...new Set(state.discard || [])].map((c) => (
                      <button key={c} style={{ ...ui.btnGhost, padding: '6px 10px' }}
                        onClick={() => finishPlay({ wanted: c })}>
                        {info(c).emoji} {info(c).name}
                      </button>
                    ))}
                    {!(state.discard || []).length && (
                      <span style={{ color: 'var(--muted)', fontSize: 13 }}>弃牌堆是空的</span>
                    )}
                  </div>
                </>
              ) : !targeting.target ? (
                <>
                  <div style={{ fontWeight: 700, marginBottom: 8, textAlign: 'center' }}>选择目标玩家</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                    {players.filter((p) => p.alive && p.id !== me.id).map((p) => (
                      <button key={p.id} style={ui.btnGhost}
                        onClick={() => targeting.card === 'cat_three'
                          ? setTargeting({ ...targeting, target: p.id })
                          : finishPlay({ target: p.id })}>
                        {p.name}({p.handCount} 张)
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontWeight: 700, marginBottom: 4, textAlign: 'center' }}>
                    🐾 向 {nameOf(targeting.target)} 指名要一张牌
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8, textAlign: 'center' }}>
                    他有就必须给,没有则落空(所有人都会看到结果)
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                    {/* cat_pair/cat_three/cat_five 是组合出的伪牌名,不是真实牌,不能要 */}
                    {Object.keys(CARD_INFO).filter((c) => !['cat_pair', 'cat_three', 'cat_five'].includes(c)).map((c) => (
                      <button key={c} style={{ ...ui.btnGhost, padding: '6px 10px' }}
                        onClick={() => finishPlay({ target: targeting.target, wanted: c })}>
                        {info(c).emoji} {info(c).name}
                      </button>
                    ))}
                  </div>
                </>
              )}
              <button style={{ ...ui.btnGhost, color: 'var(--muted)', width: '100%' }}
                onClick={() => setTargeting(null)}>取消</button>
            </div>
          )}

          {/* 我的手牌 */}
          {!isSpectator && state.alive && (
            <>
              <label style={ui.label}>我的手牌({hand.length} 张)</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                {hand.map((c, i) => {
                  const on = selected.includes(i);
                  return (
                    <button key={i} onClick={() => toggleCard(i)}
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
                    出牌{selected.length ? `(${selected.length} 张)` : ''}
                  </button>
                  <button style={{ ...ui.btnAccent, flex: 1 }}
                    onClick={() => { setSelected([]); act({ type: 'draw' }); }}>
                    抽牌结束回合
                  </button>
                </div>
              )}
              {!myTurn && state.phase === 'playing' && (
                <p style={{ color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>
                  等待 {nameOf(state.currentPlayer)} 行动…
                </p>
              )}
            </>
          )}
          {!isSpectator && !state.alive && (
            <p style={{ color: 'var(--muted)', textAlign: 'center' }}>💀 你被炸飞了,静静观战…</p>
          )}
          {isSpectator && (
            <p style={{ color: 'var(--muted)', textAlign: 'center' }}>👀 观战中,看不到任何人的手牌</p>
          )}
        </div>

        {/* 玩家列表 */}
        <div style={{ ...ui.card, marginBottom: 0, padding: 12 }}>
          <label style={ui.label}>玩家</label>
          {players.map((p) => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '4px 0',
              color: p.alive ? 'var(--text)' : 'var(--muted)',
              textDecoration: p.alive ? 'none' : 'line-through',
              fontWeight: p.id === state.currentPlayer ? 800 : 400 }}>
              <span>
                {!p.alive ? '💀' : p.id === state.currentPlayer ? '🎯' : '🙂'} {p.name}
                {p.id === me.id ? ' (你)' : ''}{p.absent ? ' ⚠️' : ''}
              </span>
              <span>{p.alive ? `🂠 ${p.handCount}` : ''}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// 拆弹后选择炸弹塞回牌堆的位置。位置只有自己知道 —— 这是拆弹者唯一的信息优势。
function DefusePicker({ deckSize, act }) {
  const spots = [
    { pos: 0, label: '牌堆最顶(下一个人立刻抽到)' },
    { pos: 1, label: '第 2 张' },
    { pos: 2, label: '第 3 张' },
    { pos: Math.floor(deckSize / 2), label: '牌堆中间' },
    { pos: deckSize, label: '牌堆最底(最安全)' },
  ];
  return (
    <div style={{ padding: 12, borderRadius: 10, background: 'var(--surface-2)', marginBottom: 12 }}>
      <div style={{ fontWeight: 800, marginBottom: 4, textAlign: 'center' }}>🙅 拆弹成功!</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8, textAlign: 'center' }}>
        把炸弹塞回牌堆 —— 只有你知道它在哪
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

// 爆炸动画:牌炸开,碎片四散。
function BoomReveal({ name, onDone }) {
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
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>被炸飞了</div>
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
