// 你画我猜(Draw & Guess)—— 服务端权威游戏模块。
//
// 实现平台统一游戏接口:
//   createInitialState(players)
//   applyAction(state, action, playerId) -> { state, events, error }
//   serializeStateFor(state, playerId)   -> 该玩家可见的视图(画手可见词、猜者不可见)
//   isGameOver(state)                    -> { over, ranking } | false
//
// 状态全部放内存(由上层 rooms 管理器持有)。纯逻辑,不碰 socket/db,便于测试。

const { pickWords, buildWordPool } = require('./words');

const REVEAL_SECONDS = 5;       // 揭晓/间隔时长
const PICK_SECONDS = 15;        // 画手选词时长

// 房主可配置项的默认值与取值范围
const DEFAULTS = { drawSeconds: 80, roundsPerPlayer: 2, categories: [], customWords: [] };
const DRAW_SECONDS_OPTIONS = [45, 60, 80, 120];
const ROUNDS_OPTIONS = [1, 2, 3];

const now = () => Date.now();

// 规整房主传入的配置,防非法值
function normalizeConfig(cfg = {}) {
  const drawSeconds = DRAW_SECONDS_OPTIONS.includes(cfg.drawSeconds) ? cfg.drawSeconds : DEFAULTS.drawSeconds;
  const roundsPerPlayer = ROUNDS_OPTIONS.includes(cfg.roundsPerPlayer) ? cfg.roundsPerPlayer : DEFAULTS.roundsPerPlayer;
  const categories = Array.isArray(cfg.categories) ? cfg.categories : [];
  const customWords = Array.isArray(cfg.customWords)
    ? cfg.customWords.map((w) => String(w).trim()).filter(Boolean).slice(0, 100)
    : [];
  return { drawSeconds, roundsPerPlayer, categories, customWords };
}

// ── 创建初始状态 ──────────────────────────────────────────
// players: [{ id, name }];  config: 房主设置(可选)
function createInitialState(players, config) {
  const cfg = normalizeConfig(config);
  const pool = buildWordPool({ categories: cfg.categories, customWords: cfg.customWords });
  return {
    phase: 'lobby',                 // lobby | pick | draw | reveal | ended
    players: players.map((p) => ({ id: p.id, name: p.name })),
    scores: Object.fromEntries(players.map((p) => [p.id, 0])),
    order: players.map((p) => p.id),// 画手轮转顺序
    turnIndex: -1,                  // 当前在 order 里的位置
    roundsTotal: players.length * cfg.roundsPerPlayer,
    roundsDone: 0,
    drawerId: null,
    wordChoices: [],                // 画手选词阶段的候选
    word: null,                     // 当前词(仅内部/画手可见)
    usedWords: [],
    guessedThisRound: {},           // { playerId: pointsAwarded }
    absent: {},                     // 掉线玩家 { playerId: true };不轮到、不计入"全猜中"
    pausedRemainMs: null,           // 房间无连接时挂起的剩余时长(见 pauseClock)
    strokes: [],                    // 当前轮已画笔画(用于中途加入者补画)
    deadline: null,                 // 当前阶段截止时间戳(ms)
    hostId: players[0]?.id || null,
    cfg,                            // 保存配置供后续使用
    wordPool: pool,                 // 该局词池
  };
}

// ── 内部:进入下一轮(选词阶段) ───────────────────────────
function startNextTurn(state) {
  const events = [];
  if (state.roundsDone >= state.roundsTotal) {
    state.phase = 'ended';
    state.drawerId = null;
    state.deadline = null;
    events.push({ type: 'game_over' });
    return events;
  }

  if (state.order.length === 0) {           // 全员掉线兜底
    state.phase = 'ended';
    state.drawerId = null;
    state.deadline = null;
    events.push({ type: 'game_over' });
    return events;
  }
  state.turnIndex = (state.turnIndex + 1) % state.order.length;
  state.drawerId = state.order[state.turnIndex];
  state.phase = 'pick';
  state.word = null;
  state.strokes = [];
  state.guessedThisRound = {};
  state.wordChoices = pickWords(3, state.usedWords, state.wordPool).map((w) => w.word);
  state.deadline = now() + PICK_SECONDS * 1000;
  events.push({ type: 'round_changed', drawerId: state.drawerId });
  return events;
}

// ── 内部:结束本轮(揭晓) ─────────────────────────────────
function endRound(state, reason) {
  state.roundsDone += 1;
  state.phase = 'reveal';
  state.deadline = now() + REVEAL_SECONDS * 1000;
  return [{ type: 'reveal', word: state.word, reason, scores: { ...state.scores } }];
}

