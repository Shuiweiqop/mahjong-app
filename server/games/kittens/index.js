// 炸弹猫(Exploding Kittens)—— 服务端权威游戏模块。
//
// 实现平台统一游戏接口:
//   createInitialState(players, config)
//   applyAction(state, action, playerId) -> { state, events, error }
//   serializeStateFor(state, playerId)   -> 每人只看得到自己的手牌
//   isGameOver(state)                    -> { over, ranking } | false
//
// 阶段状态机:
//   lobby → playing ⇄ nope(否决响应窗口) → [defusing(选择炸弹插回位置)] → ended
//   playing  轮到的人可以出牌或抽牌;抽到炸弹且有拆弹 → defusing
//   nope     刚打出一张功能牌,等其他人是否否决。否决本身也进这个窗口(可反否决)
//   defusing 只有当事人能操作:选炸弹塞回牌堆的位置
//
// 信息隔离的核心:state.deck(牌堆顺序)和 state.hands(每人手牌)绝不整份下发。
// 玩家只看得到自己的手牌 + 别人的手牌"张数"。洞悉未来的三张只发给用牌的人。
// 所有阶段时长由房主配置,不写死。纯逻辑,不碰 socket/db(见 rules.test.js)。

const { CARD, CAT_CARDS, ACTION_CARDS, CARD_INFO, buildDeck } = require('./cards');

const DEFAULTS = {
  nopeSeconds: 6,      // 否决响应窗口:出功能牌后等多久看有没有人否决
  turnSeconds: 60,     // 单回合思考时间
  defuseSeconds: 20,   // 拆弹后选择炸弹插回位置的时间
};
const TIME_OPTIONS = {
  nopeSeconds: [3, 5, 6, 10],
  turnSeconds: [30, 45, 60, 90],
  defuseSeconds: [10, 20, 30],
};

const now = () => Date.now();

