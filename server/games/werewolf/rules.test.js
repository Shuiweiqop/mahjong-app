// Werewolf rule tests -- covering the rules in applyAction whose violation does not crash anything, it just quietly ruins the game.
//
// The contract tests (../contract.test.js) cover the interface and information hiding; these cover the game rules themselves.
// What the two catch does not overlap: a seer checking the whole table in a single night is neither a crash nor a leak, it is a missing rule.
//
//   cd server && npm test

const { test } = require('node:test');
const assert = require('node:assert');

const ww = require('./index');

const P = (n) => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i }));
const roleOf = (s, r) => Object.keys(s.roles).filter((id) => s.roles[id] === r);

// Build a state that has already entered the night (skipping lobby/reveal, to test the night rules directly)
function nightState(n) {
  const s = ww.createInitialState(P(n), {});
  s.phase = 'night';
  s.nightActions = { wolfTargetVotes: {}, seerCheck: null };
  s.deadline = Date.now() + 40_000;
  return s;
}

// ── Seer ──

test('the seer can only check one person per night', () => {
  const s = nightState(12);
  const seer = roleOf(s, 'seer')[0];
  const others = Object.keys(s.roles).filter((id) => id !== seer);

  const first = ww.applyAction(s, { type: 'seer_check', target: others[0] }, seer);
  assert.ok(!first.error, 'the first check should succeed');

  const second = ww.applyAction(s, { type: 'seer_check', target: others[1] }, seer);
  assert.ok(second.error, 'a second check on the same night must be rejected -- otherwise the seer could check the whole table in one night');

  assert.strictEqual(
    Object.keys(s.seerResults[seer]).length, 1,
    'after one night the accumulated check results should hold only 1 entry'
  );
});

test('the seer can keep checking across nights (once per night)', () => {
  const s = nightState(8);
  const seer = roleOf(s, 'seer')[0];
  const others = Object.keys(s.roles).filter((id) => id !== seer);

  ww.applyAction(s, { type: 'seer_check', target: others[0] }, seer);
  s.nightActions = { wolfTargetVotes: {}, seerCheck: null };   // simulate entering the next night
  const next = ww.applyAction(s, { type: 'seer_check', target: others[1] }, seer);

  assert.ok(!next.error, 'a new night should allow another check');
  assert.strictEqual(Object.keys(s.seerResults[seer]).length, 2, 'two nights should accumulate 2 results');
});

test('the seer cannot check themselves', () => {
  const s = nightState(6);
  const seer = roleOf(s, 'seer')[0];
  assert.ok(ww.applyAction(s, { type: 'seer_check', target: seer }, seer).error);
});

test('check results are visible only to the seer themselves, and their content is correct', () => {
  const s = nightState(8);
  const seer = roleOf(s, 'seer')[0];
  const wolf = roleOf(s, 'wolf')[0];
  ww.applyAction(s, { type: 'seer_check', target: wolf }, seer);

  assert.strictEqual(ww.serializeStateFor(s, seer).seerResults[wolf], 'wolf', 'checking a wolf should return wolf');

  for (const p of s.players) {
    if (p.id === seer) continue;
    assert.strictEqual(
      ww.serializeStateFor(s, p.id).seerResults, undefined,
      'seerResults should not appear in a non-seer view'
    );
  }
});

// ── Wolves ──

test('a wolf changing their kill target overwrites, it does not append (one wolf, one vote)', () => {
  const s = nightState(12);
  const wolf = roleOf(s, 'wolf')[0];
  const goods = Object.keys(s.roles).filter((id) => s.roles[id] !== 'wolf');

  ww.applyAction(s, { type: 'wolf_kill', target: goods[0] }, wolf);
  ww.applyAction(s, { type: 'wolf_kill', target: goods[1] }, wolf);

  assert.strictEqual(s.nightActions.wolfTargetVotes[wolf], goods[1], 'the last change of target should be the one recorded');
  assert.strictEqual(
    Object.keys(s.nightActions.wolfTargetVotes).length, 1,
    'a single wolf only holds one vote no matter how many times they vote'
  );
});

