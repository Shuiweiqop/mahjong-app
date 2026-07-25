// 狼人杀(Werewolf)—— 服务端权威游戏模块(核心版:狼人/预言家/平民)。
//
// 实现平台统一游戏接口:
//   createInitialState(players, config)
//   applyAction(state, action, playerId) -> { state, events, error }
//   serializeStateFor(state, playerId)   -> 分角色视图(狼人见同伴、预言家见查验、平民见公开)
//   isGameOver(state)                    -> { over, winner } | false
//
// 阶段状态机: lobby → reveal(身份揭晓) → night → day(讨论+投票同阶段) → (循环) → ended
// reveal 阶段不计时(等所有人点"进入游戏"),带宽限超时兜底;其余阶段到点由 tick 推进,避免死锁。
// 纯逻辑,不碰 socket/db,便于测试。

const ROLE = { WOLF: 'wolf', SEER: 'seer', VILLAGER: 'villager' };

// 角色 → 阵营。屠边胜利按阵营判定(狼屠光"平民边"或"神职边"即胜)。
// 新增角色只需在此登记阵营,checkWin 无需改动(避免在多处枚举具体角色)。
const FACTION = { wolf: 'wolf', god: 'god', villager: 'villager' };
const ROLE_FACTION = {
  [ROLE.WOLF]: FACTION.wolf,
  [ROLE.SEER]: FACTION.god,       // 预言家属神职;女巫/猎人等未来神职同样填 god
  [ROLE.VILLAGER]: FACTION.villager,
};
const factionOf = (role) => ROLE_FACTION[role];

// 各阶段超时(秒)。到点由服务端计时器(tick)兜底推进,避免有人掉线/发呆时死锁。
const REVEAL_SECONDS = 30;  // 身份揭晓:等所有人点"进入游戏";此宽限超时只为防有人不点而卡住
const NIGHT_SECONDS = 40;   // 夜晚:狼人选刀 + 预言家查验
const DAY_SECONDS = 60;     // 白天:讨论 + 投票放逐(时间内可随时改票,到点结算)
const DAY_HURRY_SECONDS = 5; // 白天全员投完后,把倒计时压到这么短 —— 留个改票窗口,不立即结算

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
    absent: {},                           // 掉线/离开的玩家 { playerId: true };仍算存活但不参与推进判定
    round: 0,
    nightActions: {},                     // 本夜:{ wolfTargetVotes:{voterId:targetId}, seerCheck:{seerId,targetId} }
    seerResults: {},                      // { seerId: { [targetId]: 'wolf'|'good' } } 累积查验结果
    votes: {},                            // 白天投票:{ voterId: targetId|null }(可改票)
    ready: {},                            // 身份揭晓:已点"进入游戏"的玩家 { playerId: true }
    deadline: null,                       // 当前阶段截止时间戳(ms);到点由 tick 兜底推进
    pausedRemainMs: null,                 // 全员掉线时挂起的剩余时长;重连后据此重设 deadline
    log: [],                              // 公开事件日志
    lastNightVictim: null,
    lastVotedOut: null,
    winner: null,                         // 'wolf' | 'good'
    hostId: players[0]?.id || null,
  };
}

const aliveIds = (s) => s.players.map((p) => p.id).filter((id) => s.alive[id]);
const aliveWolves = (s) => aliveIds(s).filter((id) => s.roles[id] === ROLE.WOLF);
// 在场 = 存活且未掉线。只用于"还要等谁行动"的推进判定;
// 胜负判定一律用 aliveIds —— 掉线不等于出局,否则退game即可送对面赢。
const presentIds = (s) => aliveIds(s).filter((id) => !s.absent[id]);
// 某阵营开局是否存在,以及是否已被全屠(存活为 0)。屠边只对开局存在的阵营成立,
// 避免小局某边人数为 0 时开局即判狼胜。
const factionExists = (s, f) => Object.values(s.roles).some((r) => factionOf(r) === f);
const factionWiped = (s, f) =>
  factionExists(s, f) && !aliveIds(s).some((id) => factionOf(s.roles[id]) === f);

// 检查胜负;有结果则置 ended。屠边规则:
//   好人胜 —— 狼人全部出局。
//   狼人胜 —— 屠平民边(平民全灭)或屠神边(神职全灭)。
// 阵营由 ROLE_FACTION 推导,加新角色无需改这里。
function checkWin(s) {
  if (aliveWolves(s).length === 0) { s.winner = 'good'; s.phase = 'ended'; return true; }
  if (factionWiped(s, FACTION.villager) || factionWiped(s, FACTION.god)) {
    s.winner = 'wolf'; s.phase = 'ended'; return true;
  }
  return false;
}

