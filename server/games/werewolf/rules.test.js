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
