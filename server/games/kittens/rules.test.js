// 炸弹猫规则测试。
//
// 这个游戏的隐藏信息和前两个不一样:它是"动态"的 —— 牌堆顺序会被洞悉未来
// 看到、被洗牌打乱、被拆弹者塞回。所以泄露面比角色/词语更大,测试重点在这。
//
//   cd server && npm test

const { test } = require('node:test');
const assert = require('node:assert');

const k = require('./index');
const { CARD } = require('./cards');

const P = (n) => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i }));

function started(n = 4, cfg = {}) {
  const s = k.createInitialState(P(n), cfg);
  k.applyAction(s, { type: 'start' }, s.hostId);
  return s;
}
const cur = (s) => s.order[s.turnIndex];

// ── 发牌与牌库 ──

test('炸弹数恰好比人数少 1 —— 保证最后剩一人', () => {
  for (const n of [2, 3, 5, 8]) {
    const s = started(n);
    const bombs = s.deck.filter((c) => c === CARD.BOMB).length;
    assert.strictEqual(bombs, n - 1, `${n} 人局应有 ${n - 1} 张炸弹`);
  }
});

test('开局每人 1 张拆弹 + 7 张普通牌,手牌里没有炸弹', () => {
  const s = started(4);
  for (const id of s.order) {
    const hand = s.hands[id];
    assert.strictEqual(hand.length, 8);
    assert.strictEqual(hand.filter((c) => c === CARD.DEFUSE).length, 1);
    assert.ok(!hand.includes(CARD.BOMB), '开局手牌里绝不能有炸弹');
  }
});

// ── 信息隔离(本模块最重要的部分) ──

test('视图绝不含牌堆顺序,也不含别人的手牌', () => {
  const s = started(4);
  const view = k.serializeStateFor(s, s.order[0]);
  assert.strictEqual(view.deck, undefined, 'deck 泄露 = 所有人都知道炸弹在哪');
  assert.strictEqual(view.hands, undefined, 'hands 泄露 = 所有人的牌都公开了');
  assert.strictEqual(typeof view.deckCount, 'number', '只该给剩余张数');
});

test('只看得到自己的手牌,别人只有张数', () => {
  const s = started(4);
  const me = s.order[0];
  const view = k.serializeStateFor(s, me);
  assert.deepStrictEqual(view.myHand, s.hands[me]);
  for (const p of view.players) {
    assert.strictEqual(typeof p.handCount, 'number');
    assert.strictEqual(p.hand, undefined, '别人的手牌内容不能出现在视图里');
  }
});

test('洞悉未来的三张只发给用牌的人', () => {
  const s = started(4);
  const me = cur(s);
  s.hands[me] = [CARD.FUTURE, CARD.DEFUSE];
  k.applyAction(s, { type: 'play', cards: [CARD.FUTURE] }, me);
  s.deadline = Date.now() - 1;
  k.applyAction(s, { type: 'tick' }, null);   // 关闭否决窗口让它生效

  assert.strictEqual(k.serializeStateFor(s, me).myFuture?.length, 3, '用牌者应看到三张');
  for (const other of s.order.filter((id) => id !== me)) {
    assert.strictEqual(k.serializeStateFor(s, other).myFuture, undefined,
      '其他人绝不能看到牌堆顶');
  }
});

test('拆弹者塞回炸弹的位置不泄露给别人', () => {
  const s = started(4);
  const me = cur(s);
  s.hands[me] = [CARD.DEFUSE];
  s.deck = [CARD.SKIP, CARD.SKIP, CARD.BOMB];   // 顶部是末尾
  k.applyAction(s, { type: 'draw' }, me);
  assert.strictEqual(s.phase, 'defusing');

  const other = s.order.find((id) => id !== me);
  const view = k.serializeStateFor(s, other);
  assert.strictEqual(view.iAmDefusing, false);
  assert.strictEqual(view.deckSize, undefined, '只有拆弹者需要知道牌堆长度用来选位置');
  assert.strictEqual(view.deck, undefined);

  k.applyAction(s, { type: 'place_bomb', position: 0 }, me);
  const after = k.serializeStateFor(s, other);
  assert.strictEqual(after.deck, undefined, '塞回之后位置更不能泄露');
});