test('non-wolves cannot kill and non-seers cannot check', () => {
  const s = nightState(8);
  const villager = roleOf(s, 'villager')[0];
  const target = roleOf(s, 'wolf')[0];
  assert.ok(ww.applyAction(s, { type: 'wolf_kill', target }, villager).error);
  assert.ok(ww.applyAction(s, { type: 'seer_check', target }, villager).error);
});

test('night actions cannot be initiated during the day', () => {
  const s = nightState(8);
  s.phase = 'day';
  const wolf = roleOf(s, 'wolf')[0];
  const seer = roleOf(s, 'seer')[0];
  const t = roleOf(s, 'villager')[0];
  assert.ok(ww.applyAction(s, { type: 'wolf_kill', target: t }, wolf).error);
  assert.ok(ww.applyAction(s, { type: 'seer_check', target: t }, seer).error);
});

// ── Voting ──

test('dead players cannot vote', () => {
  const s = ww.createInitialState(P(6), {});
  s.phase = 'day'; s.votes = {}; s.deadline = Date.now() + 60_000;
  const dead = s.players[0].id;
  s.alive[dead] = false;
  assert.ok(ww.applyAction(s, { type: 'vote', target: s.players[1].id }, dead).error);
});

test('PK candidates do not take part in the PK vote, and only candidates can be voted for', () => {
  const s = ww.createInitialState(P(6), {});
  const ids = s.players.map((p) => p.id);
  s.phase = 'pk'; s.votes = {}; s.pkCandidates = [ids[0], ids[1]];
  s.deadline = Date.now() + 30_000;

  assert.ok(ww.applyAction(s, { type: 'vote', target: ids[1] }, ids[0]).error, 'a candidate should not be able to vote');
  assert.ok(
    ww.applyAction(s, { type: 'pk_vote', target: ids[3] }, ids[2]).error,
    'it should not be possible to vote for a non-candidate'
  );
  assert.ok(!ww.applyAction(s, { type: 'pk_vote', target: ids[0] }, ids[2]).error);
});

// ── Win conditions ──

test('killing the only god does not end the game immediately', () => {
  // The god-side wipe is only a meaningful win condition when there are enough gods. The current setup has just 1 god (the seer),
  // so keeping the god-side wipe would amount to "kill one specific person on the first night and win": measured with wolves killing blind,
  // 20% of 6-player games and 17% of 8-player games end before the first day even begins, with nobody else having said a word.
  for (const n of [6, 8, 10, 12]) {
    const s = nightState(n);
    const seer = roleOf(s, 'seer')[0];
    s.alive[seer] = false;
    s.deadline = Date.now() - 1;
    ww.applyAction(s, { type: 'tick' }, null);

    assert.notStrictEqual(s.phase, 'ended', `${n}-player game: killing the seer should not end it immediately`);
  }
});

test('wolves >= good players → wolves win (the outcome is settled, no need to go through the motions)', () => {
  const s = nightState(8);
  const wolves = roleOf(s, 'wolf');
  const goods = s.players.map((p) => p.id).filter((id) => !wolves.includes(id));
  // Leave only (number of wolves) good players -- the wolves can force-vote anybody out
  goods.slice(wolves.length).forEach((id) => { s.alive[id] = false; });

  // Trigger it from the daytime resolution. The night would pass through the witch phase first, which is a different path; here we only care about the win check.
  s.phase = 'day'; s.votes = {}; s.deadline = Date.now() - 1;
  ww.applyAction(s, { type: 'tick' }, null);
  assert.strictEqual(s.phase, 'ended');
  assert.strictEqual(s.winner, 'wolf');
});

