// 你画我猜(Draw & Guess)—— 服务端权威游戏模块。
//
// 实现平台统一游戏接口:
//   createInitialState(players)
//   applyAction(state, action, playerId) -> { state, events, error }
//   serializeStateFor(state, playerId)   -> 该玩家可见的视图(画手可见词、猜者不可见)
//   isGameOver(state)                    -> { over, ranking } | false
//
// 状态全部放内存(由上层 rooms 管理器持有)。纯逻辑,不碰 socket/db,便于测试。

const { pickWords } = require('./words');

const DRAW_SECONDS = 80;        // 每轮作画时长
const REVEAL_SECONDS = 5;       // 揭晓/间隔时长
const PICK_SECONDS = 15;        // 画手选词时长
const ROUNDS_PER_PLAYER = 2;    // 每个玩家当几次画手

const now = () => Date.now();

// ── 创建初始状态 ──────────────────────────────────────────
// players: [{ id, name }]
function createInitialState(players) {
  return {
    phase: 'lobby',                 // lobby | pick | draw | reveal | ended
    players: players.map((p) => ({ id: p.id, name: p.name })),
    scores: Object.fromEntries(players.map((p) => [p.id, 0])),
    order: players.map((p) => p.id),// 画手轮转顺序
    turnIndex: -1,                  // 当前在 order 里的位置
    roundsTotal: players.length * ROUNDS_PER_PLAYER,
    roundsDone: 0,
    drawerId: null,
    wordChoices: [],                // 画手选词阶段的候选
    word: null,                     // 当前词(仅内部/画手可见)
    usedWords: [],
    guessedThisRound: {},           // { playerId: pointsAwarded }
    strokes: [],                    // 当前轮已画笔画(用于中途加入者补画)
    deadline: null,                 // 当前阶段截止时间戳(ms)
    hostId: players[0]?.id || null,
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

  state.turnIndex = (state.turnIndex + 1) % state.order.length;
  state.drawerId = state.order[state.turnIndex];
  state.phase = 'pick';
  state.word = null;
  state.strokes = [];
  state.guessedThisRound = {};
  state.wordChoices = pickWords(3, state.usedWords).map((w) => w.word);
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
      state.deadline = now() + DRAW_SECONDS * 1000;
      events.push({ type: 'draw_started', deadline: state.deadline });
      return { state, events };
    }

    case 'stroke': {
      if (state.phase !== 'draw') return { error: '当前不能作画' };
      if (playerId !== state.drawerId) return { error: '只有画手能画' };
      state.strokes.push(action.stroke);
      // 笔画广播由上层做(增量),这里只记录
      events.push({ type: 'stroke', stroke: action.stroke, forOthers: true });
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
        const pts = 100 + Math.round((remaining / DRAW_SECONDS) * 100);
        state.scores[playerId] = (state.scores[playerId] || 0) + pts;
        state.guessedThisRound[playerId] = pts;
        state.scores[state.drawerId] = (state.scores[state.drawerId] || 0) + 25;
        events.push({ type: 'guessed', playerId, points: pts });

        // 所有非画手都猜中 → 提前结束本轮
        const guessers = state.players.filter((p) => p.id !== state.drawerId);
        const allGuessed = guessers.every((p) => state.guessedThisRound[p.id]);
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

// ── 序列化视图(信息隔离:画手可见词,猜者不可见) ──────────
function serializeStateFor(state, playerId) {
  const isDrawer = playerId === state.drawerId;
  const view = {
    phase: state.phase,
    players: state.players,
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

module.exports = {
  id: 'drawguess',
  displayName: '你画我猜',
  minPlayers: 2,
  maxPlayers: 8,
  createInitialState,
  applyAction,
  serializeStateFor,
  isGameOver,
  // 供上层计时器使用
  DRAW_SECONDS,
  REVEAL_SECONDS,
  PICK_SECONDS,
};
