// Contract tests for the game modules (architecture tests) -- run with node --test, zero dependencies.
//
// Everything checked here is the kind of violation nobody would otherwise notice:
// information hiding depends on each module policing itself, and getting it wrong
// throws no exception and trips no linter -- it just quietly ships roles to people
// who should not see them.
// Turning those failures red is the only reason this file exists.
//
//   cd server && npm test
//
// Adding a game needs no change here: this applies automatically to every module
// registered in the registry.

const { test } = require('node:test');
const assert = require('node:assert');

const { listGames, getGame } = require('./registry');

// Mirrors spectatorViewFor in rooms.js: a spectator view is just serializeStateFor
// called with a player id that does not exist. That trick only holds if modules emit
// fields from an allowlist -- which is exactly the assumption pinned down below.
const SPECTATOR_ID = '__spectator__';

// Build a batch of fake players to feed createInitialState. Using maxPlayers spreads
// the role assignment as widely as possible.
function makePlayers(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Player${i}` }));
}

// Recursively collect every string value appearing in a view, so we can tell whether
// a secret leaked out.
function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) collectStrings(value[k], out);
  }
  return out;
}

const MODULES = listGames().map((g) => getGame(g.id));

test('every module in the registry implements the full interface', () => {
  assert.ok(MODULES.length > 0, 'the registry is empty');
  for (const mod of MODULES) {
    for (const fn of ['createInitialState', 'applyAction', 'serializeStateFor', 'isGameOver']) {
      assert.strictEqual(typeof mod[fn], 'function', `${mod.id} is missing ${fn}()`);
    }
    assert.ok(mod.minPlayers >= 1, `${mod.id} has an invalid minPlayers`);
    assert.ok(mod.maxPlayers >= mod.minPlayers, `${mod.id} has an invalid maxPlayers`);
  }
});

test('game modules are pure logic: they do not require socket / db / express', () => {
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
        `${entry.name}/${file} pulls in the transport or storage layer -- game modules must stay pure logic`
      );
    }
  }
});

// The core one: serializeStateFor must build its view from an allowlist.
// If someone changes it to `return { ...state }`, every secret field on the raw state
// comes along with it, and this test goes red immediately.
test('serializeStateFor does not copy the whole state to the player', () => {
  for (const mod of MODULES) {
    const state = mod.createInitialState(makePlayers(mod.maxPlayers), {});
    const canary = '__SECRET_CANARY__';
    state.__secretCanary = canary;   // simulate a newly added field that the view never explicitly allows

    for (const p of state.players || []) {
      const view = mod.serializeStateFor(state, p.id);
      assert.ok(
        !collectStrings(view).includes(canary),
        `${mod.id}: serializeStateFor let a field that was never explicitly allowed into the view ` +
        `(most likely a return {...state} or Object.assign). Views must be built field by field from an allowlist.`
      );
    }
  }
});

// Spectator safety: rooms.js generates the spectator view with a non-existent id, which
// relies on an unknown id receiving purely public information.
// If any module puts roles into the view unconditionally, anyone could join on a second
// account, spectate, and see the whole table -- pinned down here.
test('an unknown player id (a spectator) gets no role for anyone', () => {
  for (const mod of MODULES) {
    const state = mod.createInitialState(makePlayers(mod.maxPlayers), {});
    if (!state.roles) continue;               // this game has no hidden roles

    const view = mod.serializeStateFor(state, SPECTATOR_ID);
    assert.ok(
      view.roles === undefined,
      `${mod.id}: roles appeared in the spectator view -- the game is given away before it starts. ` +
      `Roles may only be revealed when phase === 'ended', or when the host explicitly enables god view (see spectatorViewFor in rooms.js).`
    );
    assert.strictEqual(
      view.myRole, undefined,
      `${mod.id}: an unknown id received myRole`
    );
  }
});

// The stop-the-clock contract: deadline is an absolute timestamp, so it has to be
// suspendable while nobody is in the room -- otherwise the countdown has already run out
// by the time anyone reconnects.
// A module implementing pauseClock must implement resumeClock too, and the two must
// genuinely be symmetric.
test('pauseClock / resumeClock come as a pair and are symmetric', () => {
  for (const mod of MODULES) {
    if (!mod.pauseClock && !mod.resumeClock) continue;
    assert.strictEqual(typeof mod.pauseClock, 'function', `${mod.id} has resumeClock but no pauseClock`);
    assert.strictEqual(typeof mod.resumeClock, 'function', `${mod.id} has pauseClock but no resumeClock`);

    const state = mod.createInitialState(makePlayers(mod.maxPlayers), {});
    state.phase = 'day';
    state.deadline = Date.now() + 30_000;

    mod.pauseClock(state);
    assert.strictEqual(
      state.deadline, null,
      `${mod.id}: pauseClock did not clear deadline -- the countdown keeps running while the clock is meant to be stopped`
    );
    mod.resumeClock(state);
    assert.ok(
      state.deadline > Date.now(),
      `${mod.id}: resumeClock did not set a new deadline in the future`
    );
  }
});