test('all villagers wiped out → wolves win (the villager-side wipe still applies)', () => {
  const s = nightState(12);
  roleOf(s, 'villager').forEach((id) => { s.alive[id] = false; });
  s.phase = 'day'; s.votes = {}; s.deadline = Date.now() - 1;
  ww.applyAction(s, { type: 'tick' }, null);
  assert.strictEqual(s.winner, 'wolf', 'the villager-side wipe is unaffected by this change');
});

test('all wolves eliminated → the good side wins', () => {
  const s = nightState(6);
  roleOf(s, 'wolf').forEach((id) => { s.alive[id] = false; });
  s.deadline = Date.now() - 1;
  ww.applyAction(s, { type: 'tick' }, null);
  assert.strictEqual(s.phase, 'ended');
  assert.strictEqual(s.winner, 'good');
});

test('a disconnect is not a loss: the good side does not win automatically when the only wolf disconnects', () => {
  const s = nightState(6);
  const wolf = roleOf(s, 'wolf')[0];
  ww.removePlayer(s, wolf);
  assert.notStrictEqual(s.phase, 'ended', 'a mere disconnect should not end the game');
  assert.strictEqual(s.alive[wolf], true, 'a disconnect is not an elimination');
});

test('really eliminated after the grace period: the only wolf leaves → the good side wins', () => {
  const s = nightState(6);
  const wolf = roleOf(s, 'wolf')[0];
  ww.eliminatePlayer(s, wolf);
  assert.strictEqual(s.phase, 'ended', 'the win conditions must be re-run after a real elimination, otherwise the good side could never win');
  assert.strictEqual(s.winner, 'good');
});

// ── How much the night result gives away ──

test('roles are never sent out during a game -- a dead player\'s role must not leak with the night result', () => {
  // The frontend's death animation shows the dead player's card. It must only show the role under the spectator god view,
  // but this server layer has to hold the line as well: roles should never appear in any player's view during a game.
  const s = speechPhase();
  for (const p of s.players) {
    assert.strictEqual(
      ww.serializeStateFor(s, p.id).roles, undefined,
      `${p.id} received roles during a game`
    );
  }
});

test('"saved by the witch" and "the wolves made no kill" must look exactly the same in a player view', () => {
  // Being able to tell them apart would reveal whether the witch used her healing potion tonight, and the healing potion's value would drop to zero.
  // That is also why the frontend's peaceful-night animation can only say "nobody's card was turned over", never "somebody was saved".
  const mk = (useHeal) => {
    const s = ww.createInitialState(P(8), {});
    ww.applyAction(s, { type: 'start' }, s.hostId);
    s.players.forEach((p) => ww.applyAction(s, { type: 'ready' }, p.id));
    const victim = s.players.map((p) => p.id).find((id) => s.roles[id] === 'villager' && s.alive[id]);
    roleOf(s, 'wolf').forEach((w) => ww.applyAction(s, { type: 'wolf_kill', target: victim }, w));
    const seer = roleOf(s, 'seer')[0];
    if (s.phase === 'night' && seer) {
      ww.applyAction(s, { type: 'seer_check', target: s.players.find((p) => p.id !== seer).id }, seer);
    }
    // useHeal: save the kill target → nobody dies; otherwise the equivalent situation of the wolves making no kill (also nobody dies)
    ww.applyAction(s, useHeal ? { type: 'witch', heal: true } : { type: 'witch' }, roleOf(s, 'witch')[0]);
    return { s, victim };
  };

  const saved = mk(true);
  assert.strictEqual(saved.s.alive[saved.victim], true, 'precondition: the healing potion should save the kill target');

  // Find an observer who is neither the witch nor the kill target
  const observer = saved.s.players
    .map((p) => p.id)
    .find((id) => saved.s.roles[id] !== 'witch' && id !== saved.victim);
  const view = ww.serializeStateFor(saved.s, observer);

  assert.strictEqual(view.lastNightVictim, null, 'when someone is saved, the outside world just sees "nobody died"');
  assert.strictEqual(view.potions, undefined, 'the remaining potions can only go to the witch herself');
  assert.strictEqual(view.witchVictim, undefined, 'the kill target can only go to the witch herself');
});

