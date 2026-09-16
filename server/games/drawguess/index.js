// Draw & Guess -- server-authoritative game module.
//
// Implements the platform's shared game interface:
//   createInitialState(players)
//   applyAction(state, action, playerId) -> { state, events, error }
//   serializeStateFor(state, playerId)   -> the view visible to that player (the drawer sees the word, guessers do not)
//   isGameOver(state)                    -> { over, ranking } | false
//
// All state lives in memory (held by the rooms manager one layer up). Pure
// logic, no socket/db access, which keeps it easy to test.

const { pickWords, buildWordPool } = require('./words');

const REVEAL_SECONDS = 5;       // Duration of the reveal / intermission
const PICK_SECONDS = 15;        // How long the drawer has to pick a word

// Defaults and permitted values for the host-configurable settings
const DEFAULTS = { drawSeconds: 80, roundsPerPlayer: 2, categories: [], customWords: [] };
const DRAW_SECONDS_OPTIONS = [45, 60, 80, 120];
const ROUNDS_OPTIONS = [1, 2, 3];

// Per-round stroke cap. strokes is only cleared when the round changes, so
// within a round it only ever grows; the canvas uses normalized coordinates and
// 20,000 segments is enough to fill a whole round (measured: about 10,000
// segments for 60 seconds of normal drawing). Once the cap is hit, new strokes
// are dropped rather than rejected with an error -- the drawer should not be
// interrupted for drawing a lot; "the canvas is full" is a degradation they can
// understand.
const MAX_STROKES = 20000;
// Cap on the number of segments in a single stroke message, which blocks a malicious message from blowing up memory in one go (measured: 200,000 segments = a 22MB view).
const MAX_STROKES_PER_MSG = 500;
const GUESS_MAX = 100;          // Maximum length of a single guess/message (the werewolf module uses CHAT_MAX=300)

const now = () => Date.now();

// Keep only the fields the canvas actually needs and clamp the coordinates back
// into 0..1 -- a client can forge an arbitrary object, and storing it verbatim
// in the state would broadcast the junk to everyone and have it redrawn
// persistently.
function sanitizeStroke(s) {
  if (!s || typeof s !== 'object') return null;
  const pt = (p) => Array.isArray(p) && p.length >= 2
    && Number.isFinite(+p[0]) && Number.isFinite(+p[1])
    ? [Math.min(1, Math.max(0, +p[0])), Math.min(1, Math.max(0, +p[1]))]
    : null;
  const from = pt(s.from), to = pt(s.to);
  if (!from || !to) return null;
  const size = Number.isFinite(+s.size) ? Math.min(64, Math.max(1, +s.size)) : 4;
  const color = typeof s.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(s.color) ? s.color : '#000000';
  return { from, to, color, size };
}

// Normalize the configuration passed in by the host, guarding against invalid values
function normalizeConfig(cfg = {}) {
  const drawSeconds = DRAW_SECONDS_OPTIONS.includes(cfg.drawSeconds) ? cfg.drawSeconds : DEFAULTS.drawSeconds;
  const roundsPerPlayer = ROUNDS_OPTIONS.includes(cfg.roundsPerPlayer) ? cfg.roundsPerPlayer : DEFAULTS.roundsPerPlayer;
  const categories = Array.isArray(cfg.categories) ? cfg.categories : [];
  const customWords = Array.isArray(cfg.customWords)
    ? cfg.customWords.map((w) => String(w).trim()).filter(Boolean).slice(0, 100)
    : [];
  return { drawSeconds, roundsPerPlayer, categories, customWords };
}

