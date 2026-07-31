// 狼人杀规则测试 —— 覆盖 applyAction 里"违反了不会崩、只会安静地毁掉这局"的规则。
//
// 契约测试(../contract.test.js)管的是接口和信息隔离;这里管的是游戏规则本身。
// 两者抓的东西不重叠:预言家一夜查穿全场既不是崩溃也不是泄露,是规则缺失。
//
//   cd server && npm test

const { test } = require('node:test');
const assert = require('node:assert');

const ww = require('./index');

const P = (n) => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i }));
const roleOf = (s, r) => Object.keys(s.roles).filter((id) => s.roles[id] === r);

// 造一个已进入夜晚的状态(跳过 lobby/reveal,直接测夜晚规则)
function nightState(n) {
  const s = ww.createInitialState(P(n), {});
  s.phase = 'night';
  s.nightActions = { wolfTargetVotes: {}, seerCheck: null };
  s.deadline = Date.now() + 40_000;
  return s;
}

// ── 预言家 ──

test('预言家每夜只能查验一人', () => {
  const s = nightState(12);
  const seer = roleOf(s, 'seer')[0];
  const others = Object.keys(s.roles).filter((id) => id !== seer);

  const first = ww.applyAction(s, { type: 'seer_check', target: others[0] }, seer);
  assert.ok(!first.error, '第一次查验应当成功');

  const second = ww.applyAction(s, { type: 'seer_check', target: others[1] }, seer);
  assert.ok(second.error, '同一夜的第二次查验必须被拒绝 —— 否则预言家一夜可查穿全场');

  assert.strictEqual(
    Object.keys(s.seerResults[seer]).length, 1,
    '一夜过后累计查验结果只应有 1 条'
  );
});

test('预言家跨夜可以继续查验(每夜各一次)', () => {
  const s = nightState(8);
  const seer = roleOf(s, 'seer')[0];
  const others = Object.keys(s.roles).filter((id) => id !== seer);

  ww.applyAction(s, { type: 'seer_check', target: others[0] }, seer);
  s.nightActions = { wolfTargetVotes: {}, seerCheck: null };   // 模拟进入下一夜
  const next = ww.applyAction(s, { type: 'seer_check', target: others[1] }, seer);

  assert.ok(!next.error, '新的一夜应当可以再查一次');
  assert.strictEqual(Object.keys(s.seerResults[seer]).length, 2, '两夜应累计 2 条结果');
});

test('预言家不能查验自己', () => {
  const s = nightState(6);
  const seer = roleOf(s, 'seer')[0];
  assert.ok(ww.applyAction(s, { type: 'seer_check', target: seer }, seer).error);
});

test('查验结果只有本人看得到,且内容正确', () => {
  const s = nightState(8);
  const seer = roleOf(s, 'seer')[0];
  const wolf = roleOf(s, 'wolf')[0];
  ww.applyAction(s, { type: 'seer_check', target: wolf }, seer);

  assert.strictEqual(ww.serializeStateFor(s, seer).seerResults[wolf], 'wolf', '查狼应返回 wolf');

  for (const p of s.players) {
    if (p.id === seer) continue;
    assert.strictEqual(
      ww.serializeStateFor(s, p.id).seerResults, undefined,
      '非预言家的视图里不应出现 seerResults'
    );
  }
});

// ── 狼人 ──

test('狼人改刀是覆盖,不是追加(一狼一票)', () => {
  const s = nightState(12);
  const wolf = roleOf(s, 'wolf')[0];
  const goods = Object.keys(s.roles).filter((id) => s.roles[id] !== 'wolf');

  ww.applyAction(s, { type: 'wolf_kill', target: goods[0] }, wolf);
  ww.applyAction(s, { type: 'wolf_kill', target: goods[1] }, wolf);

  assert.strictEqual(s.nightActions.wolfTargetVotes[wolf], goods[1], '应记最后一次改刀');
  assert.strictEqual(
    Object.keys(s.nightActions.wolfTargetVotes).length, 1,
    '一只狼无论投几次都只占一票'
  );
});

test('非狼人不能刀,非预言家不能查', () => {
  const s = nightState(8);
  const villager = roleOf(s, 'villager')[0];
  const target = roleOf(s, 'wolf')[0];
  assert.ok(ww.applyAction(s, { type: 'wolf_kill', target }, villager).error);
  assert.ok(ww.applyAction(s, { type: 'seer_check', target }, villager).error);
});