test('night deaths carry no cause of death -- the good side cannot tell who was killed by wolves and who was poisoned', () => {
  // This is why the frontend's dawn announcement must use the same animation for every dead player. Giving the poisoned card its own green treatment
  // would reveal whether the witch used her poison and on whom, and the poison would lose its deterrent effect.
  const s = ww.createInitialState(P(8), {});
  ww.applyAction(s, { type: 'start' }, s.hostId);
  s.players.forEach((p) => ww.applyAction(s, { type: 'ready' }, p.id));
  const victim = s.players.map((p) => p.id).find((id) => s.roles[id] === 'villager' && s.alive[id]);
  roleOf(s, 'wolf').forEach((w) => ww.applyAction(s, { type: 'wolf_kill', target: victim }, w));
  const seer = roleOf(s, 'seer')[0];
  if (s.phase === 'night' && seer) {
    ww.applyAction(s, { type: 'seer_check', target: s.players.find((p) => p.id !== seer).id }, seer);
  }
  const witch = roleOf(s, 'witch')[0];
  const poisonTarget = s.players.map((p) => p.id)
    .find((id) => s.alive[id] && id !== witch && id !== victim);
  ww.applyAction(s, { type: 'witch', poison: poisonTarget }, witch);

  const observer = s.players.map((p) => p.id)
    .find((id) => s.alive[id] && s.roles[id] !== 'witch');
  const view = ww.serializeStateFor(s, observer);

  assert.strictEqual(view.lastNightVictim.length, 2, 'a kill + a poisoning should leave two dead');
  // The death list must be a plain list of ids, with no cause/type or similar cause-of-death annotation
  for (const entry of view.lastNightVictim) {
    assert.strictEqual(typeof entry, 'string', 'a death entry should be a plain id, with no cause of death attached');
  }
});

// ── Host config (phase durations) ──

test('the phase durations set by the host really take effect', () => {
  const s = ww.createInitialState(P(8), { nightSeconds: 30, speechSeconds: 20, daySeconds: 30 });
  assert.strictEqual(s.cfg.nightSeconds, 30);
  assert.strictEqual(s.cfg.speechSeconds, 20);

  ww.applyAction(s, { type: 'start' }, s.hostId);
  s.players.forEach((p) => ww.applyAction(s, { type: 'ready' }, p.id));
  const left = Math.round((s.deadline - Date.now()) / 1000);
  assert.ok(Math.abs(left - 30) <= 1, `the night countdown should use the configured value, actual ${left}s`);
});

test('forged illegal durations fall back to the defaults', () => {
  // The client can forge any config it likes. 0 seconds would make a phase get skipped instantly and a huge value would freeze the whole game,
  // so the values have to be validated against a whitelist on the server and cannot rely on frontend restrictions alone.
  for (const bad of [
    { speechSeconds: 0 }, { speechSeconds: 99999 }, { daySeconds: 'abc' },
    { nightSeconds: -5 }, { pkSeconds: null }, { witchSeconds: 1e9 },
  ]) {
    const key = Object.keys(bad)[0];
    const s = ww.createInitialState(P(8), bad);
    const opts = ww.configSchema[key].options;
    assert.ok(opts.includes(s.cfg[key]), `${key}=${JSON.stringify(bad[key])} should fall back to a value within the whitelist`);
  }
});