// -- Create the initial state ------------------------------------------------
// players: [{ id, name }];  config: the host's settings (optional)
function createInitialState(players, config) {
  const cfg = normalizeConfig(config);
  const pool = buildWordPool({ categories: cfg.categories, customWords: cfg.customWords });
  return {
    phase: 'lobby',                 // lobby | pick | draw | reveal | ended
    players: players.map((p) => ({ id: p.id, name: p.name })),
    scores: Object.fromEntries(players.map((p) => [p.id, 0])),
    order: players.map((p) => p.id),// Rotation order of the drawer
    turnIndex: -1,                  // Current position within order
    roundsTotal: players.length * cfg.roundsPerPlayer,
    roundsDone: 0,
    drawerId: null,
    wordChoices: [],                // Candidates offered during the drawer's word-picking phase
    word: null,                     // The current word (internal / drawer-visible only)
    usedWords: [],
    guessedThisRound: {},           // { playerId: pointsAwarded }
    absent: {},                     // Disconnected players { playerId: true }; skipped in the rotation and not counted towards "everyone guessed"
    pausedRemainMs: null,           // Remaining time parked while the room has no connections (see pauseClock)
    strokes: [],                    // Strokes drawn so far this round (used to catch up players who join mid-round)
    strokeRev: 0,                   // Canvas revision: +1 on every clear / round change, which is how the frontend knows whether a full redraw is needed
    deadline: null,                 // Deadline timestamp of the current phase (ms)
    hostId: players[0]?.id || null,
    cfg,                            // Keep the configuration around for later use
    wordPool: pool,                 // The word pool for this game
  };
}