test('夜晚行动不能在白天发起', () => {
  const s = nightState(8);
  s.phase = 'day';
  const wolf = roleOf(s, 'wolf')[0];
  const seer = roleOf(s, 'seer')[0];
  const t = roleOf(s, 'villager')[0];
  assert.ok(ww.applyAction(s, { type: 'wolf_kill', target: t }, wolf).error);
  assert.ok(ww.applyAction(s, { type: 'seer_check', target: t }, seer).error);
});

// ── 投票 ──

test('死亡玩家不能投票', () => {
  const s = ww.createInitialState(P(6), {});
  s.phase = 'day'; s.votes = {}; s.deadline = Date.now() + 60_000;
  const dead = s.players[0].id;
  s.alive[dead] = false;
  assert.ok(ww.applyAction(s, { type: 'vote', target: s.players[1].id }, dead).error);
});

test('PK 候选人不参与 PK 投票,且只能投候选人', () => {
  const s = ww.createInitialState(P(6), {});
  const ids = s.players.map((p) => p.id);
  s.phase = 'pk'; s.votes = {}; s.pkCandidates = [ids[0], ids[1]];
  s.deadline = Date.now() + 30_000;

  assert.ok(ww.applyAction(s, { type: 'vote', target: ids[1] }, ids[0]).error, '候选人不该能投票');
  assert.ok(
    ww.applyAction(s, { type: 'pk_vote', target: ids[3] }, ids[2]).error,
    '不该能投非候选人'
  );
  assert.ok(!ww.applyAction(s, { type: 'pk_vote', target: ids[0] }, ids[2]).error);
});

// ── 胜负 ──

test('刀掉唯一的神职不会立刻结束游戏', () => {
  // 屠神边只在神职足够多时才是有意义的胜利条件。当前板子只有 1 个神(预言家),
  // 沿用屠神边等于"第一晚刀中某个特定的人就赢":实测狼盲刀时 6 人局 20%、
  // 8 人局 17% 的对局在第一个白天开始前就结束,其他人一句话没说。
  for (const n of [6, 8, 10, 12]) {
    const s = nightState(n);
    const seer = roleOf(s, 'seer')[0];
    s.alive[seer] = false;
    s.deadline = Date.now() - 1;
    ww.applyAction(s, { type: 'tick' }, null);

    assert.notStrictEqual(s.phase, 'ended', `${n} 人局:刀掉预言家后不该立即结束`);
  }
});

test('狼人数 ≥ 好人数 → 狼胜(已成定局,不必走流程)', () => {
  const s = nightState(8);
  const wolves = roleOf(s, 'wolf');
  const goods = s.players.map((p) => p.id).filter((id) => !wolves.includes(id));
  // 留到只剩 (狼数) 个好人 —— 狼可以强行票死任何人
  goods.slice(wolves.length).forEach((id) => { s.alive[id] = false; });

  // 从白天结算触发。夜晚会先经过女巫阶段,那是另一条路径,这里只关心胜负判定。
  s.phase = 'day'; s.votes = {}; s.deadline = Date.now() - 1;
  ww.applyAction(s, { type: 'tick' }, null);
  assert.strictEqual(s.phase, 'ended');
  assert.strictEqual(s.winner, 'wolf');
});

test('平民全灭 → 狼胜(屠民边仍然有效)', () => {
  const s = nightState(12);
  roleOf(s, 'villager').forEach((id) => { s.alive[id] = false; });
  s.phase = 'day'; s.votes = {}; s.deadline = Date.now() - 1;
  ww.applyAction(s, { type: 'tick' }, null);
  assert.strictEqual(s.winner, 'wolf', '屠民边不受本次改动影响');
});

test('狼全出局 → 好人胜', () => {
  const s = nightState(6);
  roleOf(s, 'wolf').forEach((id) => { s.alive[id] = false; });
  s.deadline = Date.now() - 1;
  ww.applyAction(s, { type: 'tick' }, null);
  assert.strictEqual(s.phase, 'ended');
  assert.strictEqual(s.winner, 'good');
});