test('every item of configSchema can be rendered by the generic panel', () => {
  // The frontend only recognizes toggle / options; an item with a missing type silently fails to show up and the host cannot change it at all
  for (const [key, item] of Object.entries(ww.configSchema)) {
    assert.ok(['toggle', 'options'].includes(item.type), `the type of ${key} cannot be rendered`);
    assert.ok(item.label, `${key} is missing label`);
    assert.notStrictEqual(item.default, undefined, `${key} is missing default`);
    if (item.type === 'options') {
      assert.ok(Array.isArray(item.options) && item.options.length, `${key} is missing options`);
      assert.ok(item.options.includes(item.default), `the default of ${key} is not in options`);
    }
  }
});

// ── Taking turns to speak ──

// Run the game up to the daytime speech phase
function speechPhase(n = 8) {
  const s = ww.createInitialState(P(n), {});
  ww.applyAction(s, { type: 'start' }, s.hostId);
  s.players.forEach((p) => ww.applyAction(s, { type: 'ready' }, p.id));
  const victim = s.players.map((p) => p.id).find((id) => s.roles[id] === 'villager' && s.alive[id]);
  roleOf(s, 'wolf').forEach((w) => ww.applyAction(s, { type: 'wolf_kill', target: victim }, w));
  const seer = roleOf(s, 'seer')[0];
  if (s.phase === 'night' && seer) {
    ww.applyAction(s, { type: 'seer_check', target: s.players.find((p) => p.id !== seer).id }, seer);
  }
  if (s.phase === 'witch') ww.applyAction(s, { type: 'witch' }, roleOf(s, 'witch')[0]);
  return s;
}

test('after the night ends the game enters the speech phase, and the dead are not in the speaking queue', () => {
  const s = speechPhase();
  assert.strictEqual(s.phase, 'speech', 'at dawn players should take turns speaking first, rather than voting straight away');
  assert.ok(s.speechOrder.length > 0);
  assert.ok(s.speechOrder.every((id) => s.alive[id]), 'the dead should not appear in the speaking queue');
});

test('during the speech phase only the current speaker can talk', () => {
  // This is the core of the whole mechanic: if interrupting were allowed, a wolf spamming could bury the seer's report.
  const s = speechPhase();
  const cur = s.speechOrder[s.speechIndex];
  const other = s.speechOrder.find((id) => id !== cur);

  assert.ok(!ww.applyAction(s, { type: 'chat', text: 'I am the seer' }, cur).error, 'the current speaker should be able to talk');
  assert.ok(ww.applyAction(s, { type: 'chat', text: 'spam' }, other).error, 'nobody else should be able to interrupt');
});

test('passing the mic moves to the next player, and nobody can pass on your behalf', () => {
  const s = speechPhase();
  const cur = s.speechOrder[s.speechIndex];
  const other = s.speechOrder.find((id) => id !== cur);

  assert.ok(ww.applyAction(s, { type: 'pass_speech' }, other).error, 'you cannot pass the mic on somebody else\'s behalf');
  ww.applyAction(s, { type: 'pass_speech' }, cur);
  assert.strictEqual(s.speechOrder[s.speechIndex], s.speechOrder[1], 'passing the mic should move on to the next player');
});

test('a speech timing out automatically moves to the next player', () => {
  const s = speechPhase();
  const before = s.speechIndex;
  s.deadline = Date.now() - 1;
  ww.applyAction(s, { type: 'tick' }, null);
  assert.strictEqual(s.speechIndex, before + 1, 'a timeout should switch players, it must not get stuck');
});

test('all speeches finished → move to the vote, where discussion is free', () => {
  const s = speechPhase();
  let guard = 0;
  while (s.phase === 'speech' && guard++ < 30) {
    ww.applyAction(s, { type: 'pass_speech' }, s.speechOrder[s.speechIndex]);
  }
  assert.strictEqual(s.phase, 'day', 'once everyone has spoken it should move to the voting phase');

  const alive = s.players.map((p) => p.id).find((id) => s.alive[id]);
  assert.ok(!ww.applyAction(s, { type: 'chat', text: 'a couple more words before we vote' }, alive).error,
    'the voting phase should restore free discussion');
});

