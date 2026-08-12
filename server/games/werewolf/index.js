// 狼人杀(Werewolf)—— 服务端权威游戏模块。
// 角色:狼人 / 预言家 / 女巫 / 猎人 / 平民(神职按人数上场,见 godCountFor)。
//
// 实现平台统一游戏接口:
//   createInitialState(players, config)
//   applyAction(state, action, playerId) -> { state, events, error }
//   serializeStateFor(state, playerId)   -> 分角色视图(狼见同伴、预言家见查验、女巫见刀口)
//   isGameOver(state)                    -> { over, winner } | false
//
// 阶段状态机:
//   lobby → reveal → night → [witch] → [hunter] → speech → day → [pk] → [hunter] → night → …
//                                                                                    ↘ ended
//   witch  仅在有存活女巫时插入(她要先看到刀口才能决定用不用解药)
//   hunter 仅在猎人出局且可开枪时插入,结束后回 resumeTo 指定的阶段
//   speech 轮流发言,一次只有一个人能说;说完才进 day 投票
//   pk     白天平票且房主开了 tiePk 时插入
//
// 所有阶段时长由房主配置(见 DEFAULTS / TIME_OPTIONS),不写死。
// 到点一律由服务端 tick 兜底推进,避免有人掉线/发呆时死锁。
// 纯逻辑,不碰 socket/db,便于测试(见 rules.test.js)。

const ROLE = { WOLF: 'wolf', SEER: 'seer', WITCH: 'witch', HUNTER: 'hunter', VILLAGER: 'villager' };

// 角色 → 阵营。屠边胜利按阵营判定(狼屠光"平民边"或"神职边"即胜)。
// 新增角色只需在此登记阵营,checkWin 无需改动(避免在多处枚举具体角色)。
const FACTION = { wolf: 'wolf', god: 'god', villager: 'villager' };
const ROLE_FACTION = {
  [ROLE.WOLF]: FACTION.wolf,
  [ROLE.SEER]: FACTION.god,
  [ROLE.WITCH]: FACTION.god,
  [ROLE.HUNTER]: FACTION.god,
  [ROLE.VILLAGER]: FACTION.villager,
};
const factionOf = (role) => ROLE_FACTION[role];

// 神职上场顺序:人数越多神越多。小局保持轻快(只有预言家),
// 中局加女巫,大局再加猎人。神职 ≥ 2 时屠神边规则自动恢复(见 checkWin)。
const GOD_ORDER = [ROLE.SEER, ROLE.WITCH, ROLE.HUNTER];
function godCountFor(n) {
  if (n >= 10) return 3;
  if (n >= 7) return 2;
  return 1;
}

// 各阶段时长(秒)的默认值。到点由服务端计时器(tick)兜底推进,避免有人掉线/发呆时死锁。
// 全部可由房主在大厅调整 —— 不同人群的节奏差别很大(线下玩家习惯长发言,
// 线上玩家耐心短),写死一个值必然有一半人觉得难受。实际取值一律走 s.cfg,
// 这里只是默认值和"没配置时"的兜底。
const DEFAULTS = {
  tiePk: true,
  revealSeconds: 30,   // 身份揭晓:等所有人点"进入游戏";此宽限超时只为防有人不点而卡住
  nightSeconds: 40,    // 夜晚:狼人选刀 + 预言家查验
  speechSeconds: 45,   // 单人发言时限;说完点"过"或超时自动轮下一个
  daySeconds: 60,      // 投票阶段:可随时改票,到点结算
  pkSeconds: 30,       // 平票 PK:平票者进入 PK,非平票的存活玩家重投一轮
  witchSeconds: 25,    // 女巫用药:狼刀结算后单独一段(她要先看到刀口)
  hunterSeconds: 20,   // 猎人开枪:出局后的即时反应,时间短
};