// ── 应用一个动作(服务端权威校验) ─────────────────────────
// action: { type, ... }
//   { type:'start' }                        房主开始游戏
//   { type:'pick', word }                   画手选定词
//   { type:'stroke', stroke }               画手画一笔
//   { type:'clear' }                        画手清空画布
//   { type:'guess', text }                  猜者提交猜测
//   { type:'tick' }                         服务端计时器驱动(检查是否到点)
function applyAction(state, action, playerId) {
  const events = [];

  switch (action.type) {
    case 'start': {
      if (playerId !== state.hostId) return { error: '只有房主能开始' };
      if (state.phase !== 'lobby') return { error: '游戏已开始' };
      if (state.players.length < 2) return { error: '至少需要 2 名玩家' };
      events.push(...startNextTurn(state));
      return { state, events };
    }

    case 'pick': {
      if (state.phase !== 'pick') return { error: '当前不是选词阶段' };
      if (playerId !== state.drawerId) return { error: '只有画手能选词' };
      if (!state.wordChoices.includes(action.word)) return { error: '无效的词' };
      state.word = action.word;
      state.usedWords.push(action.word);
      state.wordChoices = [];
      state.phase = 'draw';
      state.deadline = now() + state.cfg.drawSeconds * 1000;
      events.push({ type: 'draw_started', deadline: state.deadline });
      return { state, events };
    }

    case 'stroke': {
      if (state.phase !== 'draw') return { error: '当前不能作画' };
      if (playerId !== state.drawerId) return { error: '只有画手能画' };
      // 支持一批笔画(降延迟)或单笔(兼容)
      const strokes = action.strokes || (action.stroke ? [action.stroke] : []);
      for (const s of strokes) state.strokes.push(s);
      events.push({ type: 'stroke', strokes, forOthers: true });
      return { state, events };
    }

    case 'clear': {
      if (state.phase !== 'draw') return { error: '当前不能清空' };
      if (playerId !== state.drawerId) return { error: '只有画手能清空' };
      state.strokes = [];
      events.push({ type: 'clear' });
      return { state, events };
    }

    case 'guess': {
      if (state.phase !== 'draw') return { error: '当前不能猜词' };
      if (playerId === state.drawerId) return { error: '画手不能猜' };
      if (state.guessedThisRound[playerId]) return { error: '你已经猜中了' };

      const guess = (action.text || '').trim();
      const correct = guess === state.word;

      if (correct) {
        // 计分:剩余时间越多分越高;画手也按猜中人数得分
        const remaining = Math.max(0, (state.deadline - now()) / 1000);
        const pts = 100 + Math.round((remaining / state.cfg.drawSeconds) * 100);
        state.scores[playerId] = (state.scores[playerId] || 0) + pts;
        state.guessedThisRound[playerId] = pts;
        state.scores[state.drawerId] = (state.scores[state.drawerId] || 0) + 25;
        events.push({ type: 'guessed', playerId, points: pts });

        // 所有在场的非画手都猜中 → 提前结束本轮(掉线者不计,否则永远凑不齐)
        const guessers = state.players.filter(
          (p) => p.id !== state.drawerId && !state.absent[p.id]
        );
        const allGuessed = guessers.length > 0 && guessers.every((p) => state.guessedThisRound[p.id]);
        if (allGuessed) events.push(...endRound(state, 'all_guessed'));
        return { state, events };
      } else {
        // 猜错 → 作为普通聊天广播(不泄露正确答案)
        events.push({ type: 'chat', playerId, text: guess });
        return { state, events };
      }
    }

    case 'tick': {
      // 服务端计时器:检查当前阶段是否到点,推进状态
      if (!state.deadline || now() < state.deadline) return { state, events };
      if (!state.drawerId) return { state, events };   // 轮转空(全掉线挂起中),无可推进
      if (state.phase === 'pick') {
        // 画手没选 → 自动选第一个
        if (state.wordChoices.length) {
          return applyAction(state, { type: 'pick', word: state.wordChoices[0] }, state.drawerId);
        }
      } else if (state.phase === 'draw') {
        events.push(...endRound(state, 'timeout'));
      } else if (state.phase === 'reveal') {
        events.push(...startNextTurn(state));
      }
      return { state, events };
    }

    default:
      return { error: '未知动作' };
  }
}

// ── 掉线/重连 ──────────────────────────────────────────────
// 掉线者移出画手轮转,并且不再计入"全员猜中"。分数保留,重连可继续。
function removePlayer(state, playerId) {
  if (!state || state.phase === 'ended') return [];
  if (!state.order.includes(playerId) && !state.absent[playerId]) return [];
  state.absent[playerId] = true;

  const idx = state.order.indexOf(playerId);
  if (idx !== -1) {
    state.order.splice(idx, 1);
    // 维持 turnIndex 指向"当前画手"的语义:删掉的位置在当前之前(或就是当前)时前移,
    // 否则下一次 +1 会跳过一个人 / 重复当前这个人。
    if (idx <= state.turnIndex) state.turnIndex -= 1;
  }

  // 轮转里没人了:不就地结束对局 —— 全员短暂掉线(如切网)后仍应能重连续玩。
  // 只把当前轮挂起(没有画手可选),真正的结束交给上层宽限期超时后的清理。
  // 注意 startNextTurn 对空 order 取模会得到 NaN,所以这里必须提前返回。
  // deadline 不在这里动:停表由上层按"房间还有没有连接"决定(见 pauseClock)。
  if (state.order.length === 0) {
    state.drawerId = null;
    return [];
  }

  // 当前画手掉线 → 本轮作废,立刻进入下一轮(否则空转到超时)
  if (playerId === state.drawerId && (state.phase === 'pick' || state.phase === 'draw')) {
    return startNextTurn(state);
  }

  // 掉线的可能是大家在等的最后一个猜者 → 重新检查能否提前结束本轮
  if (state.phase === 'draw') {
    const guessers = state.players.filter(
      (p) => p.id !== state.drawerId && !state.absent[p.id]
    );
    if (guessers.length > 0 && guessers.every((p) => state.guessedThisRound[p.id])) {
      return endRound(state, 'all_guessed');
    }
  }
  return [];
}