test('a speaker disconnecting does not stall the whole table', () => {
  const s = speechPhase();
  const cur = s.speechOrder[s.speechIndex];
  ww.removePlayer(s, cur);
  assert.notStrictEqual(s.speechOrder[s.speechIndex], cur, 'a speaker disconnecting should immediately move to the next player');
});

test('the dead channel is not bound by the speaking order', () => {
  // Dead players chatting on the side does not affect the speeches in play, so they should not be blocked by "it is not your turn yet"
  const s = speechPhase();
  const dead = s.players.map((p) => p.id).find((id) => !s.alive[id]);
  const r = ww.applyAction(s, { type: 'chat', text: 'dead player heckling from the sidelines' }, dead);
  assert.ok(!r.error, 'dead players can talk in the dead channel at any time');
  assert.strictEqual(r.events[0].channel, 'dead');
});

// ── Witch ──

// Build a state where "the wolf kill is settled and it is the witch's turn"
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

test('the witch can see tonight\'s kill target, nobody else can', () => {
  const { s, witch, victim } = witchTurn();
  assert.strictEqual(s.phase, 'witch', 'after the wolf kill is resolved the game should enter the witch phase');
  assert.strictEqual(ww.serializeStateFor(s, witch).witchVictim, victim);

  for (const p of s.players) {
    if (p.id === witch) continue;
    assert.strictEqual(
      ww.serializeStateFor(s, p.id).witchVictim, undefined,
      'the kill target can only be sent to the witch -- sending it to anybody else would reveal who dies tonight'
    );
  }
});

test('the healing potion saves the kill target, the poison kills its target, and each is consumed', () => {
  let { s, witch, victim } = witchTurn();
  ww.applyAction(s, { type: 'witch', heal: true }, witch);
  assert.strictEqual(s.alive[victim], true, 'the person who was saved should be alive');
  assert.strictEqual(s.potions.heal, false, 'the healing potion should be consumed');

  ({ s, witch, victim } = witchTurn());
  const target = s.players.map((p) => p.id).find((id) => id !== witch && id !== victim && s.alive[id]);
  ww.applyAction(s, { type: 'witch', poison: target }, witch);
  assert.strictEqual(s.alive[victim], false, 'without a save they should die');
  assert.strictEqual(s.alive[target], false, 'the poisoned player should be eliminated');
  assert.strictEqual(s.potions.poison, false, 'the poison should be consumed');
});

test('you cannot both save and poison on the same night; a used-up potion cannot be used again', () => {
  let { s, witch, victim } = witchTurn();
  const other = s.players.map((p) => p.id).find((id) => id !== witch && id !== victim && s.alive[id]);
  assert.ok(ww.applyAction(s, { type: 'witch', heal: true, poison: other }, witch).error);

  ({ s, witch } = witchTurn());
  s.potions.heal = false;
  assert.ok(ww.applyAction(s, { type: 'witch', heal: true }, witch).error, 'once the healing potion is used up it cannot save again');
});

test('self-healing is allowed on the first night but not afterwards', () => {
  // First night: the wolves kill the witch, and she can save herself
  const s1 = ww.createInitialState(P(8), {});
  ww.applyAction(s1, { type: 'start' }, s1.hostId);
  s1.players.forEach((p) => ww.applyAction(s1, { type: 'ready' }, p.id));
  const w1 = roleOf(s1, 'witch')[0];
  roleOf(s1, 'wolf').forEach((w) => ww.applyAction(s1, { type: 'wolf_kill', target: w1 }, w));
  const se1 = roleOf(s1, 'seer')[0];
  if (s1.phase === 'night' && se1) {
    ww.applyAction(s1, { type: 'seer_check', target: s1.players.find((p) => p.id !== se1).id }, se1);
  }
  assert.ok(!ww.applyAction(s1, { type: 'witch', heal: true }, w1).error, 'self-healing should be possible on the first night');

  // Not from the second night onwards
  const { s, witch } = witchTurn();
  s.round = 2;
  s.nightActions.victim = witch;
  assert.ok(ww.applyAction(s, { type: 'witch', heal: true }, witch).error, 'self-healing is not allowed after the first night');
});