// -- Internal: move on to the next round (word-picking phase) -----------------
function startNextTurn(state) {
  const events = [];
  if (state.roundsDone >= state.roundsTotal) {
    state.phase = 'ended';
    state.drawerId = null;
    state.deadline = null;
    events.push({ type: 'game_over' });
    return events;
  }

  if (state.order.length === 0) {           // Fallback for everyone having disconnected
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
  state.strokeRev = (state.strokeRev || 0) + 1;   // Round change: the canvas is void, the frontend needs to clear the screen
  state.guessedThisRound = {};
  state.wordChoices = pickWords(3, state.usedWords, state.wordPool).map((w) => w.word);
  state.deadline = now() + PICK_SECONDS * 1000;
  events.push({ type: 'round_changed', drawerId: state.drawerId });
  return events;
}

// -- Internal: end this round (the reveal) ------------------------------------
function endRound(state, reason) {
  state.roundsDone += 1;
  state.phase = 'reveal';
  state.deadline = now() + REVEAL_SECONDS * 1000;
  return [{ type: 'reveal', word: state.word, reason, scores: { ...state.scores } }];
}

// -- Apply one action (validated server-authoritatively) ----------------------
// action: { type, ... }
//   { type:'start' }                        the host starts the game
//   { type:'pick', word }                   the drawer settles on a word
//   { type:'stroke', stroke }               the drawer draws a stroke
//   { type:'clear' }                        the drawer clears the canvas
//   { type:'guess', text }                  a guesser submits a guess
//   { type:'tick' }                         driven by the server-side timer (checks whether the deadline has passed)
function applyAction(state, action, playerId) {
  const events = [];

  // Spectators (and any id not in this game) cannot act. tick is server-driven,
  // with playerId null.
  // Without this guard a spectator could "guess": a correct guess would land in
  // scores and guessedThisRound, and guessedThisRound is exactly what
  // serializeStateFor uses to decide whether to send the word -- so one guess
  // would hand the spectator the answer, and they could also end the round early
  // by making up the "everyone guessed" quota.
  if (action.type !== 'tick' && !state.players.some((p) => p.id === playerId)) {
    return { error: 'game.notAPlayer' };
  }

  switch (action.type) {
    case 'start': {
      if (playerId !== state.hostId) return { error: 'room.hostOnlyStart' };
      if (state.phase !== 'lobby') return { error: 'room.alreadyStarted' };
      if (state.players.length < 2) return { error: 'room.needTwoPlayers' };
      events.push(...startNextTurn(state));
      return { state, events };
    }

    case 'pick': {
      if (state.phase !== 'pick') return { error: 'draw.notPickPhase' };
      if (playerId !== state.drawerId) return { error: 'draw.onlyDrawerPicks' };
      if (!state.wordChoices.includes(action.word)) return { error: 'draw.invalidWord' };
      state.word = action.word;
      state.usedWords.push(action.word);
      state.wordChoices = [];
      state.phase = 'draw';
      state.deadline = now() + state.cfg.drawSeconds * 1000;
      events.push({ type: 'draw_started', deadline: state.deadline });
      return { state, events };
    }

    case 'stroke': {
      if (state.phase !== 'draw') return { error: 'draw.cannotDraw' };
      if (playerId !== state.drawerId) return { error: 'draw.onlyDrawerDraws' };
      // Accepts a batch of strokes (lower latency) or a single one (for compatibility)
      const raw = action.strokes || (action.stroke ? [action.stroke] : []);
      if (!Array.isArray(raw)) return { error: 'draw.badStroke' };
      // Validate + cap: anything past the per-round limit is simply dropped (no error, see the MAX_STROKES comment)
      const room = Math.max(0, MAX_STROKES - state.strokes.length);
      const strokes = raw
        .slice(0, MAX_STROKES_PER_MSG)
        .map(sanitizeStroke)
        .filter(Boolean)
        .slice(0, room);
      if (!strokes.length) return { state, events };   // All dropped: stay silent, do not interrupt the drawer
      for (const s of strokes) state.strokes.push(s);
      // Broadcast only this batch (the delta), not everything -- the full set is only re-sent through serializeStateFor for players joining mid-round
      events.push({ type: 'stroke', strokes, forOthers: true });
      return { state, events };
    }

    case 'clear': {
      if (state.phase !== 'draw') return { error: 'draw.cannotClear' };
      if (playerId !== state.drawerId) return { error: 'draw.onlyDrawerClears' };
      state.strokes = [];
      state.strokeRev = (state.strokeRev || 0) + 1;
      events.push({ type: 'clear' });
      return { state, events };
    }

    case 'guess': {
      if (state.phase !== 'draw') return { error: 'draw.cannotGuess' };
      if (playerId === state.drawerId) return { error: 'draw.drawerCannotGuess' };
      if (state.guessedThisRound[playerId]) return { error: 'draw.alreadyGuessed' };

      // Truncate rather than reject: an incorrect guess is broadcast as chat, and
      // without a cap that would hand everyone a broadcast channel of arbitrary
      // length (measured: 100,000 characters forwarded verbatim). The same
      // applies in the werewolf module, see CHAT_MAX.
      const guess = String(action.text || '').trim().slice(0, GUESS_MAX);
      const correct = guess === state.word;

      if (correct) {
        // Scoring: the more time is left the more points; the drawer also scores per player who guessed correctly
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
      return { error: 'game.unknownAction' };
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

// 谁需要整块画布?只有"收不到增量"的人:
//   - 掉线/中途加入者(absent,或根本不在本局 order 里 —— 观战者走的就是这条)
//   - 画布刚被清空/换轮(strokes 为空,发个空数组让前端清屏,代价为零)
// 在场玩家靠 'stroke' 事件持续收增量,不需要每次广播都收全量。
// 注意别在这里改 state:serializeStateFor 每次广播对每个玩家都会调用,
// 在里面记"已同步"会让同一次广播的结果取决于成员遍历顺序。
function strokesFor(state, playerId) {
  if (!state.strokes.length) return [];
  const inGame = state.order.includes(playerId) && !state.absent[playerId];
  return inGame ? undefined : state.strokes;
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
    // 笔画不进常规视图:增量已经由 'stroke' 事件单独广播,这里再带一份全量,
    // 等于每次有人猜词(chat 也走 broadcastState)就给每个人重发整块画布 ——
    // 实测正常画满一轮后单人视图 1.2MB,8 人房一次广播近 10MB。
    // 全量只在真正需要补画时下发(见下方 strokesFor)。
    strokes: strokesFor(state, playerId),
    strokeRev: state.strokeRev,             // 画布版本号,前端据此判断是否需要重绘
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