// 每项的可选值(前端渲染成一排按钮,同时也是服务端的白名单)。
// 客户端可以伪造任意 config,所以取值必须在这里校验,不能只靠前端限制。
const TIME_OPTIONS = {
  revealSeconds: [15, 30, 45, 60],
  nightSeconds: [30, 40, 60, 90],
  speechSeconds: [20, 30, 45, 60, 90],
  daySeconds: [30, 45, 60, 90, 120],
  pkSeconds: [20, 30, 45, 60],
  witchSeconds: [15, 25, 40, 60],
  hunterSeconds: [15, 20, 30, 45],
};

const DAY_HURRY_SECONDS = 5; // 白天全员投完后,把倒计时压到这么短 —— 留个改票窗口,不立即结算
const CHAT_MAX = 300;        // 单条发言最大长度,防刷屏

// 规整房主传入的配置:不在白名单里的值一律退回默认,防伪造的 config 把
// 某个阶段设成 0 秒(瞬间跳过)或 99999 秒(卡死整局)。
function normalizeConfig(cfg = {}) {
  const out = { tiePk: cfg.tiePk !== false };
  for (const [key, options] of Object.entries(TIME_OPTIONS)) {
    out[key] = options.includes(cfg[key]) ? cfg[key] : DEFAULTS[key];
  }
  return out;
}

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
function createInitialState(players, config = {}) {
  const ids = players.map((p) => p.id);
  const nWolf = wolfCount(ids.length);
  const nGod = Math.min(godCountFor(ids.length), Math.max(0, ids.length - nWolf - 1));
  const shuffled = shuffle(ids);
  const roles = {};
  shuffled.forEach((id, i) => {
    if (i < nWolf) roles[id] = ROLE.WOLF;
    else if (i < nWolf + nGod) roles[id] = GOD_ORDER[i - nWolf];
    else roles[id] = ROLE.VILLAGER;
  });
  return {
    phase: 'lobby',                       // lobby | reveal | night | day | pk | ended
    cfg: normalizeConfig(config),   // 房主配置(阶段时长 + 平票 PK)
    players: players.map((p) => ({ id: p.id, name: p.name })),
    roles,                                // { playerId: role }(内部,不整体下发)
    alive: Object.fromEntries(ids.map((id) => [id, true])),
    absent: {},                           // 掉线/离开的玩家 { playerId: true };仍算存活但不参与推进判定
    round: 0,
    nightActions: {},                     // 本夜:{ wolfTargetVotes:{voterId:targetId}, seerCheck:{seerId,targetId} }
    seerResults: {},                      // { seerId: { [targetId]: 'wolf'|'good' } } 累积查验结果
    // 女巫:两瓶药全局各一次。潜规则"首夜可自救,之后不能",所以要记住用药的夜次。
    potions: { heal: true, poison: true },
    // 猎人:开枪机会。被毒死不能开枪(标准规则),所以要区分死因,见 killPlayer。
    hunterCanShoot: true,
    pendingHunter: null,                  // 待开枪的猎人 id;非 hunter 阶段为 null
    votes: {},                            // 白天投票:{ voterId: targetId|null }(可改票)
    speechOrder: null,                    // 发言队列 [playerId];非 speech 阶段为 null
    speechIndex: 0,                       // 当前轮到队列里的第几个
    pkCandidates: null,                   // PK 加赛的候选人 [id,id];非 PK 阶段为 null
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

// 每边至少要有几个神职,"屠神边"才算一个有意义的胜利条件。
// 只有 1 个神(当前板子只有预言家)时屠神边会退化成"第一晚刀中某个特定的人就赢":
// 实测狼盲刀的情况下,6 人局 20%、8 人局 17% 的对局在第一个白天开始前就结束,
// 其他人一句话没说、一票没投。等以后加了女巫/猎人(FACTION.god 有 2 个以上成员),
// 屠神边自动重新生效,不需要再改这里。
const MIN_GODS_FOR_WIPE_RULE = 2;

// 检查胜负;有结果则置 ended。
//   好人胜 —— 狼人全部出局。
//   狼人胜 —— 屠平民边;或屠神边(仅在神职足够多时);或狼人数 ≥ 好人数(狼可以强行
//             票死任何人,已成定局,继续玩下去只是走流程)。
// 阵营由 ROLE_FACTION 推导,加新角色无需改这里。
function checkWin(s) {
  if (aliveWolves(s).length === 0) { s.winner = 'good'; s.phase = 'ended'; return true; }

  const wolves = aliveWolves(s).length;
  const good = aliveIds(s).length - wolves;
  const godCount = Object.values(s.roles).filter((r) => factionOf(r) === FACTION.god).length;

  if (
    wolves >= good ||
    factionWiped(s, FACTION.villager) ||
    (godCount >= MIN_GODS_FOR_WIPE_RULE && factionWiped(s, FACTION.god))
  ) {
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
  setDeadline(s, s.cfg.revealSeconds);
}

// 进入夜晚
function enterNight(s) {
  s.round += 1;
  s.phase = 'night';
  s.nightActions = { wolfTargetVotes: {}, seerCheck: null, witch: null, victim: null };
  setDeadline(s, s.cfg.nightSeconds);
  s.log.push({ type: 'phase', phase: 'night', round: s.round });
}

// 女巫要"看到刀口"才能决定救不救,所以夜晚必须分两段:
// 先结算狼刀定下 victim,再单独给女巫一段时间用药。没有女巫时这一段直接跳过。
function enterWitchTurn(s) {
  s.phase = 'witch';
  setDeadline(s, s.cfg.witchSeconds);
}

// 统一的死亡入口。所有让人出局的路径都走这里,好处是猎人的触发只写一次 ——
// 漏掉任何一条路径,就会出现"某种死法猎人不开枪"的诡异 bug。
// cause: 'wolf' | 'vote' | 'poison' | 'shot' | 'leave'
// 返回是否触发了猎人开枪(调用方据此决定要不要停下来等他)。
function killPlayer(s, id, cause) {
  if (!id || !s.alive[id]) return false;
  s.alive[id] = false;
  // 猎人被毒死不能开枪(标准规则:毒药让他来不及反应)。其余死法都能。
  if (s.roles[id] === ROLE.HUNTER && s.hunterCanShoot && cause !== 'poison') {
    s.pendingHunter = id;
    return true;
  }
  return false;
}

// 进入猎人开枪阶段。这是唯一会打断正常昼夜流转的阶段,结束后由 resumeAfterHunter
// 回到本来该去的地方。
function enterHunterTurn(s) {
  s.phase = 'hunter';
  setDeadline(s, s.cfg.hunterSeconds);
  s.log.push({ type: 'hunter_turn', playerId: s.pendingHunter });
}

// 进入白天发言:按座位轮流,一次只有一个人能说,其余人只能看。
//
// 这是狼人杀的核心机制,不是锦上添花 —— 悍跳、对跳、聊爆狼全建立在"轮流发言"上。
// 允许同时刷屏的话,狼只要疯狂刷屏就能把预言家的报点冲走,变成谁打字快谁赢。
//
// 顺序从"上一个死者的下一位"开始(线下惯例:死者下家先发言),死者不在队列里。
// 全部说完 → 进投票。
function enterSpeech(s) {
  const order = aliveIds(s);
  if (!order.length) { enterDay(s); return; }

  // 起点:上一个出局者在原始座位里的下一位;没有死者(首日)就从 0 开始
  const seats = s.players.map((p) => p.id);
  const lastDead = Array.isArray(s.lastNightVictim) ? s.lastNightVictim[0] : s.lastNightVictim;
  let start = 0;
  if (lastDead) {
    const seat = seats.indexOf(lastDead);
    if (seat >= 0) {
      for (let i = 1; i <= seats.length; i++) {
        const idx = order.indexOf(seats[(seat + i) % seats.length]);
        if (idx >= 0) { start = idx; break; }
      }
    }
  }

  s.phase = 'speech';
  s.speechOrder = [...order.slice(start), ...order.slice(0, start)];
  s.speechIndex = 0;
  setDeadline(s, s.cfg.speechSeconds);
  s.log.push({ type: 'phase', phase: 'speech', round: s.round, order: s.speechOrder });
}

// 轮到下一位发言;都说完了就进投票。
// 掉线/已出局的人自动跳过 —— 否则全场要为一个不会说话的人干等满 45 秒。
function nextSpeaker(s) {
  for (let i = s.speechIndex + 1; i < s.speechOrder.length; i++) {
    const id = s.speechOrder[i];
    if (s.alive[id] && !s.absent[id]) {
      s.speechIndex = i;
      setDeadline(s, s.cfg.speechSeconds);
      return;
    }
  }
  enterDay(s);
}

const currentSpeaker = (s) =>
  s.phase === 'speech' ? ((s.speechOrder || [])[s.speechIndex] ?? null) : null;

// 进入投票阶段:发言已经结束,这里只投票。
// 玩家可在时间内随时改票;到点(tick)或全员投完即结算。
function enterDay(s) {
  s.phase = 'day';
  s.votes = {};
  s.speechOrder = null;
  s.speechIndex = 0;
  setDeadline(s, s.cfg.daySeconds);
  s.log.push({ type: 'phase', phase: 'day', round: s.round });
}

// 夜晚第一段:定下狼刀的目标(还没真死 —— 女巫可能救)。
// 有存活女巫就进 witch 阶段让她决定;否则直接结算。
function resolveNight(s) {
  const votes = s.nightActions.wolfTargetVotes || {};
  const tally = {};
  Object.values(votes).forEach((t) => { tally[t] = (tally[t] || 0) + 1; });
  let victim = null, max = 0;
  for (const [t, c] of Object.entries(tally)) { if (c > max) { max = c; victim = t; } }

  s.nightActions.victim = victim && s.alive[victim] ? victim : null;

  const witch = s.players.find((p) => s.roles[p.id] === ROLE.WITCH && s.alive[p.id]);
  const hasPotion = s.potions.heal || s.potions.poison;
  if (witch && hasPotion && !s.absent[witch.id]) { enterWitchTurn(s); return; }
  finishNight(s);
}

// 夜晚第二段:把狼刀 + 女巫用药的结果一并结算。
// 救人只是取消狼刀,不是"复活",所以顺序上先看 heal 再落死亡。
function finishNight(s) {
  const w = s.nightActions.witch || {};
  const victim = s.nightActions.victim;
  const deaths = [];

  if (victim && !w.heal) deaths.push({ id: victim, cause: 'wolf' });
  if (w.poison) deaths.push({ id: w.poison, cause: 'poison' });

  let hunterTriggered = false;
  for (const d of deaths) {
    if (killPlayer(s, d.id, d.cause)) hunterTriggered = true;
  }

  s.lastNightVictim = deaths.length ? deaths.map((d) => d.id) : null;
  s.log.push({ type: 'night_result', victim: s.lastNightVictim });
  s.nightActions.victim = null;

  if (checkWin(s)) return;
  // 猎人被刀时先让他开枪,再进白天发言
  if (hunterTriggered) { s.resumeTo = 'day'; enterHunterTurn(s); return; }
  enterSpeech(s);
}

// 数票:返回得票最高者。max 为最高票数,leaders 为并列最高的所有人(可能 1 个或多个)。
// 弃票(null)不计入。无人投票时 leaders 为空。
function tallyVotes(votes) {
  const tally = {};
  Object.values(votes).forEach((t) => { if (t) tally[t] = (tally[t] || 0) + 1; });
  let max = 0;
  for (const c of Object.values(tally)) if (c > max) max = c;
  const leaders = Object.keys(tally).filter((t) => tally[t] === max);
  return { tally, max, leaders };
}

// 放逐一名玩家并记日志、判胜负、进下一夜。out 为 null 表示无人出局。
function exileAndAdvance(s, out) {
  const hunterTriggered = out && s.alive[out] ? killPlayer(s, out, 'vote') : false;
  s.lastVotedOut = out && !s.alive[out] ? out : null;
  s.log.push({ type: 'vote_result', out: s.lastVotedOut });
  if (checkWin(s)) return;
  // 被票出的猎人可以开枪带走一个,再进夜晚
  if (hunterTriggered) { s.resumeTo = 'night'; enterHunterTurn(s); return; }
  enterNight(s);
}

// 猎人开枪结束(开了或放弃/超时)→ 回到本来该去的阶段。
function resumeAfterHunter(s) {
  const to = s.resumeTo === 'night' ? 'night' : 'day';
  s.pendingHunter = null;
  s.resumeTo = null;
  if (checkWin(s)) return;
  // 回白天时要回到"发言"而不是直接投票 —— 猎人的枪响本身就是重要信息,
  // 大家需要在发言里消化它。
  if (to === 'night') enterNight(s); else enterSpeech(s);
}

// 结算白天投票:
//   唯一最高票 → 放逐;
//   平票 → 开了 tiePk 且是首轮投票(非 PK 阶段) → 进 PK 加赛;否则无人出局。
function resolveVote(s) {
  const { max, leaders } = tallyVotes(s.votes);
  if (leaders.length === 1 && max > 0) { exileAndAdvance(s, leaders[0]); return; }
  // 平票或无人投票。首轮平票且开启 PK 且有 ≥2 个平票者 → 进 PK
  if (s.cfg.tiePk && leaders.length >= 2) { enterPk(s, leaders); return; }
  exileAndAdvance(s, null); // 无票 / 关闭PK的平票 → 无人出局
}

// 进入 PK 加赛:平票者成为候选,其余存活玩家重投一轮(候选人不投)。
function enterPk(s, candidates) {
  s.phase = 'pk';
  s.pkCandidates = candidates;
  s.votes = {};
  setDeadline(s, s.cfg.pkSeconds);
  s.log.push({ type: 'phase', phase: 'pk', round: s.round, candidates });
}

// 结算 PK 投票:唯一最高票放逐;再平票 → 无人出局(不无限 PK)。
function resolvePk(s) {
  const { max, leaders } = tallyVotes(s.votes);
  s.pkCandidates = null;
  exileAndAdvance(s, leaders.length === 1 && max > 0 ? leaders[0] : null);
}

// ── 应用动作 ──
// { type:'start' }                房主开始
// { type:'wolf_kill', target }    狼人投票杀人(夜晚)
// { type:'seer_check', target }   预言家查验(夜晚)
// { type:'vote', target }         白天投票(target 可为 null 弃票)
function applyAction(s, action, playerId) {
  const events = [];
  const isAlive = s.alive[playerId];

  // 观战者(及任何不在本局里的 id)不能行动。tick 由服务端驱动,playerId 为 null。
  // 发言这一条尤其重要:观战者不在 alive 表里,会被当成死人路由进死人频道,
  // 于是开了上帝视角的观战者可以把看到的身份直接播给所有死者。
  if (action.type !== 'tick' && !(playerId in s.alive)) {
    return { error: '你不是本局玩家' };
  }

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
      // 每夜只能查一个。seerResults 是跨夜累积的,不像狼人的 wolfTargetVotes 那样
      // 按玩家 id 覆盖 —— 少了这道门禁,预言家一夜就能把全场查穿,天亮直接报完狼坑。
      if (s.nightActions.seerCheck) return { error: '今晚已经查验过了' };
      if (!s.alive[action.target]) return { error: '目标无效' };
      if (action.target === playerId) return { error: '不能查验自己' };
      const result = s.roles[action.target] === ROLE.WOLF ? 'wolf' : 'good';
      s.seerResults[playerId] = s.seerResults[playerId] || {};
      s.seerResults[playerId][action.target] = result;
      s.nightActions.seerCheck = { seerId: playerId, targetId: action.target };
      maybeResolveNight(s);
      return { state: s, events };
    }

    // 女巫用药。{ heal: true } 救刀口 / { poison: targetId } 毒一个 / 两者皆无 = 跳过。
    // 同一夜只能用一瓶(标准规则),药用完不可再用。
    case 'witch': {
      if (s.phase !== 'witch') return { error: '非女巫行动阶段' };
      if (!isAlive || s.roles[playerId] !== ROLE.WITCH) return { error: '只有存活女巫能用药' };
      if (s.nightActions.witch) return { error: '今晚已经行动过了' };

      const { heal, poison } = action;
      if (heal && poison) return { error: '同一夜只能用一瓶药' };

      if (heal) {
        if (!s.potions.heal) return { error: '解药已经用过了' };
        if (!s.nightActions.victim) return { error: '今晚没有人被刀' };
        // 首夜可以自救,之后不行 —— 否则女巫近乎无敌
        if (s.nightActions.victim === playerId && s.round > 1) return { error: '不能自救' };
        s.potions.heal = false;
        s.nightActions.witch = { heal: true };
      } else if (poison) {
        if (!s.potions.poison) return { error: '毒药已经用过了' };
        if (!s.alive[poison]) return { error: '目标无效' };
        if (poison === playerId) return { error: '不能毒自己' };
        s.potions.poison = false;
        s.nightActions.witch = { poison };
      } else {
        s.nightActions.witch = {};   // 明确跳过
      }
      finishNight(s);
      return { state: s, events };
    }

    // 结束自己的发言("过")。只有当前发言人能过,防止别人替他跳过。
    case 'pass_speech': {
      if (s.phase !== 'speech') return { error: '非发言阶段' };
      if (playerId !== currentSpeaker(s)) return { error: '现在不是你发言' };
      nextSpeaker(s);
      return { state: s, events };
    }

    // 猎人开枪:出局瞬间带走一名存活玩家。target 为 null 表示放弃。
    case 'hunter_shoot': {
      if (s.phase !== 'hunter') return { error: '非猎人开枪阶段' };
      if (playerId !== s.pendingHunter) return { error: '不是你开枪' };
      s.hunterCanShoot = false;
      const target = action.target;
      if (target) {
        if (!s.alive[target]) return { error: '目标无效' };
        killPlayer(s, target, 'shot');   // 被猎人打死的若也是猎人,已用过枪不会再触发
        s.log.push({ type: 'hunter_shot', playerId, target });
      } else {
        s.log.push({ type: 'hunter_shot', playerId, target: null });
      }
      resumeAfterHunter(s);
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

    // PK 加赛投票:只有非候选的存活玩家能投,且只能投候选人之一(或弃票)。
    case 'pk_vote': {
      if (s.phase !== 'pk') return { error: '非 PK 阶段' };
      if (!isAlive) return { error: '死亡玩家不能投票' };
      if (s.pkCandidates.includes(playerId)) return { error: 'PK 候选人不参与投票' };
      if (action.target && !s.pkCandidates.includes(action.target)) return { error: '只能投 PK 候选人' };
      s.votes[playerId] = action.target || null;
      hurryDayIfAllVoted(s);   // 全员(非候选存活者)投完 → 压缩倒计时
      return { state: s, events };
    }

    // 发言(讨论用)。白天/PK 阶段:存活者发到公开频道(死者/观战者也可见);
    // 死亡玩家:任何非结束阶段都可发,但只进"死人频道"(仅死者+观战者可见,防剧透)。
    // 夜晚存活者不能公开发言(天黑闭眼)。频道路由在传输层(server.js)按 channel 分发。
    case 'chat': {
      if (s.phase === 'ended' || s.phase === 'lobby') return { error: '当前不能发言' };
      const text = String(action.text || '').trim().slice(0, CHAT_MAX);
      if (!text) return { state: s, events };
      if (isAlive) {
        // 发言阶段:只有当前发言人能说。这是整个机制的关键 ——
        // 少了这道校验,狼就能在别人发言时刷屏把报点冲走。
        if (s.phase === 'speech') {
          if (playerId !== currentSpeaker(s)) return { error: '还没轮到你发言' };
        } else if (s.phase !== 'day' && s.phase !== 'pk') {
          return { error: '现在还不能公开发言' };
        }
        events.push({ type: 'chat', channel: 'alive', playerId, text });
      } else {
        events.push({ type: 'chat', channel: 'dead', playerId, text });
      }
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
      } else if (s.phase === 'witch') {
        // 女巫没在时限内用药 → 视为跳过,按原刀口结算
        s.nightActions.witch = s.nightActions.witch || {};
        finishNight(s);
      } else if (s.phase === 'hunter') {
        // 猎人没开枪 → 视为放弃
        s.hunterCanShoot = false;
        resumeAfterHunter(s);
      } else if (s.phase === 'speech') {
        // 发言超时 → 自动轮到下一位(线下也是这样,时间到就换人)
        nextSpeaker(s);
      } else if (s.phase === 'day') {
        // 到点结算:未投的算弃票,平票视配置进 PK 或无人出局
        resolveVote(s);
      } else if (s.phase === 'pk') {
        // PK 到点结算:再平票无人出局
        resolvePk(s);
      }
      return { state: s, events };
    }

    default:
      return { error: '未知动作' };
  }
}

// 该阶段哪些在场存活玩家"应当投票"。白天=全部;PK=非候选者(候选人不投自己那轮)。
function expectedVoters(s) {
  const voters = presentIds(s);
  if (s.phase === 'pk') return voters.filter((id) => !s.pkCandidates.includes(id));
  return voters;
}

// 全员投完 → 把 deadline 压到 DAY_HURRY_SECONDS 后(只缩短,不延长)。
// "全员"= 该阶段应投票的在场存活玩家都有票记录(弃票 null 也算已投);掉线者不阻塞,
// 与 maybeResolveNight 用 presentIds 保持一致。压缩后仍可改票,到点由 tick 结算。
function hurryDayIfAllVoted(s) {
  if ((s.phase !== 'day' && s.phase !== 'pk') || s.deadline == null) return;
  const voters = expectedVoters(s);
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
  } else if (s.phase === 'speech' && playerId === currentSpeaker(s)) {
    // 正在发言的人掉线 → 直接轮下一个,不让全场等满他的 45 秒
    nextSpeaker(s);
  } else if (s.phase === 'witch' && s.roles[playerId] === ROLE.WITCH) {
    // 全场都在等女巫,她掉线了 → 视为跳过,别让所有人干等到超时
    s.nightActions.witch = s.nightActions.witch || {};
    finishNight(s);
  } else if (s.phase === 'hunter' && playerId === s.pendingHunter) {
    s.hunterCanShoot = false;
    resumeAfterHunter(s);
  } else if (s.phase === 'day' || s.phase === 'pk') {
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
  } else if (s.phase === 'speech' && playerId === currentSpeaker(s)) {
    // 正在发言的人掉线 → 直接轮下一个,不让全场等满他的 45 秒
    nextSpeaker(s);
  } else if (s.phase === 'witch' && s.roles[playerId] === ROLE.WITCH) {
    s.nightActions.witch = s.nightActions.witch || {};
    finishNight(s);
  } else if (s.phase === 'hunter' && playerId === s.pendingHunter) {
    s.hunterCanShoot = false;
    resumeAfterHunter(s);
  } else if (s.phase === 'pk') {
    // 出局的若是 PK 候选人:剔除他;不足 2 人则 PK 无意义,直接结算
    s.pkCandidates = s.pkCandidates.filter((id) => id !== playerId);
    if (s.pkCandidates.length < 2) resolvePk(s);
    else hurryDayIfAllVoted(s);
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
    cfg: s.cfg,                         // 房主配置(前端提示"平票将进入 PK"等)
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
  // 女巫:能看到自己剩余的药,以及(仅在她行动的那一段)今晚的刀口。
  // 刀口只发给女巫本人 —— 发给别人等于直接公开今晚谁死。
  if (myRole === ROLE.WITCH) {
    view.potions = s.potions;
    if (s.phase === 'witch') {
      view.witchVictim = s.nightActions.victim;
      view.iActed = !!s.nightActions.witch;
      // 首夜可自救,之后不行 —— 前端据此禁用解药按钮
      view.canSelfHeal = s.round <= 1;
    }
  }
  // 猎人:知道自己还能不能开枪(枪响过就没了)
  if (myRole === ROLE.HUNTER) view.hunterCanShoot = s.hunterCanShoot;
  // 猎人开枪阶段:全房间都知道"轮到猎人了"(公开信息,他已经出局),
  // 但只有猎人本人拿到可开枪的标记
  if (s.phase === 'hunter') {
    view.pendingHunter = s.pendingHunter;
    view.iAmShooting = playerId === s.pendingHunter;
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
  // 发言阶段:谁在说、还有谁没说,都是公开信息(线下所有人都看得见轮到谁)
  if (s.phase === 'speech') {
    view.speechOrder = s.speechOrder;
    view.currentSpeaker = currentSpeaker(s);
    view.iAmSpeaking = playerId === view.currentSpeaker;
    view.spokenCount = s.speechIndex;
    view.speechTotal = (s.speechOrder || []).length;
  }
  // 白天/PK(投票):公开当前票型(谁投了谁);并标记本人当前票与是否已投
  if (s.phase === 'day' || s.phase === 'pk') {
    view.votes = s.votes;
    view.iVoted = playerId in s.votes;
    view.myVote = playerId in s.votes ? s.votes[playerId] : undefined;
    // 该阶段应投票者全投完 → 前端提示"即将结算",解释倒计时为何突然缩短
    const voters = expectedVoters(s);
    view.dayAllVoted = voters.length > 0 && voters.every((id) => id in s.votes);
    if (s.phase === 'pk') {
      view.pkCandidates = s.pkCandidates;               // 前端据此限定投票对象、显示 PK 提示
      view.iAmPkCandidate = s.pkCandidates.includes(playerId);
    }
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
  // 房主配置元数据(供大厅设置面板)。
  // type:'toggle' → 开关;type:'options' → 一排可选值按钮。两者都由通用面板渲染,
  // 加新配置项只改这里,前端不用动。
  configSchema: {
    tiePk: { type: 'toggle', default: DEFAULTS.tiePk,
             label: '平票进入 PK 加赛', hint: '白天平票时,平票者发言后其余玩家重投一轮' },
    speechSeconds: { type: 'options', options: TIME_OPTIONS.speechSeconds, default: DEFAULTS.speechSeconds,
                     unit: 's', label: '每人发言时长', hint: '轮流发言,说完可点"过"提前结束' },
    daySeconds: { type: 'options', options: TIME_OPTIONS.daySeconds, default: DEFAULTS.daySeconds,
                  unit: 's', label: '投票时长', hint: '发言结束后的投票阶段,期间可改票' },
    nightSeconds: { type: 'options', options: TIME_OPTIONS.nightSeconds, default: DEFAULTS.nightSeconds,
                    unit: 's', label: '夜晚时长', hint: '狼人选刀 + 预言家查验' },
    witchSeconds: { type: 'options', options: TIME_OPTIONS.witchSeconds, default: DEFAULTS.witchSeconds,
                    unit: 's', label: '女巫用药时长', hint: '7 人及以上才有女巫' },
    hunterSeconds: { type: 'options', options: TIME_OPTIONS.hunterSeconds, default: DEFAULTS.hunterSeconds,
                     unit: 's', label: '猎人开枪时长', hint: '10 人及以上才有猎人' },
    pkSeconds: { type: 'options', options: TIME_OPTIONS.pkSeconds, default: DEFAULTS.pkSeconds,
                 unit: 's', label: 'PK 投票时长', hint: '仅在开启平票 PK 时用到' },
    revealSeconds: { type: 'options', options: TIME_OPTIONS.revealSeconds, default: DEFAULTS.revealSeconds,
                     unit: 's', label: '身份揭晓时长', hint: '所有人点"进入游戏"即提前开始' },
  },
};