// ── 炸弹与拆弹 ──

test('没有拆弹抽到炸弹即出局', () => {
  const s = started(3);
  const me = cur(s);
  s.hands[me] = [CARD.SKIP];          // 没有拆弹
  s.deck = [CARD.BOMB];
  k.applyAction(s, { type: 'draw' }, me);
  assert.strictEqual(s.alive[me], false, '应当出局');
});

test('有拆弹抽到炸弹不出局,并进入放置阶段', () => {
  const s = started(3);
  const me = cur(s);
  s.hands[me] = [CARD.DEFUSE];
  s.deck = [CARD.SKIP, CARD.BOMB];
  k.applyAction(s, { type: 'draw' }, me);
  assert.strictEqual(s.alive[me], true, '有拆弹不该出局');
  assert.strictEqual(s.phase, 'defusing');
  assert.ok(!s.hands[me].includes(CARD.DEFUSE), '拆弹应被消耗');
});

test('放置炸弹的位置真的生效', () => {
  const s = started(3);
  const me = cur(s);
  s.hands[me] = [CARD.DEFUSE];
  s.deck = [CARD.SKIP, CARD.SKIP, CARD.BOMB];
  k.applyAction(s, { type: 'draw' }, me);
  k.applyAction(s, { type: 'place_bomb', position: 0 }, me);
  assert.strictEqual(s.deck[s.deck.length - 1], CARD.BOMB, 'position 0 = 牌堆顶,下一个人立刻抽到');
});

test('只有拆弹者本人能放置炸弹', () => {
  const s = started(3);
  const me = cur(s);
  s.hands[me] = [CARD.DEFUSE];
  s.deck = [CARD.SKIP, CARD.BOMB];
  k.applyAction(s, { type: 'draw' }, me);
  const other = s.order.find((id) => id !== me);
  assert.ok(k.applyAction(s, { type: 'place_bomb', position: 0 }, other).error);
});

// ── 否决窗口(本作最复杂的机制) ──

test('功能牌先进否决窗口,不立即生效', () => {
  const s = started(4);
  const me = cur(s);
  s.hands[me] = [CARD.SKIP, CARD.DEFUSE];
  k.applyAction(s, { type: 'play', cards: [CARD.SKIP] }, me);
  assert.strictEqual(s.phase, 'nope');
  assert.strictEqual(s.pending.card, CARD.SKIP);
  assert.strictEqual(cur(s), me, '窗口期间回合还没轮走');
});

test('单次否决使牌作废,回合仍属出牌者', () => {
  const s = started(4);
  const me = cur(s);
  s.hands[me] = [CARD.SKIP, CARD.DEFUSE];
  const other = s.order.find((id) => id !== me);
  s.hands[other] = [CARD.NOPE];

  k.applyAction(s, { type: 'play', cards: [CARD.SKIP] }, me);
  k.applyAction(s, { type: 'nope' }, other);
  s.deadline = Date.now() - 1;
  k.applyAction(s, { type: 'tick' }, null);

  assert.strictEqual(s.phase, 'playing');
  assert.strictEqual(cur(s), me, '跳过被否决,出牌者仍在自己的回合');
});

test('否决可以被再否决(偶数次 = 生效)', () => {
  const s = started(4);
  const me = cur(s);
  s.hands[me] = [CARD.SKIP, CARD.DEFUSE];
  const [a, b] = s.order.filter((id) => id !== me);
  s.hands[a] = [CARD.NOPE];
  s.hands[b] = [CARD.NOPE];

  k.applyAction(s, { type: 'play', cards: [CARD.SKIP] }, me);
  k.applyAction(s, { type: 'nope' }, a);      // 否决
  k.applyAction(s, { type: 'nope' }, b);      // 反否决
  assert.strictEqual(s.pending.nopes.length, 2);
  s.deadline = Date.now() - 1;
  k.applyAction(s, { type: 'tick' }, null);

  assert.notStrictEqual(cur(s), me, '两次否决相消,跳过生效,回合轮走');
});