test('掉线不判负:唯一的狼掉线后好人不会自动获胜', () => {
  const s = nightState(6);
  const wolf = roleOf(s, 'wolf')[0];
  ww.removePlayer(s, wolf);
  assert.notStrictEqual(s.phase, 'ended', '仅掉线不应结束游戏');
  assert.strictEqual(s.alive[wolf], true, '掉线不等于出局');
});

test('宽限期后真正出局:唯一的狼退出 → 好人胜', () => {
  const s = nightState(6);
  const wolf = roleOf(s, 'wolf')[0];
  ww.eliminatePlayer(s, wolf);
  assert.strictEqual(s.phase, 'ended', '真出局后必须重跑胜负,否则好人永远赢不了');
  assert.strictEqual(s.winner, 'good');
});

// ── 女巫 ──

// 造一个"狼刀已定、轮到女巫"的状态
function witchTurn(n = 8) {
  const s = ww.createInitialState(P(n), {});
  ww.applyAction(s, { type: 'start' }, s.hostId);
  s.players.forEach((p) => ww.applyAction(s, { type: 'ready' }, p.id));
  const victim = s.players.map((p) => p.id)
    .find((id) => s.roles[id] === ROLE_VILLAGER && s.alive[id]);
  roleOf(s, 'wolf').forEach((w) => ww.applyAction(s, { type: 'wolf_kill', target: victim }, w));
  const seer = roleOf(s, 'seer')[0];
  if (s.phase === 'night' && seer) {
    const t = s.players.map((p) => p.id).find((id) => id !== seer && s.alive[id]);
    ww.applyAction(s, { type: 'seer_check', target: t }, seer);
  }
  return { s, witch: roleOf(s, 'witch')[0], victim };
}
const ROLE_VILLAGER = 'villager';

test('女巫能看到今晚的刀口,别人看不到', () => {
  const { s, witch, victim } = witchTurn();
  assert.strictEqual(s.phase, 'witch', '狼刀结算后应进入女巫阶段');
  assert.strictEqual(ww.serializeStateFor(s, witch).witchVictim, victim);

  for (const p of s.players) {
    if (p.id === witch) continue;
    assert.strictEqual(
      ww.serializeStateFor(s, p.id).witchVictim, undefined,
      '刀口只能发给女巫 —— 发给别人等于公开今晚谁死'
    );
  }
});

test('解药救下刀口,毒药毒死目标,各自消耗', () => {
  let { s, witch, victim } = witchTurn();
  ww.applyAction(s, { type: 'witch', heal: true }, witch);
  assert.strictEqual(s.alive[victim], true, '被救的人应存活');
  assert.strictEqual(s.potions.heal, false, '解药应被消耗');

  ({ s, witch, victim } = witchTurn());
  const target = s.players.map((p) => p.id).find((id) => id !== witch && id !== victim && s.alive[id]);
  ww.applyAction(s, { type: 'witch', poison: target }, witch);
  assert.strictEqual(s.alive[victim], false, '没救就该死');
  assert.strictEqual(s.alive[target], false, '被毒的人应出局');
  assert.strictEqual(s.potions.poison, false, '毒药应被消耗');
});

test('同一夜不能又救又毒;药用完不能再用', () => {
  let { s, witch, victim } = witchTurn();
  const other = s.players.map((p) => p.id).find((id) => id !== witch && id !== victim && s.alive[id]);
  assert.ok(ww.applyAction(s, { type: 'witch', heal: true, poison: other }, witch).error);

  ({ s, witch } = witchTurn());
  s.potions.heal = false;
  assert.ok(ww.applyAction(s, { type: 'witch', heal: true }, witch).error, '解药用完不能再救');
});

test('首夜可以自救,之后不能', () => {
  // 首夜:狼刀女巫,她可以救自己
  const s1 = ww.createInitialState(P(8), {});
  ww.applyAction(s1, { type: 'start' }, s1.hostId);
  s1.players.forEach((p) => ww.applyAction(s1, { type: 'ready' }, p.id));
  const w1 = roleOf(s1, 'witch')[0];
  roleOf(s1, 'wolf').forEach((w) => ww.applyAction(s1, { type: 'wolf_kill', target: w1 }, w));
  const se1 = roleOf(s1, 'seer')[0];
  if (s1.phase === 'night' && se1) {
    ww.applyAction(s1, { type: 'seer_check', target: s1.players.find((p) => p.id !== se1).id }, se1);
  }
  assert.ok(!ww.applyAction(s1, { type: 'witch', heal: true }, w1).error, '首夜应可自救');

  // 第二夜起不行
  const { s, witch } = witchTurn();
  s.round = 2;
  s.nightActions.victim = witch;
  assert.ok(ww.applyAction(s, { type: 'witch', heal: true }, witch).error, '首夜之后不能自救');
});