// 进入身份揭晓(不计时,等所有存活玩家点"进入游戏";带宽限超时防有人不点卡住)
// 设置当前阶段截止时间。进入新阶段一律走这里,顺手清掉挂起的剩余时长 ——
// 否则"挂起期间发生阶段切换"会留下过期的 pausedRemainMs,重连时把新阶段的表改错。
function setDeadline(s, seconds) {
  s.deadline = now() + seconds * 1000;
  s.pausedRemainMs = null;
}

function enterReveal(s) {
  s.phase = 'reveal';
  s.ready = {};
  setDeadline(s, REVEAL_SECONDS);
}

// 进入夜晚
function enterNight(s) {
  s.round += 1;
  s.phase = 'night';
  s.nightActions = { wolfTargetVotes: {}, seerCheck: null };
  setDeadline(s, NIGHT_SECONDS);
  s.log.push({ type: 'phase', phase: 'night', round: s.round });
}

// 进入白天(讨论 + 投票同阶段):一进来即开放投票并倒计时。
// 玩家可在时间内随时改票;到点(tick)或全员投完即结算。
function enterDay(s) {
  s.phase = 'day';
  s.votes = {};
  setDeadline(s, DAY_SECONDS);
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
      enterReveal(s);   // 先进身份揭晓,等所有人点"进入游戏"再进夜晚(夜晚才起计时)
      return { state: s, events };
    }

    // 身份揭晓:玩家点"进入游戏"表示已看完身份。所有存活玩家就绪(或宽限超时)→ 进夜晚。
    case 'ready': {
      if (s.phase !== 'reveal') return { state: s, events }; // 幂等:非揭晓阶段忽略
      s.ready[playerId] = true;
      if (presentIds(s).every((id) => s.ready[id])) enterNight(s);
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
    // 到倒计时结束才结算(见 tick),不提前结算 —— 保证承诺的"时间内可改票"始终成立。
    case 'vote': {
      if (s.phase !== 'day') return { error: '非白天投票阶段' };
      if (!isAlive) return { error: '死亡玩家不能投票' };
      if (action.target && !s.alive[action.target]) return { error: '目标无效' };
      s.votes[playerId] = action.target || null;
      hurryDayIfAllVoted(s);   // 全员投完 → 把倒计时压到 DAY_HURRY_SECONDS(仍可改票)
      return { state: s, events };
    }

    // 服务端计时器驱动:当前阶段到点则兜底推进(避免掉线/发呆导致死锁)
    case 'tick': {
      if (s.phase === 'ended' || !s.deadline || now() < s.deadline) return { state: s, events };
      if (s.phase === 'reveal') {
        // 宽限超时:仍有人没点"进入游戏",也强制进夜晚,防止卡在揭晓
        enterNight(s);
      } else if (s.phase === 'night') {
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

// 白天全员投完 → 把 deadline 压到 DAY_HURRY_SECONDS 后(只缩短,不延长)。
// "全员"= 所有在场存活玩家都有票记录(弃票 null 也算已投);掉线者不阻塞,
// 与 maybeResolveNight 用 presentIds 保持一致。压缩后仍可改票,到点由 tick 结算。
function hurryDayIfAllVoted(s) {
  if (s.phase !== 'day' || s.deadline == null) return;
  const voters = presentIds(s);
  if (voters.length === 0) return;                        // 没人能投票,不处理
  if (!voters.every((id) => id in s.votes)) return;       // 还有人没投
  const hurryUntil = now() + DAY_HURRY_SECONDS * 1000;
  if (hurryUntil < s.deadline) s.deadline = hurryUntil;   // 只往前提,不回退
}

// 夜晚是否可结算:所有存活狼人已投 + (无存活预言家 或 预言家已查验)
// 只等"在场"的狼/预言家;掉线者不阻塞提前结算(到点仍有 tick 兜底)。
function maybeResolveNight(s) {
  const wolves = presentIds(s).filter((id) => s.roles[id] === ROLE.WOLF);
  const wolvesDone = wolves.every((id) => id in s.nightActions.wolfTargetVotes);
  const seers = presentIds(s).filter((id) => s.roles[id] === ROLE.SEER);
  const seerDone = seers.length === 0 || s.nightActions.seerCheck != null;
  // 狼全掉线时 wolves 为空,every 恒真 —— 不能就地空刀结算,交给 tick 到点处理,
  // 否则夜晚会在掉线瞬间被秒结算。
  if (wolves.length === 0) return;
  if (wolvesDone && seerDone) resolveNight(s);
}

// ── 掉线/重连 ──
// 掉线只标记"不在场",不判出局:退game不应把胜利送给对面。
// 影响的只是"还要等谁行动",胜负仍按 alive 计算。
function removePlayer(s, playerId) {
  if (!s || !(playerId in s.alive)) return;
  s.absent[playerId] = true;
  if (s.phase === 'ended') return;

  // 注意:这里不碰 deadline。"该不该停表"取决于还有没有人在看(传输层才知道:
  // 出局玩家、观战者都还连着),而本模块只看得到"还有没有人能行动"——两者不等价。
  // 停表由上层显式调 pauseClock/resumeClock,见 server.js。

  // 没有可行动的人了,不必再判断推进(空数组 every 恒真,会误推进阶段)
  if (presentIds(s).length === 0) return;

  // 掉线的人可能正是大家在等的最后一个 —— 重新检查当前阶段能否推进
  if (s.phase === 'reveal' && presentIds(s).every((id) => s.ready[id])) {
    enterNight(s);
  } else if (s.phase === 'night') {
    maybeResolveNight(s);
  } else if (s.phase === 'day') {
    hurryDayIfAllVoted(s);   // 走的人若正好是剩下唯一没投的,压缩倒计时
  }
}

// 宽限期超时仍未回来 → 真正判出局,并重跑胜负。
// 只标 absent 不够:checkWin 用 aliveIds,唯一的狼永久退出后好人永远赢不了,
// 只能白天把这个幽灵投出去。
function eliminatePlayer(s, playerId) {
  if (!s || s.phase === 'ended' || !s.alive[playerId]) return [];
  s.alive[playerId] = false;
  delete s.absent[playerId];
  s.log.push({ type: 'left', playerId });
  if (checkWin(s)) return [{ type: 'game_over' }];
  // 走的人可能正是大家在等的最后一个 —— 重新检查当前阶段能否推进
  if (s.phase === 'reveal' && presentIds(s).length && presentIds(s).every((id) => s.ready[id])) {
    enterNight(s);
  } else if (s.phase === 'night') {
    maybeResolveNight(s);
  } else if (s.phase === 'day') {
    hurryDayIfAllVoted(s);
  }
  return [];
}

// ── 停表/恢复(由上层在"房间内一个连接都没有 / 有人重连"时调用) ──
// deadline 是绝对时间戳,停表期间会继续"走";不挂起的话重连后首次 tick
// 就判定过期,当前阶段被瞬间跳过。
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

// 重连:恢复在场状态(座位、角色、存活都还在)
function restorePlayer(s, playerId) {
  if (!s || !(playerId in s.alive)) return;
  delete s.absent[playerId];
  // 不在这里恢复倒计时:停表与否由上层按"房间还有没有连接"决定(见 resumeClock)
}

// ── 分角色序列化视图(信息隔离) ──
function serializeStateFor(s, playerId) {
  const myRole = s.roles[playerId];
  const view = {
    phase: s.phase,
    round: s.round,
    players: s.players.map((p) => ({
      id: p.id, name: p.name, alive: s.alive[p.id], absent: !!s.absent[p.id],
    })),
    myRole,
    myId: playerId,
    alive: s.alive[playerId],
    log: s.log,
    lastNightVictim: s.lastNightVictim,
    lastVotedOut: s.lastVotedOut,
    hostId: s.hostId,
    deadline: s.deadline,               // 当前阶段截止时间戳,前端据此显示倒计时
  };
  // 狼人:能看到同伴狼人(不含自己;单狼局则为空数组)
  if (myRole === ROLE.WOLF) {
    view.wolfTeammates = s.players
      .filter((p) => s.roles[p.id] === ROLE.WOLF && p.id !== playerId)
      .map((p) => p.id);
  }
  // 预言家:能看到自己的查验结果
  if (myRole === ROLE.SEER) {
    view.seerResults = s.seerResults[playerId] || {};
  }
  // 身份揭晓:本人是否已就绪 + 就绪进度(等其他人点"进入游戏")
  if (s.phase === 'reveal') {
    view.iReady = !!s.ready[playerId];
    view.readyCount = aliveIds(s).filter((id) => s.ready[id]).length;
    view.readyTotal = aliveIds(s).length;
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
    // 全员(在场存活)已投 → 前端提示"即将结算",解释倒计时为何突然缩短
    const voters = presentIds(s);
    view.dayAllVoted = voters.length > 0 && voters.every((id) => id in s.votes);
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
  removePlayer,
  restorePlayer,
  eliminatePlayer,
  pauseClock,
  resumeClock,
  ROLE,
};