test('没有否决牌不能否决', () => {
  const s = started(4);
  const me = cur(s);
  s.hands[me] = [CARD.SKIP, CARD.DEFUSE];
  const other = s.order.find((id) => id !== me);
  s.hands[other] = [CARD.SKIP];               // 没有 nope
  k.applyAction(s, { type: 'play', cards: [CARD.SKIP] }, me);
  assert.ok(k.applyAction(s, { type: 'nope' }, other).error);
});

// ── 回合与攻击 ──

test('攻击让下家连打两回合', () => {
  const s = started(4);
  const me = cur(s);
  s.hands[me] = [CARD.ATTACK, CARD.DEFUSE];
  k.applyAction(s, { type: 'play', cards: [CARD.ATTACK] }, me);
  s.deadline = Date.now() - 1;
  k.applyAction(s, { type: 'tick' }, null);

  assert.notStrictEqual(cur(s), me, '攻击后轮到下家');
  assert.strictEqual(s.turnsLeft, 2, '下家要打两回合');
});

test('不是当前玩家不能出牌/抽牌', () => {
  const s = started(4);
  const other = s.order.find((id) => id !== cur(s));
  s.hands[other] = [CARD.SKIP];
  assert.ok(k.applyAction(s, { type: 'play', cards: [CARD.SKIP] }, other).error);
  assert.ok(k.applyAction(s, { type: 'draw' }, other).error);
});

test('观战者不能行动', () => {
  const s = started(4);
  assert.ok(k.applyAction(s, { type: 'draw' }, '__spectator__').error);
  assert.ok(k.applyAction(s, { type: 'nope' }, '__spectator__').error);
});

test('猫咪牌必须成对且需要目标', () => {
  const s = started(4);
  const me = cur(s);
  s.hands[me] = [CARD.CAT_TACO, CARD.CAT_TACO, CARD.DEFUSE];
  assert.ok(k.applyAction(s, { type: 'play', cards: [CARD.CAT_TACO] }, me).error,
    '单张猫咪不能出');
  assert.ok(k.applyAction(s, { type: 'play', cards: [CARD.CAT_TACO, CARD.CAT_TACO] }, me).error,
    '偷牌必须指定目标');
});

// ── 三张 / 五张猫咪 ──

const settle = (s) => { s.deadline = Date.now() - 1; k.applyAction(s, { type: 'tick' }, null); };

test('三张同款:指名要牌,对方有就必须给', () => {
  const s = started(4);
  const me = cur(s);
  const t = s.order.find((id) => id !== me);
  s.hands[me] = [CARD.CAT_TACO, CARD.CAT_TACO, CARD.CAT_TACO];
  s.hands[t] = [CARD.DEFUSE, CARD.SKIP];

  const r = k.applyAction(s,
    { type: 'play', cards: [CARD.CAT_TACO, CARD.CAT_TACO, CARD.CAT_TACO], target: t, wanted: CARD.DEFUSE }, me);
  assert.ok(!r.error, r.error);
  settle(s);

  assert.ok(s.hands[me].includes(CARD.DEFUSE), '应拿到指名的牌');
  assert.ok(!s.hands[t].includes(CARD.DEFUSE), '对方应失去该牌');
});

test('三张同款:对方没有该牌则落空,且结果公开', () => {
  // 落空本身是有价值的公开信息("他没有拆弹"),这正是三张牌的试探价值
  const s = started(4);
  const me = cur(s);
  const t = s.order.find((id) => id !== me);
  s.hands[me] = [CARD.CAT_MELON, CARD.CAT_MELON, CARD.CAT_MELON];
  s.hands[t] = [CARD.SKIP];

  k.applyAction(s,
    { type: 'play', cards: [CARD.CAT_MELON, CARD.CAT_MELON, CARD.CAT_MELON], target: t, wanted: CARD.DEFUSE }, me);
  settle(s);

  assert.strictEqual(s.lastAction.type, 'demand');
  assert.strictEqual(s.lastAction.success, false, '落空要如实记录');
  assert.ok(s.log.some((e) => e.type === 'demand' && e.success === false), '落空要进公开日志');
});