test('non-witches cannot use potions; a witch disconnecting does not stall the whole table', () => {
  const { s, witch, victim } = witchTurn();
  const other = s.players.map((p) => p.id).find((id) => id !== witch && s.alive[id]);
  assert.ok(ww.applyAction(s, { type: 'witch', heal: true }, other).error);

  ww.removePlayer(s, witch);
  assert.notStrictEqual(s.phase, 'witch', 'a witch disconnecting should count as a skip, otherwise everyone sits around until the timeout');
  assert.strictEqual(s.alive[victim], false, 'after the skip it resolves with the original kill target');
});

// ── Hunter ──

test('a hunter killed by wolves can shoot and take one person with him, then the day begins', () => {
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

  assert.strictEqual(s.phase, 'hunter', 'the hunter being eliminated should enter the shooting phase');
  assert.strictEqual(s.pendingHunter, hunter);

  const target = s.players.map((p) => p.id).find((id) => s.alive[id]);
  ww.applyAction(s, { type: 'hunter_shoot', target }, hunter);
  assert.strictEqual(s.alive[target], false, 'the person who was shot should be eliminated');
  assert.ok(s.phase !== 'hunter', 'after the shot the game should leave that phase');
});

test('a hunter poisoned to death cannot shoot', () => {
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

  assert.strictEqual(s.alive[hunter], false, 'the hunter should be poisoned to death');
  assert.notStrictEqual(s.phase, 'hunter', 'a hunter poisoned to death cannot shoot');
  assert.strictEqual(s.pendingHunter, null);
});

test('a hunter voted out shoots, and then the night begins', () => {
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
  assert.strictEqual(s.phase, 'night', 'a hunter voted out during the day should move to the night once his shot is done');
});

test('who the hunter is aiming at is not leaked before the shot', () => {
  // The aiming has to exist only inside the hunter's own browser. If the intermediate state were sent up in order to build an "aiming animation",
  // the person being aimed at could get their defense in first, before the trigger is pulled, and the hunter's gun would be worthless.
  // So before the shot the server should hold no field pointing at a target, and the log should hold no record of it either.
  const s = ww.createInitialState(P(12), {});
  ww.applyAction(s, { type: 'start' }, s.hostId);
  s.players.forEach((p) => ww.applyAction(s, { type: 'ready' }, p.id));
  const hunter = roleOf(s, 'hunter')[0];
  s.phase = 'hunter'; s.pendingHunter = hunter; s.resumeTo = 'day';

  const observer = s.players.map((p) => p.id).find((id) => id !== hunter && s.alive[id]);
  const view = ww.serializeStateFor(s, observer);

  assert.ok(
    !(view.log || []).some((e) => e.type === 'hunter_shot'),
    'the shot has not happened yet, so the log should hold no shot record'
  );
  // pendingHunter is public (everybody knows it is the hunter's turn), but there must be no "target"
  assert.strictEqual(view.hunterTarget, undefined);
  assert.strictEqual(view.aimingAt, undefined);
});

test('after the shot the result is public to everyone (the animation plays from it)', () => {
  const s = ww.createInitialState(P(12), {});
  ww.applyAction(s, { type: 'start' }, s.hostId);
  s.players.forEach((p) => ww.applyAction(s, { type: 'ready' }, p.id));
  const hunter = roleOf(s, 'hunter')[0];
  s.phase = 'hunter'; s.pendingHunter = hunter; s.resumeTo = 'day';
  s.deadline = Date.now() + 20_000;

  const target = s.players.map((p) => p.id).find((id) => id !== hunter && s.alive[id]);
  ww.applyAction(s, { type: 'hunter_shoot', target }, hunter);

  const observer = s.players.map((p) => p.id).find((id) => s.alive[id]);
  const shot = (ww.serializeStateFor(s, observer).log || [])
    .filter((e) => e.type === 'hunter_shot').pop();
  assert.strictEqual(shot?.target, target, 'the result of the shot should be written into the public log');
  assert.strictEqual(s.alive[target], false);
});

