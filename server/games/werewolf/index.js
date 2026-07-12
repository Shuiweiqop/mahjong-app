// 狼人杀(Werewolf)—— 服务端权威游戏模块(核心版:狼人/预言家/平民)。
//
// 实现平台统一游戏接口:
//   createInitialState(players, config)
//   applyAction(state, action, playerId) -> { state, events, error }
//   serializeStateFor(state, playerId)   -> 分角色视图(狼人见同伴、预言家见查验、平民见公开)
//   isGameOver(state)                    -> { over, winner } | false
//
// 阶段状态机: lobby → night → day(讨论+投票同阶段) → (循环) → ended
// 每阶段有 deadline,服务端计时器(tick)到点兜底推进,避免掉线/发呆死锁。
// 纯逻辑,不碰 socket/db,便于测试。

const ROLE = { WOLF: 'wolf', SEER: 'seer', VILLAGER: 'villager' };

// 各阶段超时(秒)。到点由服务端计时器(tick)兜底推进,避免有人掉线/发呆时死锁。
const NIGHT_SECONDS = 40;   // 夜晚:狼人选刀 + 预言家查验
const DAY_SECONDS = 60;     // 白天:讨论 + 投票放逐(时间内可随时改票,到点结算)

const now = () => Date.now();

// 按人数决定狼人数量
function wolfCount(n) {
  if (n >= 10) return 3;
  if (n >= 7) return 2;
  return 1;
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
function createInitialState(players) {
  const ids = players.map((p) => p.id);
  const nWolf = wolfCount(ids.length);
  const shuffled = shuffle(ids);
  const roles = {};
  shuffled.forEach((id, i) => {
    if (i < nWolf) roles[id] = ROLE.WOLF;
    else if (i === nWolf) roles[id] = ROLE.SEER;   // 1 个预言家
    else roles[id] = ROLE.VILLAGER;
  });
  return {
    phase: 'lobby',                       // lobby | night | day | vote | ended
    players: players.map((p) => ({ id: p.id, name: p.name })),
    roles,                                // { playerId: role }(内部,不整体下发)
    alive: Object.fromEntries(ids.map((id) => [id, true])),
    round: 0,
    nightActions: {},                     // 本夜:{ wolfTargetVotes:{voterId:targetId}, seerCheck:{seerId,targetId} }
    seerResults: {},                      // { seerId: { [targetId]: 'wolf'|'good' } } 累积查验结果
    votes: {},                            // 白天投票:{ voterId: targetId|null }(可改票)
    deadline: null,                       // 当前阶段截止时间戳(ms);到点由 tick 兜底推进
    log: [],                              // 公开事件日志
    lastNightVictim: null,
    lastVotedOut: null,
    winner: null,                         // 'wolf' | 'good'
    hostId: players[0]?.id || null,
  };
}

const aliveIds = (s) => s.players.map((p) => p.id).filter((id) => s.alive[id]);
const aliveWolves = (s) => aliveIds(s).filter((id) => s.roles[id] === ROLE.WOLF);
const aliveVillagers = (s) => aliveIds(s).filter((id) => s.roles[id] === ROLE.VILLAGER);
const aliveGods = (s) => aliveIds(s).filter((id) => s.roles[id] === ROLE.SEER); // 神职:目前只有预言家

// 检查胜负;有结果则置 ended。屠边规则:
//   好人胜 —— 狼人全部出局。
//   狼人胜 —— 屠平民边(所有平民出局)或屠神边(所有神职出局)。
// 注:若开局某一边人数为 0(如小局无平民),该边不作为屠边条件,避免开局即判狼胜。
function checkWin(s) {
  if (aliveWolves(s).length === 0) { s.winner = 'good'; s.phase = 'ended'; return true; }
  const hadVillagers = Object.values(s.roles).some((r) => r === ROLE.VILLAGER);
  const hadGods = Object.values(s.roles).some((r) => r === ROLE.SEER);
  const villagersWiped = hadVillagers && aliveVillagers(s).length === 0;
  const godsWiped = hadGods && aliveGods(s).length === 0;
  if (villagersWiped || godsWiped) { s.winner = 'wolf'; s.phase = 'ended'; return true; }
  return false;
}

// 进入夜晚
function enterNight(s) {
  s.round += 1;
  s.phase = 'night';
  s.nightActions = { wolfTargetVotes: {}, seerCheck: null };
  s.deadline = now() + NIGHT_SECONDS * 1000;
  s.log.push({ type: 'phase', phase: 'night', round: s.round });
}

// 进入白天(讨论 + 投票同阶段):一进来即开放投票并倒计时。
// 玩家可在时间内随时改票;到点(tick)或全员投完即结算。
function enterDay(s) {
  s.phase = 'day';
  s.votes = {};
  s.deadline = now() + DAY_SECONDS * 1000;
  s.log.push({ type: 'phase', phase: 'day', round: s.round });
}

// 结算夜晚 → 进入白天
function resolveNight(s) {
  // 狼人票数最高者出局(平票取先到,简化:取得票最多的第一个)
  const votes = s.nightActions.wolfTargetVotes || {};
  const tally = {};
  Object.values(votes).forEach((t) => { tally[t] = (tally[t] || 0) + 1; });
  let victim = null, max = 0;
  for (const [t, c] of Object.entries(tally)) { if (c > max) { max = c; victim = t; } }

  if (victim && s.alive[victim]) { s.alive[victim] = false; s.lastNightVictim = victim; }
  else s.lastNightVictim = null;

  s.log.push({ type: 'night_result', victim: s.lastNightVictim });
  if (!checkWin(s)) enterDay(s);
}

// 结算白天投票 → 进入下一夜
function resolveVote(s) {
  const tally = {};
  Object.values(s.votes).forEach((t) => { if (t) tally[t] = (tally[t] || 0) + 1; });
  let out = null, max = 0, tie = false;
  for (const [t, c] of Object.entries(tally)) {
    if (c > max) { max = c; out = t; tie = false; }
    else if (c === max) tie = true;
  }
  if (out && !tie && s.alive[out]) { s.alive[out] = false; s.lastVotedOut = out; }
  else s.lastVotedOut = null; // 平票/无票 → 无人出局
  s.log.push({ type: 'vote_result', out: s.lastVotedOut });
  if (!checkWin(s)) enterNight(s);
}

// ── 应用动作 ──
// { type:'start' }                房主开始
// { type:'wolf_kill', target }    狼人投票杀人(夜晚)
// { type:'seer_check', target }   预言家查验(夜晚)
// { type:'vote', target }         白天投票(target 可为 null 弃票)
function applyAction(s, action, playerId) {
  const events = [];
  const isAlive = s.alive[playerId];

  switch (action.type) {
    case 'start': {
      if (playerId !== s.hostId) return { error: '只有房主能开始' };
      if (s.phase !== 'lobby') return { error: '游戏已开始' };
      if (s.players.length < 4) return { error: '狼人杀至少需要 4 人' };
      enterNight(s);
      return { state: s, events };
    }

    case 'wolf_kill': {
      if (s.phase !== 'night') return { error: '非夜晚阶段' };
      if (!isAlive || s.roles[playerId] !== ROLE.WOLF) return { error: '只有存活狼人能行动' };
      if (!s.alive[action.target]) return { error: '目标无效' };
      s.nightActions.wolfTargetVotes[playerId] = action.target;
      // 所有存活狼人都投了 + 预言家查验完(若有存活预言家)→ 结算夜晚
      maybeResolveNight(s);
      return { state: s, events };
    }

    case 'seer_check': {
      if (s.phase !== 'night') return { error: '非夜晚阶段' };
      if (!isAlive || s.roles[playerId] !== ROLE.SEER) return { error: '只有预言家能查验' };
      if (!s.alive[action.target]) return { error: '目标无效' };
      const result = s.roles[action.target] === ROLE.WOLF ? 'wolf' : 'good';
      s.seerResults[playerId] = s.seerResults[playerId] || {};
      s.seerResults[playerId][action.target] = result;
      s.nightActions.seerCheck = { seerId: playerId, targetId: action.target };
      maybeResolveNight(s);
      return { state: s, events };
    }

    // 白天投票(讨论与投票同阶段):时间内可随时改票,target 为 null 即弃票。
    case 'vote': {
      if (s.phase !== 'day') return { error: '非白天投票阶段' };
      if (!isAlive) return { error: '死亡玩家不能投票' };
      if (action.target && !s.alive[action.target]) return { error: '目标无效' };
      s.votes[playerId] = action.target || null;
      // 所有存活玩家都投了 → 提前结算(不必等倒计时)
      if (aliveIds(s).every((id) => id in s.votes)) resolveVote(s);
      return { state: s, events };
    }

    // 服务端计时器驱动:当前阶段到点则兜底推进(避免掉线/发呆导致死锁)
    case 'tick': {
      if (s.phase === 'ended' || !s.deadline || now() < s.deadline) return { state: s, events };
      if (s.phase === 'night') {
        // 未行动的狼人 → 空刀(不补随机目标,平安夜);预言家未查 → 跳过
        resolveNight(s);
      } else if (s.phase === 'day') {
        // 到点结算:未投的算弃票,平票无人出局
        resolveVote(s);
      }
      return { state: s, events };
    }

    default:
      return { error: '未知动作' };
  }
}

// 夜晚是否可结算:所有存活狼人已投 + (无存活预言家 或 预言家已查验)
function maybeResolveNight(s) {
  const wolvesDone = aliveWolves(s).every((id) => id in s.nightActions.wolfTargetVotes);
  const seers = aliveIds(s).filter((id) => s.roles[id] === ROLE.SEER);
  const seerDone = seers.length === 0 || s.nightActions.seerCheck != null;
  if (wolvesDone && seerDone) resolveNight(s);
}

// ── 分角色序列化视图(信息隔离) ──
function serializeStateFor(s, playerId) {
  const myRole = s.roles[playerId];
  const view = {
    phase: s.phase,
    round: s.round,
    players: s.players.map((p) => ({ id: p.id, name: p.name, alive: s.alive[p.id] })),
    myRole,
    myId: playerId,
    alive: s.alive[playerId],
    log: s.log,
    lastNightVictim: s.lastNightVictim,
    lastVotedOut: s.lastVotedOut,
    hostId: s.hostId,
    deadline: s.deadline,               // 当前阶段截止时间戳,前端据此显示倒计时
  };
  // 狼人:能看到同伴狼人
  if (myRole === ROLE.WOLF) {
    view.wolfTeammates = s.players
      .filter((p) => s.roles[p.id] === ROLE.WOLF)
      .map((p) => p.id);
  }
  // 预言家:能看到自己的查验结果
  if (myRole === ROLE.SEER) {
    view.seerResults = s.seerResults[playerId] || {};
  }
  // 夜晚:告诉本人是否已行动(狼人已投刀 / 预言家已查验),前端显示等待态
  if (s.phase === 'night') {
    if (myRole === ROLE.WOLF) view.iActed = playerId in (s.nightActions.wolfTargetVotes || {});
    else if (myRole === ROLE.SEER) view.iActed = s.nightActions.seerCheck != null;
  }
  // 白天(讨论+投票):公开当前票型(谁投了谁)供讨论;并标记本人当前票与是否已投
  if (s.phase === 'day') {
    view.votes = s.votes;
    view.iVoted = playerId in s.votes;
    view.myVote = playerId in s.votes ? s.votes[playerId] : undefined;
  }
  // 结束:公开所有身份
  if (s.phase === 'ended') {
    view.winner = s.winner;
    view.roles = s.roles;
  }
  return view;
}

function isGameOver(s) {
  if (s.phase !== 'ended') return false;
  return { over: true, winner: s.winner, roles: s.roles };
}

module.exports = {
  id: 'werewolf',
  displayName: '狼人杀',
  minPlayers: 4,
  maxPlayers: 12,
  createInitialState,
  applyAction,
  serializeStateFor,
  isGameOver,
  ROLE,
};