test('三张必须报牌名,且必须同款', () => {
  const s = started(4);
  const me = cur(s);
  const t = s.order.find((id) => id !== me);
  s.hands[me] = [CARD.CAT_TACO, CARD.CAT_TACO, CARD.CAT_TACO];
  assert.ok(k.applyAction(s,
    { type: 'play', cards: [CARD.CAT_TACO, CARD.CAT_TACO, CARD.CAT_TACO], target: t }, me).error,
    '不报牌名应被拒');

  s.hands[me] = [CARD.CAT_TACO, CARD.CAT_TACO, CARD.CAT_MELON];
  assert.ok(k.applyAction(s,
    { type: 'play', cards: [CARD.CAT_TACO, CARD.CAT_TACO, CARD.CAT_MELON], target: t, wanted: CARD.SKIP }, me).error,
    '三张不同款应被拒');
});

test('五张不同:从弃牌堆捡走指定的牌', () => {
  const s = started(4);
  const me = cur(s);
  const five = [CARD.CAT_TACO, CARD.CAT_MELON, CARD.CAT_BEARD, CARD.CAT_RAINBOW, CARD.CAT_POTATO];
  s.hands[me] = [...five];
  s.discard = [CARD.SKIP, CARD.DEFUSE, CARD.ATTACK];

  k.applyAction(s, { type: 'play', cards: five, wanted: CARD.DEFUSE }, me);
  settle(s);

  assert.ok(s.hands[me].includes(CARD.DEFUSE), '应从弃牌堆拿到牌');
  assert.ok(!s.discard.includes(CARD.DEFUSE), '弃牌堆里该牌应被取走');
});

test('五张不能要弃牌堆里没有的牌', () => {
  const s = started(4);
  const me = cur(s);
  const five = [CARD.CAT_TACO, CARD.CAT_MELON, CARD.CAT_BEARD, CARD.CAT_RAINBOW, CARD.CAT_POTATO];
  s.hands[me] = [...five];
  s.discard = [CARD.SKIP];
  assert.ok(k.applyAction(s, { type: 'play', cards: five, wanted: CARD.DEFUSE }, me).error);
});

test('三张/五张同样要过否决窗口', () => {
  const s = started(4);
  const me = cur(s);
  const t = s.order.find((id) => id !== me);
  s.hands[me] = [CARD.CAT_TACO, CARD.CAT_TACO, CARD.CAT_TACO];
  s.hands[t] = [CARD.NOPE, CARD.DEFUSE];

  k.applyAction(s,
    { type: 'play', cards: [CARD.CAT_TACO, CARD.CAT_TACO, CARD.CAT_TACO], target: t, wanted: CARD.DEFUSE }, me);
  assert.strictEqual(s.phase, 'nope', '要牌也能被否决');
  k.applyAction(s, { type: 'nope' }, t);
  settle(s);
  assert.ok(s.hands[t].includes(CARD.DEFUSE), '被否决后对方保住了牌');
});

// ── 索要(被索要者自选) ──

test('索要进入 favor 阶段,由被索要者自己挑牌', () => {
  const s = started(4);
  const me = cur(s);
  const t = s.order.find((id) => id !== me);
  s.hands[me] = [CARD.FAVOR, CARD.DEFUSE];
  s.hands[t] = [CARD.SKIP, CARD.DEFUSE];

  k.applyAction(s, { type: 'play', cards: [CARD.FAVOR], target: t }, me);
  settle(s);
  assert.strictEqual(s.phase, 'favor', '索要生效后应等对方挑牌');

  // 对方会给最没用的那张 —— 这正是原版的博弈点
  k.applyAction(s, { type: 'give_card', card: CARD.SKIP }, t);
  assert.ok(s.hands[me].includes(CARD.SKIP), '索要者应拿到对方给的牌');
  assert.ok(s.hands[t].includes(CARD.DEFUSE), '对方留下了想留的牌');
  assert.strictEqual(s.phase, 'playing');
  assert.strictEqual(cur(s), me, '索要不结束回合');
});