// 重连:恢复在场并放回轮转队尾(分数一直保留)
function restorePlayer(state, playerId) {
  if (!state || !state.absent[playerId]) return [];
  delete state.absent[playerId];
  if (state.phase === 'ended') return [];
  if (!state.order.includes(playerId)) state.order.push(playerId);
  // 曾因轮转清空被挂起(无画手)→ 有人回来了,重新开一轮
  if (!state.drawerId && state.phase !== 'lobby') {
    state.turnIndex = -1;
    state.pausedRemainMs = null;   // 重开一轮会设新 deadline,旧的挂起值作废
    return startNextTurn(state);
  }
  return [];
}

// 宽限期超时仍未回来 → 永久移出,并按剩余人数收缩总轮数。
// roundsTotal 开局按人数算死,不收缩的话 4 人局走 1 人后剩 3 人仍要打满 8 轮。
function eliminatePlayer(state, playerId) {
  if (!state || state.phase === 'ended') return [];
  const events = removePlayer(state, playerId) || [];
  delete state.absent[playerId];
  state.players = state.players.filter((p) => p.id !== playerId);

  // 按当前人数重算总轮数;已打过的轮数不退,故不低于 roundsDone
  const target = state.players.length * state.cfg.roundsPerPlayer;
  state.roundsTotal = Math.max(state.roundsDone, target);
  if (state.roundsDone >= state.roundsTotal && state.phase !== 'ended') {
    state.phase = 'ended';
    state.drawerId = null;
    state.deadline = null;
    return [...events, { type: 'game_over' }];
  }
  return events;
}

// ── 停表/恢复(由上层在"房间内一个连接都没有 / 有人重连"时调用) ──
// 理由同 werewolf:deadline 是绝对时间戳,停表期间会继续走。
function pauseClock(state) {
  if (!state || state.phase === 'ended' || state.deadline == null) return;
  state.pausedRemainMs = Math.max(0, state.deadline - now());
  state.deadline = null;
}

function resumeClock(state) {
  if (!state || state.phase === 'ended' || state.pausedRemainMs == null) return;
  state.deadline = now() + state.pausedRemainMs;
  state.pausedRemainMs = null;
}

// ── 序列化视图(信息隔离:画手可见词,猜者不可见) ──────────
function serializeStateFor(state, playerId) {
  const isDrawer = playerId === state.drawerId;
  const view = {
    phase: state.phase,
    players: state.players.map((p) => ({ ...p, absent: !!state.absent[p.id] })),
    scores: state.scores,
    drawerId: state.drawerId,
    roundsDone: state.roundsDone,
    roundsTotal: state.roundsTotal,
    deadline: state.deadline,
    hostId: state.hostId,
    strokes: state.strokes,                 // 中途加入者可据此补画
    guessed: Object.keys(state.guessedThisRound),
    isDrawer,
  };
  if (state.phase === 'pick' && isDrawer) view.wordChoices = state.wordChoices;
  if (state.phase === 'draw') {
    // 画手看到完整词;猜者看到词长(占位),已猜中者也看到词
    if (isDrawer || state.guessedThisRound[playerId]) view.word = state.word;
    else view.wordLength = state.word ? state.word.length : 0;
  }
  if (state.phase === 'reveal' || state.phase === 'ended') view.word = state.word;
  if (state.phase === 'ended') {
    view.ranking = [...state.players]
      .map((p) => ({ ...p, score: state.scores[p.id] || 0 }))
      .sort((a, b) => b.score - a.score);
  }
  return view;
}

function isGameOver(state) {
  if (state.phase !== 'ended') return false;
  const ranking = [...state.players]
    .map((p) => ({ ...p, score: state.scores[p.id] || 0 }))
    .sort((a, b) => b.score - a.score);
  return { over: true, ranking };
}

const { CATEGORIES } = require('./words');

module.exports = {
  id: 'drawguess',
  displayName: '你画我猜',
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
  // 房主配置元数据(供前端设置面板)
  configSchema: {
    drawSeconds: { options: DRAW_SECONDS_OPTIONS, default: DEFAULTS.drawSeconds },
    roundsPerPlayer: { options: ROUNDS_OPTIONS, default: DEFAULTS.roundsPerPlayer },
    categories: CATEGORIES,
  },
  REVEAL_SECONDS,
  PICK_SECONDS,
};