test('非女巫不能用药;女巫掉线不会卡住全场', () => {
  const { s, witch, victim } = witchTurn();
  const other = s.players.map((p) => p.id).find((id) => id !== witch && s.alive[id]);
  assert.ok(ww.applyAction(s, { type: 'witch', heal: true }, other).error);

  ww.removePlayer(s, witch);
  assert.notStrictEqual(s.phase, 'witch', '女巫掉线应视为跳过,否则全场干等到超时');
  assert.strictEqual(s.alive[victim], false, '跳过后按原刀口结算');
});

// ── 猎人 ──

test('猎人被刀可以开枪带走一人,之后进白天', () => {
  const s = ww.createInitialState(P(12), {});
  ww.applyAction(s, { type: 'start' }, s.hostId);
  s.players.forEach((p) => ww.applyAction(s, { type: 'ready' }, p.id));
  const hunter = roleOf(s, 'hunter')[0];
  roleOf(s, 'wolf').forEach((w) => ww.applyAction(s, { type: 'wolf_kill', target: hunter }, w));
  const seer = roleOf(s, 'seer')[0];
  if (s.phase === 'night') {
    ww.applyAction(s, { type: 'seer_check', target: s.players.find((p) => p.id !== seer).id }, seer);
  }
  if (s.phase === 'witch') ww.applyAction(s, { type: 'witch' }, roleOf(s, 'witch')[0]);

  assert.strictEqual(s.phase, 'hunter', '猎人出局应进入开枪阶段');
  assert.strictEqual(s.pendingHunter, hunter);

  const target = s.players.map((p) => p.id).find((id) => s.alive[id]);
  ww.applyAction(s, { type: 'hunter_shoot', target }, hunter);
  assert.strictEqual(s.alive[target], false, '被开枪的人应出局');
  assert.ok(s.phase !== 'hunter', '开枪后应离开该阶段');
});

test('猎人被毒死不能开枪', () => {
  const s = ww.createInitialState(P(12), {});
  ww.applyAction(s, { type: 'start' }, s.hostId);
  s.players.forEach((p) => ww.applyAction(s, { type: 'ready' }, p.id));
  const hunter = roleOf(s, 'hunter')[0];
  const witch = roleOf(s, 'witch')[0];
  const victim = s.players.map((p) => p.id).find((id) => s.roles[id] === 'villager' && s.alive[id]);
  roleOf(s, 'wolf').forEach((w) => ww.applyAction(s, { type: 'wolf_kill', target: victim }, w));
  const seer = roleOf(s, 'seer')[0];
  if (s.phase === 'night') {
    ww.applyAction(s, { type: 'seer_check', target: s.players.find((p) => p.id !== seer).id }, seer);
  }
  ww.applyAction(s, { type: 'witch', poison: hunter }, witch);

  assert.strictEqual(s.alive[hunter], false, '猎人应被毒死');
  assert.notStrictEqual(s.phase, 'hunter', '被毒死的猎人不能开枪');
  assert.strictEqual(s.pendingHunter, null);
});

test('猎人被票出后开枪,再进夜晚', () => {
  const s = ww.createInitialState(P(12), {});
  ww.applyAction(s, { type: 'start' }, s.hostId);
  s.players.forEach((p) => ww.applyAction(s, { type: 'ready' }, p.id));
  const hunter = roleOf(s, 'hunter')[0];
  s.phase = 'day'; s.votes = {}; s.deadline = Date.now() + 60_000;
  s.players.filter((p) => s.alive[p.id] && p.id !== hunter)
    .forEach((p) => ww.applyAction(s, { type: 'vote', target: hunter }, p.id));
  s.deadline = Date.now() - 1;
  ww.applyAction(s, { type: 'tick' }, null);

  assert.strictEqual(s.phase, 'hunter');
  const target = s.players.map((p) => p.id).find((id) => s.alive[id]);
  ww.applyAction(s, { type: 'hunter_shoot', target }, hunter);
  assert.strictEqual(s.phase, 'night', '白天票出的猎人开完枪应进夜晚');
});