test('non-hunters cannot shoot; a timeout counts as declining', () => {
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
  assert.notStrictEqual(s.phase, 'hunter', 'a timeout should automatically leave the shooting phase');
});

// ── Number of gods and the god-side wipe ──

test('gods come into play progressively with the player count', () => {
  const gods = (n) => {
    const s = ww.createInitialState(P(n), {});
    return Object.values(s.roles).filter((r) => ['seer', 'witch', 'hunter'].includes(r)).length;
  };
  assert.strictEqual(gods(6), 1, 'a small game has only the seer');
  assert.strictEqual(gods(8), 2, 'a medium game adds the witch');
  assert.strictEqual(gods(12), 3, 'a large game adds the hunter');

  // At most 1 of each kind of god
  const s = ww.createInitialState(P(12), {});
  for (const r of ['seer', 'witch', 'hunter']) {
    assert.strictEqual(roleOf(s, r).length, 1, `there should be only 1 ${r}`);
  }
});

test('the god-side wipe takes effect again once there are >= 2 gods', () => {
  const s = nightState(8);
  roleOf(s, 'seer').concat(roleOf(s, 'witch')).forEach((id) => { s.alive[id] = false; });
  s.deadline = Date.now() - 1;
  ww.applyAction(s, { type: 'tick' }, null);
  assert.strictEqual(s.winner, 'wolf', 'with 2 gods, wiping out all of them should count as a wolf win');
});

// ── Chat channels (the dead channel must not be visible to living players, routed by the channel marker) ──

test('dead players\' messages go to the dead channel, living players\' messages go to the alive channel', () => {
  const s = ww.createInitialState(P(6), {});
  s.phase = 'day'; s.votes = {}; s.deadline = Date.now() + 60_000;
  const [a, b] = s.players.map((p) => p.id);
  s.alive[b] = false;

  const aliveEv = ww.applyAction(s, { type: 'chat', text: 'I am the seer' }, a).events[0];
  assert.strictEqual(aliveEv.channel, 'alive');

  const deadEv = ww.applyAction(s, { type: 'chat', text: 'he is a wolf' }, b).events[0];
  assert.strictEqual(deadEv.channel, 'dead', 'a dead player\'s message must be marked dead, otherwise it spoils the game for living players');
});

test('living players cannot speak publicly at night', () => {
  const s = nightState(6);
  assert.ok(ww.applyAction(s, { type: 'chat', text: 'talking after dark' }, s.players[0].id).error);
});

test('spectators cannot act -- above all they cannot chat', () => {
  // A spectator is not in the alive table, so the chat branch would treat them as a dead player and route them into the dead channel.
  // A spectator with the host's god view turned on can see every role, which would mean they could broadcast the whole table's roles to all the dead players.
  const s = nightState(6);
  s.phase = 'day'; s.votes = {}; s.deadline = Date.now() + 60_000;

  assert.ok(ww.applyAction(s, { type: 'chat', text: 'the wolf is p3' }, '__spectator__').error);
  assert.ok(ww.applyAction(s, { type: 'vote', target: s.players[0].id }, '__spectator__').error);

  s.phase = 'night';
  assert.ok(ww.applyAction(s, { type: 'wolf_kill', target: s.players[0].id }, '__spectator__').error);
});

test('tick is not subject to the "must be a player in this game" restriction (server-driven, with no actor)', () => {
  const s = nightState(6);
  assert.ok(!ww.applyAction(s, { type: 'tick' }, null).error, 'tick has a playerId of null, so it must be let through');
});