test('索要者看不到对方手牌,也不能替他选', () => {
  // "给最没用的那张"这个博弈,前提就是索要者不知道对方在藏什么
  const s = started(4);
  const me = cur(s);
  const t = s.order.find((id) => id !== me);
  // 用一个只可能来自对方手牌的哨兵值,避免和自己的手牌/弃牌堆/日志混淆
  const CANARY = '__only_in_target_hand__';
  s.hands[me] = [CARD.FAVOR];
  s.hands[t] = [CARD.SKIP, CANARY];
  s.discard = [];
  k.applyAction(s, { type: 'play', cards: [CARD.FAVOR], target: t }, me);
  settle(s);

  const view = k.serializeStateFor(s, me);
  assert.strictEqual(view.iAmGiving, false);
  assert.strictEqual(view.hands, undefined);

  // 扫描整份视图(排除自己的手牌)。不能只检查已知字段名 —— 否则将来有人
  // 为了做 UI 新加一个 targetHand 就漏过去了,而且不会有任何东西报错。
  const dump = JSON.stringify({ ...view, myHand: null });
  assert.ok(!dump.includes(CANARY),
    '索要者的视图里不该出现对方手牌的任何内容');

  assert.ok(k.applyAction(s, { type: 'give_card', index: 0 }, me).error, '不能替对方选牌');
});

test('索要超时随机给一张,不会卡住', () => {
  const s = started(4);
  const me = cur(s);
  const t = s.order.find((id) => id !== me);
  s.hands[me] = [CARD.FAVOR];
  s.hands[t] = [CARD.SKIP];
  k.applyAction(s, { type: 'play', cards: [CARD.FAVOR], target: t }, me);
  settle(s);
  assert.strictEqual(s.phase, 'favor');

  settle(s);   // favor 阶段再超时
  assert.strictEqual(s.phase, 'playing', '超时应自动给牌并继续');
  assert.ok(s.hands[me].includes(CARD.SKIP));
});

test('对方没有手牌时索要直接跳过', () => {
  const s = started(4);
  const me = cur(s);
  const t = s.order.find((id) => id !== me);
  s.hands[me] = [CARD.FAVOR];
  s.hands[t] = [];
  k.applyAction(s, { type: 'play', cards: [CARD.FAVOR], target: t }, me);
  settle(s);
  assert.strictEqual(s.phase, 'playing', '没牌可给就不该进入等待阶段');
});

test('弃牌堆内容是公开的(五张需要据此挑牌)', () => {
  const s = started(4);
  s.discard = [CARD.SKIP, CARD.ATTACK];
  const view = k.serializeStateFor(s, s.order[1]);
  assert.deepStrictEqual(view.discard, [CARD.SKIP, CARD.ATTACK], '弃牌堆是桌面公开信息');
});

// ── 胜负 ──

test('只剩一人时结束,名次按出局顺序倒推', () => {
  const s = started(3);
  const a = s.order[0];
  s.hands[a] = []; s.deck = [CARD.BOMB];
  k.applyAction(s, { type: 'draw' }, a);      // a 先出局
  assert.strictEqual(s.alive[a], false);

  const nowCur = cur(s);
  s.hands[nowCur] = []; s.deck = [CARD.BOMB];
  k.applyAction(s, { type: 'draw' }, nowCur);

  assert.strictEqual(s.phase, 'ended');
  const over = k.isGameOver(s);
  assert.strictEqual(over.ranking.length, 3, '所有人都该有名次');
  assert.strictEqual(over.ranking[over.ranking.length - 1].id, a, '最先出局的排最后');
});