test('非猎人不能开枪;超时视为放弃', () => {
  const s = ww.createInitialState(P(12), {});
  ww.applyAction(s, { type: 'start' }, s.hostId);
  s.players.forEach((p) => ww.applyAction(s, { type: 'ready' }, p.id));
  const hunter = roleOf(s, 'hunter')[0];
  s.phase = 'hunter'; s.pendingHunter = hunter; s.resumeTo = 'day';
  s.deadline = Date.now() + 20_000;

  const other = s.players.map((p) => p.id).find((id) => id !== hunter && s.alive[id]);
  assert.ok(ww.applyAction(s, { type: 'hunter_shoot', target: other }, other).error);

  s.deadline = Date.now() - 1;
  ww.applyAction(s, { type: 'tick' }, null);
  assert.notStrictEqual(s.phase, 'hunter', '超时应自动离开开枪阶段');
});

// ── 神职数量与屠神边 ──

test('神职按人数递进上场', () => {
  const gods = (n) => {
    const s = ww.createInitialState(P(n), {});
    return Object.values(s.roles).filter((r) => ['seer', 'witch', 'hunter'].includes(r)).length;
  };
  assert.strictEqual(gods(6), 1, '小局只有预言家');
  assert.strictEqual(gods(8), 2, '中局加女巫');
  assert.strictEqual(gods(12), 3, '大局加猎人');

  // 每种神最多 1 个
  const s = ww.createInitialState(P(12), {});
  for (const r of ['seer', 'witch', 'hunter']) {
    assert.strictEqual(roleOf(s, r).length, 1, `${r} 应该只有 1 个`);
  }
});

test('神职 ≥ 2 时屠神边恢复生效', () => {
  const s = nightState(8);
  roleOf(s, 'seer').concat(roleOf(s, 'witch')).forEach((id) => { s.alive[id] = false; });
  s.deadline = Date.now() - 1;
  ww.applyAction(s, { type: 'tick' }, null);
  assert.strictEqual(s.winner, 'wolf', '2 神时神全灭应判狼胜');
});

// ── 发言频道(死人频道不能被存活玩家看到,靠 channel 标记路由) ──

test('死亡玩家发言进 dead 频道,存活玩家发言进 alive 频道', () => {
  const s = ww.createInitialState(P(6), {});
  s.phase = 'day'; s.votes = {}; s.deadline = Date.now() + 60_000;
  const [a, b] = s.players.map((p) => p.id);
  s.alive[b] = false;

  const aliveEv = ww.applyAction(s, { type: 'chat', text: '我是预言家' }, a).events[0];
  assert.strictEqual(aliveEv.channel, 'alive');

  const deadEv = ww.applyAction(s, { type: 'chat', text: '他是狼' }, b).events[0];
  assert.strictEqual(deadEv.channel, 'dead', '死者发言必须标 dead,否则剧透给存活玩家');
});

test('夜晚存活玩家不能公开发言', () => {
  const s = nightState(6);
  assert.ok(ww.applyAction(s, { type: 'chat', text: '天黑说话' }, s.players[0].id).error);
});

test('观战者不能行动 —— 尤其不能发言', () => {
  // 观战者不在 alive 表里,chat 分支会把他当成死人路由进死人频道。
  // 房主开了上帝视角的观战者能看到所有身份,那就等于可以把全场身份播给所有死者。
  const s = nightState(6);
  s.phase = 'day'; s.votes = {}; s.deadline = Date.now() + 60_000;

  assert.ok(ww.applyAction(s, { type: 'chat', text: '狼是p3' }, '__spectator__').error);
  assert.ok(ww.applyAction(s, { type: 'vote', target: s.players[0].id }, '__spectator__').error);

  s.phase = 'night';
  assert.ok(ww.applyAction(s, { type: 'wolf_kill', target: s.players[0].id }, '__spectator__').error);
});

test('tick 不受"必须是本局玩家"限制(服务端驱动,无行动者)', () => {
  const s = nightState(6);
  assert.ok(!ww.applyAction(s, { type: 'tick' }, null).error, 'tick 的 playerId 是 null,必须放行');
});
