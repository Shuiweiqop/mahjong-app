// 游戏模块契约测试(架构测试)—— 用 node --test 跑,零依赖。
//
// 这里检的都是"违反了没人会发现"的东西:信息隔离靠的是每个模块自觉,
// 写错了不会抛异常、不会 lint 报错,只会安静地把身份发给不该看的人。
// 把它们变成红灯,是这个文件存在的唯一理由。
//
//   cd server && npm test
//
// 新增游戏时不需要改本文件:它对 registry 里注册的所有模块自动生效。

const { test } = require('node:test');
const assert = require('node:assert');

const { listGames, getGame } = require('./registry');

// 与 rooms.js 的 spectatorViewFor 保持一致:观战者视图是"用一个不存在的玩家 id
// 调 serializeStateFor"。这个技巧成立的前提是模块按白名单发字段 —— 下面就是在钉死这个前提。
const SPECTATOR_ID = '__spectator__';

// 造一批假玩家喂给 createInitialState。取 maxPlayers 让角色分配尽量铺开。
function makePlayers(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `玩家${i}` }));
}

// 递归收集视图里出现的所有字符串值,用来判断"秘密有没有漏出去"。
function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) collectStrings(value[k], out);
  }
  return out;
}

const MODULES = listGames().map((g) => getGame(g.id));

test('registry 里每个模块都实现了完整接口', () => {
  assert.ok(MODULES.length > 0, 'registry 是空的');
  for (const mod of MODULES) {
    for (const fn of ['createInitialState', 'applyAction', 'serializeStateFor', 'isGameOver']) {
      assert.strictEqual(typeof mod[fn], 'function', `${mod.id} 缺少 ${fn}()`);
    }
    assert.ok(mod.minPlayers >= 1, `${mod.id} 的 minPlayers 无效`);
    assert.ok(mod.maxPlayers >= mod.minPlayers, `${mod.id} 的 maxPlayers 无效`);
  }
});

test('游戏模块是纯逻辑:不 require socket / db / express', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = __dirname;
  const banned = /require\(['"](socket\.io|express|pg|\.\.\/\.\.\/db|\.\.\/\.\.\/server)/;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const gameDir = path.join(dir, entry.name);
    for (const file of fs.readdirSync(gameDir)) {
      if (!file.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(gameDir, file), 'utf8');
      assert.ok(
        !banned.test(src),
        `${entry.name}/${file} 引入了传输/存储层 —— 游戏模块必须是纯逻辑`
      );
    }
  }
});

// 核心:serializeStateFor 必须按白名单构造视图。
// 若有人改成 `return { ...state }`,原始 state 的秘密字段会整个跟出来,这里立刻红。
test('serializeStateFor 不把整个 state 抄给玩家', () => {
  for (const mod of MODULES) {
    const state = mod.createInitialState(makePlayers(mod.maxPlayers), {});
    const canary = '__SECRET_CANARY__';
    state.__secretCanary = canary;   // 模拟"新加了一个没在视图里显式放行的字段"

    for (const p of state.players || []) {
      const view = mod.serializeStateFor(state, p.id);
      assert.ok(
        !collectStrings(view).includes(canary),
        `${mod.id}: serializeStateFor 把未显式放行的字段带进了视图` +
        `(多半是 return {...state} / Object.assign)。视图必须按白名单逐字段构造。`
      );
    }
  }
});

// 观战者安全:rooms.js 用一个不存在的 id 生成观战视图,前提是"陌生 id 拿到纯公开信息"。
// 若某个模块把 roles 无条件塞进视图,随便开个小号进来观战就能看穿全场 —— 这里钉死。
test('未知玩家 id(观战者)拿不到任何人的身份', () => {
  for (const mod of MODULES) {
    const state = mod.createInitialState(makePlayers(mod.maxPlayers), {});
    if (!state.roles) continue;               // 该游戏没有隐藏身份

    const view = mod.serializeStateFor(state, SPECTATOR_ID);
    assert.ok(
      view.roles === undefined,
      `${mod.id}: 观战视图里出现了 roles —— 未开局就泄底。` +
      `身份只能在 phase === 'ended' 或房主显式开上帝视角时公开(见 rooms.js spectatorViewFor)。`
    );
    assert.strictEqual(
      view.myRole, undefined,
      `${mod.id}: 陌生 id 拿到了 myRole`
    );
  }
});

// 停表契约:deadline 是绝对时间戳,房间没人时必须能挂起,否则重连后倒计时已经跑没了。
// 实现了 pauseClock 的模块必须同时实现 resumeClock,且两者要真的对称。
test('pauseClock / resumeClock 成对出现且对称', () => {
  for (const mod of MODULES) {
    if (!mod.pauseClock && !mod.resumeClock) continue;
    assert.strictEqual(typeof mod.pauseClock, 'function', `${mod.id} 有 resumeClock 却没有 pauseClock`);
    assert.strictEqual(typeof mod.resumeClock, 'function', `${mod.id} 有 pauseClock 却没有 resumeClock`);

    const state = mod.createInitialState(makePlayers(mod.maxPlayers), {});
    state.phase = 'day';
    state.deadline = Date.now() + 30_000;

    mod.pauseClock(state);
    assert.strictEqual(
      state.deadline, null,
      `${mod.id}: pauseClock 没有清掉 deadline —— 停表期间倒计时仍在走`
    );
    mod.resumeClock(state);
    assert.ok(
      state.deadline > Date.now(),
      `${mod.id}: resumeClock 没有重设出一个未来的 deadline`
    );
  }
});