function normalizeConfig(cfg = {}) {
  const out = {};
  for (const [key, options] of Object.entries(TIME_OPTIONS)) {
    out[key] = options.includes(cfg[key]) ? cfg[key] : DEFAULTS[key];
  }
  return out;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── 创建初始状态 ──
// 发牌规则:每人 1 张拆弹 + 7 张普通牌;剩余牌里塞入 (人数-1) 张炸弹和多余拆弹。
// 炸弹比人数少 1 —— 这保证了最后必然恰好剩一个人。
function createInitialState(players, config = {}) {
  const ids = players.map((p) => p.id);
  const pool = shuffle(buildDeck(ids.length));

  const hands = {};
  for (const id of ids) {
    hands[id] = [CARD.DEFUSE, ...pool.splice(0, 7)];
  }
  // 剩下的牌 + 炸弹 + 余下拆弹,洗匀成牌堆
  const deck = [...pool];
  for (let i = 0; i < ids.length - 1; i++) deck.push(CARD.BOMB);
  const extraDefuse = Math.max(0, 6 - ids.length);
  for (let i = 0; i < extraDefuse; i++) deck.push(CARD.DEFUSE);

  return {
    phase: 'lobby',                   // lobby | playing | nope | defusing | ended
    cfg: normalizeConfig(config),
    players: players.map((p) => ({ id: p.id, name: p.name })),
    hands,                            // { playerId: [card] } —— 绝不整份下发
    deck: shuffle(deck),              // 牌堆(顶部是末尾)—— 绝不下发
    discard: [],                      // 弃牌堆(公开)
    alive: Object.fromEntries(ids.map((id) => [id, true])),
    absent: {},
    order: ids,                       // 座位顺序
    turnIndex: 0,
    turnsLeft: 1,                     // 当前玩家还要打几个回合(攻击会叠加)
    pending: null,                     // 待结算的功能牌 { by, card, payload, nopes }
    defusing: null,                    // { playerId } 正在选炸弹插回位置
    future: {},                        // { playerId: [card,card,card] } 洞悉未来的结果,仅本人可见
    lastAction: null,                  // 公开的最近一次动作播报
    ranking: [],                       // 出局顺序(倒序即名次)
    deadline: null,
    pausedRemainMs: null,
    log: [],
    hostId: players[0]?.id || null,
  };
}

const aliveIds = (s) => s.order.filter((id) => s.alive[id]);
const presentIds = (s) => aliveIds(s).filter((id) => !s.absent[id]);
const currentPlayer = (s) => s.order[s.turnIndex] ?? null;

function setDeadline(s, seconds) {
  s.deadline = now() + seconds * 1000;
  s.pausedRemainMs = null;
}

// 轮到下一个存活玩家。攻击造成的多回合由 turnsLeft 表达:
// 还有剩余回合就不换人,只是重新计时。
function nextTurn(s, extraTurns = 0) {
  if (extraTurns > 0) {
    // 攻击:当前玩家结束,下家要打 extraTurns 个回合
    advanceSeat(s);
    s.turnsLeft = extraTurns;
  } else {
    s.turnsLeft -= 1;
    if (s.turnsLeft <= 0) {
      advanceSeat(s);
      s.turnsLeft = 1;
    }
  }
  s.phase = 'playing';
  setDeadline(s, s.cfg.turnSeconds);
}

function advanceSeat(s) {
  const living = aliveIds(s);
  if (!living.length) return;
  for (let i = 1; i <= s.order.length; i++) {
    const idx = (s.turnIndex + i) % s.order.length;
    if (s.alive[s.order[idx]]) { s.turnIndex = idx; return; }
  }
}

// 出局。炸弹猫是淘汰制,名次按出局顺序倒推。
function eliminate(s, id, reason) {
  if (!s.alive[id]) return;
  s.alive[id] = false;
  s.ranking.unshift(id);          // 越晚出局排名越前
  s.discard.push(...(s.hands[id] || []));
  s.hands[id] = [];
  s.log.push({ type: 'eliminated', playerId: id, reason });
}

function checkWin(s) {
  const living = aliveIds(s);
  if (living.length <= 1) {
    if (living.length === 1) s.ranking.unshift(living[0]);
    s.phase = 'ended';
    s.deadline = null;
    return true;
  }
  return false;
}

// 从手牌移除若干张指定牌;返回是否成功(不够就不动)
function takeFromHand(hand, cards) {
  const copy = [...hand];
  for (const c of cards) {
    const i = copy.indexOf(c);
    if (i < 0) return null;
    copy.splice(i, 1);
  }
  return copy;
}

// ── 否决窗口 ──
// 所有功能牌打出后先进 pending,等 nopeSeconds。期间任何存活玩家可以出否决牌。
// 否决数为奇数 → 被否决(不生效);偶数 → 生效。这样"否决的否决"自然成立。
function openNopeWindow(s, by, card, payload) {
  s.pending = { by, card, payload: payload || {}, nopes: [] };
  s.phase = 'nope';
  setDeadline(s, s.cfg.nopeSeconds);
  s.log.push({ type: 'played', playerId: by, card });
}

// 结算 pending:根据否决次数决定生效与否
function resolvePending(s) {
  const p = s.pending;
  if (!p) { nextTurn(s); return; }
  s.pending = null;

  const nopedOut = p.nopes.length % 2 === 1;
  s.log.push({ type: 'resolved', playerId: p.by, card: p.card, noped: nopedOut });
  if (nopedOut) {
    // 被否决:牌作废,回合继续(出牌者仍在自己的回合里)
    s.phase = 'playing';
    setDeadline(s, s.cfg.turnSeconds);
    return;
  }
  applyCardEffect(s, p.by, p.card, p.payload);
}

// 功能牌真正生效
function applyCardEffect(s, by, card, payload) {
  switch (card) {
    case CARD.SKIP:
      nextTurn(s);
      return;

    case CARD.ATTACK:
      nextTurn(s, 2);
      return;

    case CARD.SHUFFLE:
      s.deck = shuffle(s.deck);
      s.phase = 'playing';
      setDeadline(s, s.cfg.turnSeconds);
      return;

    case CARD.FUTURE:
      // 只给出牌者看顶部三张 —— 这是本模块唯一"部分可见"的隐藏信息
      s.future[by] = s.deck.slice(-3).reverse();
      s.phase = 'playing';
      setDeadline(s, s.cfg.turnSeconds);
      return;

    case CARD.FAVOR: {
      const target = payload.target;
      if (target && s.alive[target] && s.hands[target]?.length) {
        // 简化:随机给一张(原版是对方自选,那需要又一个等待阶段)
        const hand = s.hands[target];
        const i = Math.floor(Math.random() * hand.length);
        const [got] = hand.splice(i, 1);
        s.hands[by].push(got);
        s.lastAction = { type: 'favor', by, target };
      }
      s.phase = 'playing';
      setDeadline(s, s.cfg.turnSeconds);
      return;
    }

    case 'cat_pair': {
      // 两张同款猫咪 → 随机偷目标一张
      const target = payload.target;
      if (target && s.alive[target] && s.hands[target]?.length) {
        const hand = s.hands[target];
        const i = Math.floor(Math.random() * hand.length);
        const [got] = hand.splice(i, 1);
        s.hands[by].push(got);
        s.lastAction = { type: 'steal', by, target };
      }
      s.phase = 'playing';
      setDeadline(s, s.cfg.turnSeconds);
      return;
    }

    default:
      s.phase = 'playing';
      setDeadline(s, s.cfg.turnSeconds);
  }
}

// 抽一张牌,结束回合。抽到炸弹要特殊处理。
function drawCard(s, playerId) {
  const events = [];
  if (!s.deck.length) {
    // 牌堆空了(极端情况):直接进入下一回合
    nextTurn(s);
    return events;
  }
  const card = s.deck.pop();
  delete s.future[playerId];        // 抽过牌,之前偷看的信息作废

  if (card !== CARD.BOMB) {
    s.hands[playerId].push(card);
    s.log.push({ type: 'drew', playerId });
    nextTurn(s);
    return events;
  }

  // 抽到炸弹
  s.log.push({ type: 'drew_bomb', playerId });
  const hand = s.hands[playerId];
  const defuseIdx = hand.indexOf(CARD.DEFUSE);
  if (defuseIdx < 0) {
    // 没有拆弹 → 出局
    s.discard.push(card);
    eliminate(s, playerId, 'bomb');
    events.push({ type: 'exploded', playerId });
    if (!checkWin(s)) {
      // 出局者的回合直接结束,轮到下一位
      s.turnsLeft = 1;
      advanceSeat(s);
      s.phase = 'playing';
      setDeadline(s, s.cfg.turnSeconds);
    }
    return events;
  }

  // 有拆弹 → 化解,并进入"选择炸弹插回位置"
  hand.splice(defuseIdx, 1);
  s.discard.push(CARD.DEFUSE);
  s.defusing = { playerId, bomb: card };
  s.phase = 'defusing';
  setDeadline(s, s.cfg.defuseSeconds);
  events.push({ type: 'defused', playerId });
  s.log.push({ type: 'defused', playerId });
  return events;
}

// ── 应用动作 ──
// { type:'start' }                           房主开始
// { type:'play', cards:[card], target? }     出牌(功能牌或成对猫咪)
// { type:'nope' }                            否决(仅 nope 阶段)
// { type:'draw' }                            主动抽牌结束回合
// { type:'place_bomb', position }            拆弹后把炸弹塞回牌堆
// { type:'tick' }                            服务端计时器
function applyAction(s, action, playerId) {
  const events = [];

  // 观战者与非本局玩家不能行动(tick 由服务端驱动,playerId 为 null)
  if (action.type !== 'tick' && !(playerId in s.alive)) {
    return { error: '你不是本局玩家' };
  }

  switch (action.type) {
    case 'start': {
      if (playerId !== s.hostId) return { error: '只有房主能开始' };
      if (s.phase !== 'lobby') return { error: '游戏已开始' };
      if (s.players.length < 2) return { error: '至少需要 2 名玩家' };
      s.phase = 'playing';
      s.turnIndex = 0;
      s.turnsLeft = 1;
      setDeadline(s, s.cfg.turnSeconds);
      return { state: s, events };
    }

    // 否决:任何存活玩家都能出,不限于当前回合的人
    case 'nope': {
      if (s.phase !== 'nope' || !s.pending) return { error: '现在没有可否决的牌' };
      if (!s.alive[playerId]) return { error: '你已出局' };
      const hand = takeFromHand(s.hands[playerId], [CARD.NOPE]);
      if (!hand) return { error: '你没有否决牌' };
      s.hands[playerId] = hand;
      s.discard.push(CARD.NOPE);
      s.pending.nopes.push(playerId);
      // 每次否决都重开窗口 —— 否决可以被再否决
      setDeadline(s, s.cfg.nopeSeconds);
      s.log.push({ type: 'noped', playerId });
      return { state: s, events };
    }

    case 'play': {
      if (s.phase !== 'playing') return { error: '现在不能出牌' };
      if (playerId !== currentPlayer(s)) return { error: '还没轮到你' };
      const cards = Array.isArray(action.cards) ? action.cards : [];
      if (!cards.length) return { error: '没有选牌' };

      // 成对猫咪:两张同款 → 偷牌
      if (cards.length === 2 && cards[0] === cards[1] && CAT_CARDS.includes(cards[0])) {
        const rest = takeFromHand(s.hands[playerId], cards);
        if (!rest) return { error: '你没有这些牌' };
        if (!action.target || !s.alive[action.target] || action.target === playerId) {
          return { error: '请选择一名有效的目标玩家' };
        }
        s.hands[playerId] = rest;
        s.discard.push(...cards);
        openNopeWindow(s, playerId, 'cat_pair', { target: action.target });
        return { state: s, events };
      }

      if (cards.length !== 1) return { error: '一次只能出一张功能牌,或两张同款猫咪' };
      const card = cards[0];
      if (!ACTION_CARDS.includes(card)) return { error: '这张牌不能单独打出' };
      if (card === CARD.FAVOR) {
        if (!action.target || !s.alive[action.target] || action.target === playerId) {
          return { error: '索要需要指定一名有效目标' };
        }
      }
      const rest = takeFromHand(s.hands[playerId], [card]);
      if (!rest) return { error: '你没有这张牌' };
      s.hands[playerId] = rest;
      s.discard.push(card);
      openNopeWindow(s, playerId, card, { target: action.target });
      return { state: s, events };
    }

    case 'draw': {
      if (s.phase !== 'playing') return { error: '现在不能抽牌' };
      if (playerId !== currentPlayer(s)) return { error: '还没轮到你' };
      events.push(...drawCard(s, playerId));
      return { state: s, events };
    }

    // 拆弹后把炸弹塞回牌堆。position 从牌堆顶算起(0 = 下一个人立刻抽到)
    case 'place_bomb': {
      if (s.phase !== 'defusing') return { error: '现在不用放置炸弹' };
      if (!s.defusing || playerId !== s.defusing.playerId) return { error: '不是你在拆弹' };
      const bomb = s.defusing.bomb;
      const max = s.deck.length;
      let pos = Number.isInteger(action.position) ? action.position : Math.floor(Math.random() * (max + 1));
      pos = Math.min(max, Math.max(0, pos));
      // deck 末尾是顶部,所以"从顶部数第 pos 张"= 插在 length - pos
      s.deck.splice(max - pos, 0, bomb);
      s.defusing = null;
      nextTurn(s);
      return { state: s, events };
    }

    case 'tick': {
      if (s.phase === 'ended' || !s.deadline || now() < s.deadline) return { state: s, events };
      if (s.phase === 'nope') {
        resolvePending(s);
      } else if (s.phase === 'defusing') {
        // 超时:随机位置塞回
        const bomb = s.defusing?.bomb;
        if (bomb) {
          const pos = Math.floor(Math.random() * (s.deck.length + 1));
          s.deck.splice(pos, 0, bomb);
        }
        s.defusing = null;
        nextTurn(s);
      } else if (s.phase === 'playing') {
        // 回合超时:强制抽牌(这也是原版的自然结果 —— 你总得抽)
        const cur = currentPlayer(s);
        if (cur) events.push(...drawCard(s, cur));
      }
      return { state: s, events };
    }

    default:
      return { error: '未知动作' };
  }
}

// ── 掉线/重连/离开 ──
function removePlayer(s, playerId) {
  if (!s || !(playerId in s.alive)) return;
  s.absent[playerId] = true;
  if (s.phase === 'ended') return;
  // 轮到掉线者时不要卡住:直接替他抽牌结束回合
  if (s.phase === 'playing' && currentPlayer(s) === playerId && presentIds(s).length) {
    drawCard(s, playerId);
  }
}

function restorePlayer(s, playerId) {
  if (!s || !(playerId in s.alive)) return;
  delete s.absent[playerId];
}

// 宽限期后真正离开 → 判出局并重跑胜负
function eliminatePlayer(s, playerId) {
  if (!s || s.phase === 'ended' || !s.alive[playerId]) return [];
  const wasCurrent = currentPlayer(s) === playerId;
  eliminate(s, playerId, 'left');
  delete s.absent[playerId];
  if (checkWin(s)) return [{ type: 'game_over' }];
  if (wasCurrent) {
    s.turnsLeft = 1;
    advanceSeat(s);
    s.phase = 'playing';
    setDeadline(s, s.cfg.turnSeconds);
  }
  return [];
}

function pauseClock(s) {
  if (!s || s.phase === 'ended' || s.deadline == null) return;
  s.pausedRemainMs = Math.max(0, s.deadline - now());
  s.deadline = null;
}
function resumeClock(s) {
  if (!s || s.phase === 'ended' || s.pausedRemainMs == null) return;
  s.deadline = now() + s.pausedRemainMs;
  s.pausedRemainMs = null;
}

// ── 分玩家序列化视图(信息隔离) ──
// 白名单构造。绝不放 deck(牌堆顺序)和 hands(所有人手牌)——
// 前者泄露了炸弹在哪,后者泄露了所有人握着什么。
function serializeStateFor(s, playerId) {
  const view = {
    phase: s.phase,
    players: s.players.map((p) => ({
      id: p.id, name: p.name,
      alive: !!s.alive[p.id],
      absent: !!s.absent[p.id],
      handCount: (s.hands[p.id] || []).length,   // 只给张数,不给内容
    })),
    myId: playerId,
    myHand: s.hands[playerId] ? [...s.hands[playerId]] : [],  // 只有自己的手牌
    alive: !!s.alive[playerId],
    currentPlayer: currentPlayer(s),
    isMyTurn: currentPlayer(s) === playerId && s.phase === 'playing',
    turnsLeft: s.turnsLeft,
    deckCount: s.deck.length,                     // 只给剩余张数,不给顺序
    discardTop: s.discard[s.discard.length - 1] ?? null,
    discardCount: s.discard.length,
    log: s.log.slice(-30),
    lastAction: s.lastAction,
    hostId: s.hostId,
    deadline: s.deadline,
    cfg: s.cfg,
  };

  // 否决窗口:大家都要看到"谁打了什么牌、被否决了几次",否则没法决定要不要否决
  if (s.phase === 'nope' && s.pending) {
    view.pending = {
      by: s.pending.by,
      card: s.pending.card,
      target: s.pending.payload?.target ?? null,
      nopeCount: s.pending.nopes.length,
    };
    view.iCanNope = !!s.alive[playerId] && (s.hands[playerId] || []).includes(CARD.NOPE);
  }

  // 拆弹:只有当事人能看到自己在拆弹并选择位置。别人只知道"有人在拆弹"。
  if (s.phase === 'defusing' && s.defusing) {
    view.defusingBy = s.defusing.playerId;
    view.iAmDefusing = s.defusing.playerId === playerId;
    if (view.iAmDefusing) view.deckSize = s.deck.length;
  }

  // 洞悉未来:只发给用了牌的人
  if (s.future[playerId]) view.myFuture = s.future[playerId];

  // 结束时公开名次
  if (s.phase === 'ended') {
    view.ranking = s.ranking.map((id) => ({
      id, name: s.players.find((p) => p.id === id)?.name || '玩家',
    }));
  }
  return view;
}

function isGameOver(s) {
  if (s.phase !== 'ended') return false;
  const ranking = s.ranking.map((id, i) => ({
    id,
    name: s.players.find((p) => p.id === id)?.name || '玩家',
    score: Math.max(0, s.players.length - i),
  }));
  return { over: true, ranking };
}

module.exports = {
  id: 'kittens',
  displayName: '炸弹猫',
  minPlayers: 2,
  maxPlayers: 8,
  createInitialState,
  applyAction,
  serializeStateFor,
  isGameOver,
  removePlayer,
  restorePlayer,
  eliminatePlayer,
  pauseClock,
  resumeClock,
  CARD,
  CARD_INFO,
  configSchema: {
    turnSeconds: { type: 'options', options: TIME_OPTIONS.turnSeconds, default: DEFAULTS.turnSeconds,
                   unit: 's', label: '单回合时长', hint: '超时会自动替你抽牌' },
    nopeSeconds: { type: 'options', options: TIME_OPTIONS.nopeSeconds, default: DEFAULTS.nopeSeconds,
                   unit: 's', label: '否决响应窗口', hint: '出功能牌后等待其他人否决的时间' },
    defuseSeconds: { type: 'options', options: TIME_OPTIONS.defuseSeconds, default: DEFAULTS.defuseSeconds,
                     unit: 's', label: '拆弹放置时长', hint: '选择炸弹塞回牌堆位置的时间' },
  },
};
