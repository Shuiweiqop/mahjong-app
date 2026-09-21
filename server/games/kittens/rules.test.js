// Exploding Kittens rule tests.
//
// The hidden information in this game differs from the other two in being dynamic: the
// deck order gets peeked at by See the Future, scrambled by Shuffle, and written back into
// by whoever defuses a bomb. That is a far wider leak surface than a role or a word, which
// is where these tests concentrate.
//
//   cd server && npm test

const { test } = require('node:test');
const assert = require('node:assert');

const k = require('./index');
const { CARD } = require('./cards');

const P = (n) => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i }));

function started(n = 4, cfg = {}) {
  const s = k.createInitialState(P(n), cfg);
  k.applyAction(s, { type: 'start' }, s.hostId);
  return s;
}
const cur = (s) => s.order[s.turnIndex];

// ── Dealing and the deck ──

test('there is exactly one bomb fewer than players, guaranteeing a sole survivor', () => {
  for (const n of [2, 3, 5, 8]) {
    const s = started(n);
    const bombs = s.deck.filter((c) => c === CARD.BOMB).length;
    assert.strictEqual(bombs, n - 1, `a ${n}-player game should hold ${n - 1} bombs`);
  }
});

test('everyone starts with 1 Defuse plus 7 ordinary cards, and no bomb in hand', () => {
  const s = started(4);
  for (const id of s.order) {
    const hand = s.hands[id];
    assert.strictEqual(hand.length, 8);
    assert.strictEqual(hand.filter((c) => c === CARD.DEFUSE).length, 1);
    assert.ok(!hand.includes(CARD.BOMB), 'a starting hand must never contain a bomb');
  }
});

// ── Information hiding (the most important part of this module) ──

test('a view never contains the deck order, nor anyone elses hand', () => {
  const s = started(4);
  const view = k.serializeStateFor(s, s.order[0]);
  assert.strictEqual(view.deck, undefined, 'leaking deck = everyone knows where the bombs are');
  assert.strictEqual(view.hands, undefined, 'leaking hands = every hand is public');
  assert.strictEqual(typeof view.deckCount, 'number', 'only the remaining count should be sent');
});

test('you see only your own hand; for others, only a count', () => {
  const s = started(4);
  const me = s.order[0];
  const view = k.serializeStateFor(s, me);
  assert.deepStrictEqual(view.myHand, s.hands[me]);
  for (const p of view.players) {
    assert.strictEqual(typeof p.handCount, 'number');
    assert.strictEqual(p.hand, undefined, 'the contents of another hand must not appear in the view');
  }
});

test('the three See the Future cards go only to the player who played it', () => {
  const s = started(4);
  const me = cur(s);
  s.hands[me] = [CARD.FUTURE, CARD.DEFUSE];
  k.applyAction(s, { type: 'play', cards: [CARD.FUTURE] }, me);
  s.deadline = Date.now() - 1;
  k.applyAction(s, { type: 'tick' }, null);   // close the nope window so it resolves

  assert.strictEqual(k.serializeStateFor(s, me).myFuture?.length, 3, 'the player who used it should see three cards');
  for (const other of s.order.filter((id) => id !== me)) {
    assert.strictEqual(k.serializeStateFor(s, other).myFuture, undefined,
      'nobody else may ever see the top of the deck');
  }
});

test('where the defuser puts the bomb back is not leaked to anyone else', () => {
  const s = started(4);
  const me = cur(s);
  s.hands[me] = [CARD.DEFUSE];
  s.deck = [CARD.SKIP, CARD.SKIP, CARD.BOMB];   // the end of the array is the top of the deck
  k.applyAction(s, { type: 'draw' }, me);
  assert.strictEqual(s.phase, 'defusing');

  const other = s.order.find((id) => id !== me);
  const view = k.serializeStateFor(s, other);
  assert.strictEqual(view.iAmDefusing, false);
  assert.strictEqual(view.deckSize, undefined, 'only the defuser needs the deck length, in order to choose a position');
  assert.strictEqual(view.deck, undefined);

  k.applyAction(s, { type: 'place_bomb', position: 0 }, me);
  const after = k.serializeStateFor(s, other);
  assert.strictEqual(after.deck, undefined, 'after it is placed, the position must leak even less');
});

// ── Bombs and defusing ──

test('drawing a bomb without a Defuse knocks you out', () => {
  const s = started(3);
  const me = cur(s);
  s.hands[me] = [CARD.SKIP];          // no Defuse
  s.deck = [CARD.BOMB];
  k.applyAction(s, { type: 'draw' }, me);
  assert.strictEqual(s.alive[me], false, 'should be out');
});

test('drawing a bomb with a Defuse keeps you in and moves to the placement phase', () => {
  const s = started(3);
  const me = cur(s);
  s.hands[me] = [CARD.DEFUSE];
  s.deck = [CARD.SKIP, CARD.BOMB];
  k.applyAction(s, { type: 'draw' }, me);
  assert.strictEqual(s.alive[me], true, 'holding a Defuse should keep you in');
  assert.strictEqual(s.phase, 'defusing');
  assert.ok(!s.hands[me].includes(CARD.DEFUSE), 'the Defuse should be consumed');
});

test('the chosen bomb position actually takes effect', () => {
  const s = started(3);
  const me = cur(s);
  s.hands[me] = [CARD.DEFUSE];
  s.deck = [CARD.SKIP, CARD.SKIP, CARD.BOMB];
  k.applyAction(s, { type: 'draw' }, me);
  k.applyAction(s, { type: 'place_bomb', position: 0 }, me);
  assert.strictEqual(s.deck[s.deck.length - 1], CARD.BOMB, 'position 0 = top of the deck, so the next player draws it immediately');
});

test('only the defuser themselves can place the bomb', () => {
  const s = started(3);
  const me = cur(s);
  s.hands[me] = [CARD.DEFUSE];
  s.deck = [CARD.SKIP, CARD.BOMB];
  k.applyAction(s, { type: 'draw' }, me);
  const other = s.order.find((id) => id !== me);
  assert.ok(k.applyAction(s, { type: 'place_bomb', position: 0 }, other).error);
});

// ── The nope window (the trickiest mechanic in this game) ──

test('an action card enters the nope window first and does not resolve immediately', () => {
  const s = started(4);
  const me = cur(s);
  s.hands[me] = [CARD.SKIP, CARD.DEFUSE];
  k.applyAction(s, { type: 'play', cards: [CARD.SKIP] }, me);
  assert.strictEqual(s.phase, 'nope');
  assert.strictEqual(s.pending.card, CARD.SKIP);
  assert.strictEqual(cur(s), me, 'the turn has not moved on while the window is open');
});

test('a single nope voids the card, and the turn stays with whoever played it', () => {
  const s = started(4);
  const me = cur(s);
  s.hands[me] = [CARD.SKIP, CARD.DEFUSE];
  const other = s.order.find((id) => id !== me);
  s.hands[other] = [CARD.NOPE];

  k.applyAction(s, { type: 'play', cards: [CARD.SKIP] }, me);
  k.applyAction(s, { type: 'nope' }, other);
  s.deadline = Date.now() - 1;
  k.applyAction(s, { type: 'tick' }, null);

  assert.strictEqual(s.phase, 'playing');
  assert.strictEqual(cur(s), me, 'the Skip was noped, so the player who played it is still on their own turn');
});

test('a nope can itself be noped (an even number of them = it resolves)', () => {
  const s = started(4);
  const me = cur(s);
  s.hands[me] = [CARD.SKIP, CARD.DEFUSE];
  const [a, b] = s.order.filter((id) => id !== me);
  s.hands[a] = [CARD.NOPE];
  s.hands[b] = [CARD.NOPE];

  k.applyAction(s, { type: 'play', cards: [CARD.SKIP] }, me);
  k.applyAction(s, { type: 'nope' }, a);      // nope
  k.applyAction(s, { type: 'nope' }, b);      // counter-nope
  assert.strictEqual(s.pending.nopes.length, 2);
  s.deadline = Date.now() - 1;
  k.applyAction(s, { type: 'tick' }, null);

  assert.notStrictEqual(cur(s), me, 'the two nopes cancel out, the Skip resolves, and the turn moves on');
});

test('you cannot nope without a Nope card', () => {
  const s = started(4);
  const me = cur(s);
  s.hands[me] = [CARD.SKIP, CARD.DEFUSE];
  const other = s.order.find((id) => id !== me);
  s.hands[other] = [CARD.SKIP];               // no nope
  k.applyAction(s, { type: 'play', cards: [CARD.SKIP] }, me);
  assert.ok(k.applyAction(s, { type: 'nope' }, other).error);
});

// ── Turns and Attack ──

test('Attack makes the next player take two turns in a row', () => {
  const s = started(4);
  const me = cur(s);
  s.hands[me] = [CARD.ATTACK, CARD.DEFUSE];
  k.applyAction(s, { type: 'play', cards: [CARD.ATTACK] }, me);
  s.deadline = Date.now() - 1;
  k.applyAction(s, { type: 'tick' }, null);

  assert.notStrictEqual(cur(s), me, 'after an Attack it is the next players turn');
  assert.strictEqual(s.turnsLeft, 2, 'the next player owes two turns');
});

test('a player who is not the current one cannot play or draw', () => {
  const s = started(4);
  const other = s.order.find((id) => id !== cur(s));
  s.hands[other] = [CARD.SKIP];
  assert.ok(k.applyAction(s, { type: 'play', cards: [CARD.SKIP] }, other).error);
  assert.ok(k.applyAction(s, { type: 'draw' }, other).error);
});

test('spectators cannot act', () => {
  const s = started(4);
  assert.ok(k.applyAction(s, { type: 'draw' }, '__spectator__').error);
  assert.ok(k.applyAction(s, { type: 'nope' }, '__spectator__').error);
});

test('cat cards must be paired and need a target', () => {
  const s = started(4);
  const me = cur(s);
  s.hands[me] = [CARD.CAT_TACO, CARD.CAT_TACO, CARD.DEFUSE];
  assert.ok(k.applyAction(s, { type: 'play', cards: [CARD.CAT_TACO] }, me).error,
    'a lone cat card cannot be played');
  assert.ok(k.applyAction(s, { type: 'play', cards: [CARD.CAT_TACO, CARD.CAT_TACO] }, me).error,
    'stealing a card requires a target');
});

// ── Three-of-a-kind and five-different cat combos ──

const settle = (s) => { s.deadline = Date.now() - 1; k.applyAction(s, { type: 'tick' }, null); };

test('three matching cats: name a card, and the target must hand it over if they hold it', () => {
  const s = started(4);
  const me = cur(s);
  const t = s.order.find((id) => id !== me);
  s.hands[me] = [CARD.CAT_TACO, CARD.CAT_TACO, CARD.CAT_TACO];
  s.hands[t] = [CARD.DEFUSE, CARD.SKIP];

  const r = k.applyAction(s,
    { type: 'play', cards: [CARD.CAT_TACO, CARD.CAT_TACO, CARD.CAT_TACO], target: t, wanted: CARD.DEFUSE }, me);
  assert.ok(!r.error, r.error);
  settle(s);

  assert.ok(s.hands[me].includes(CARD.DEFUSE), 'should receive the named card');
  assert.ok(!s.hands[t].includes(CARD.DEFUSE), 'the target should lose that card');
});

test('three matching cats: coming up empty is public, not hidden', () => {
  // Coming up empty is itself valuable public information (they have no Defuse), and that
  // probing value is the whole point of the three-card combo
  const s = started(4);
  const me = cur(s);
  const t = s.order.find((id) => id !== me);
  s.hands[me] = [CARD.CAT_MELON, CARD.CAT_MELON, CARD.CAT_MELON];
  s.hands[t] = [CARD.SKIP];

  k.applyAction(s,
    { type: 'play', cards: [CARD.CAT_MELON, CARD.CAT_MELON, CARD.CAT_MELON], target: t, wanted: CARD.DEFUSE }, me);
  settle(s);

  assert.strictEqual(s.lastAction.type, 'demand');
  assert.strictEqual(s.lastAction.success, false, 'coming up empty must be recorded faithfully');
  assert.ok(s.log.some((e) => e.type === 'demand' && e.success === false), 'coming up empty must go into the public log');
});

test('three cards must name a target card, and must all match', () => {
  const s = started(4);
  const me = cur(s);
  const t = s.order.find((id) => id !== me);
  s.hands[me] = [CARD.CAT_TACO, CARD.CAT_TACO, CARD.CAT_TACO];
  assert.ok(k.applyAction(s,
    { type: 'play', cards: [CARD.CAT_TACO, CARD.CAT_TACO, CARD.CAT_TACO], target: t }, me).error,
    'not naming a card should be rejected');

  s.hands[me] = [CARD.CAT_TACO, CARD.CAT_TACO, CARD.CAT_MELON];
  assert.ok(k.applyAction(s,
    { type: 'play', cards: [CARD.CAT_TACO, CARD.CAT_TACO, CARD.CAT_MELON], target: t, wanted: CARD.SKIP }, me).error,
    'three non-matching cats should be rejected');
});

test('five different cats: take the named card from the discard pile', () => {
  const s = started(4);
  const me = cur(s);
  const five = [CARD.CAT_TACO, CARD.CAT_MELON, CARD.CAT_BEARD, CARD.CAT_RAINBOW, CARD.CAT_POTATO];
  s.hands[me] = [...five];
  s.discard = [CARD.SKIP, CARD.DEFUSE, CARD.ATTACK];

  k.applyAction(s, { type: 'play', cards: five, wanted: CARD.DEFUSE }, me);
  settle(s);

  assert.ok(s.hands[me].includes(CARD.DEFUSE), 'should take the card from the discard pile');
  assert.ok(!s.discard.includes(CARD.DEFUSE), 'that card should be removed from the discard pile');
});

test('five cats cannot ask for a card the discard pile does not hold', () => {
  const s = started(4);
  const me = cur(s);
  const five = [CARD.CAT_TACO, CARD.CAT_MELON, CARD.CAT_BEARD, CARD.CAT_RAINBOW, CARD.CAT_POTATO];
  s.hands[me] = [...five];
  s.discard = [CARD.SKIP];
  assert.ok(k.applyAction(s, { type: 'play', cards: five, wanted: CARD.DEFUSE }, me).error);
});

test('three- and five-card combos also pass through the nope window', () => {
  const s = started(4);
  const me = cur(s);
  const t = s.order.find((id) => id !== me);
  s.hands[me] = [CARD.CAT_TACO, CARD.CAT_TACO, CARD.CAT_TACO];
  s.hands[t] = [CARD.NOPE, CARD.DEFUSE];

  k.applyAction(s,
    { type: 'play', cards: [CARD.CAT_TACO, CARD.CAT_TACO, CARD.CAT_TACO], target: t, wanted: CARD.DEFUSE }, me);
  assert.strictEqual(s.phase, 'nope', 'demanding a card can be noped too');
  k.applyAction(s, { type: 'nope' }, t);
  settle(s);
  assert.ok(s.hands[t].includes(CARD.DEFUSE), 'once noped, the target keeps their card');
});

// ── Favor (the target chooses which card to give) ──

test('Favor enters the favor phase, where the target picks the card themselves', () => {
  const s = started(4);
  const me = cur(s);
  const t = s.order.find((id) => id !== me);
  s.hands[me] = [CARD.FAVOR, CARD.DEFUSE];
  s.hands[t] = [CARD.SKIP, CARD.DEFUSE];

  k.applyAction(s, { type: 'play', cards: [CARD.FAVOR], target: t }, me);
  settle(s);
  assert.strictEqual(s.phase, 'favor', 'once Favor resolves it should wait for the target to choose');

  // The target hands over their least useful card, which is exactly the tension the
  // original game is built on
  k.applyAction(s, { type: 'give_card', card: CARD.SKIP }, t);
  assert.ok(s.hands[me].includes(CARD.SKIP), 'the asker should receive whichever card was given');
  assert.ok(s.hands[t].includes(CARD.DEFUSE), 'the target kept the card they wanted to keep');
  assert.strictEqual(s.phase, 'playing');
  assert.strictEqual(cur(s), me, 'Favor does not end the turn');
});

test('the asker cannot see the target hand, nor choose on their behalf', () => {
  // The whole give-away-your-worst-card tension depends on the asker not knowing what the
  // target is holding back
  const s = started(4);
  const me = cur(s);
  const t = s.order.find((id) => id !== me);
  // Use a sentinel value that could only have come from the target hand, so it cannot be
  // confused with our own hand, the discard pile, or the log
  const CANARY = '__only_in_target_hand__';
  s.hands[me] = [CARD.FAVOR];
  s.hands[t] = [CARD.SKIP, CANARY];
  s.discard = [];
  k.applyAction(s, { type: 'play', cards: [CARD.FAVOR], target: t }, me);
  settle(s);

  const view = k.serializeStateFor(s, me);
  assert.strictEqual(view.iAmGiving, false);
  assert.strictEqual(view.hands, undefined);

  // Scan the entire view, excluding our own hand. Checking only the field names we know
  // about is not enough: if someone later adds a targetHand field for the UI it would slip
  // straight through, and nothing would complain.
  const dump = JSON.stringify({ ...view, myHand: null });
  assert.ok(!dump.includes(CANARY),
    'nothing from the target hand should appear anywhere in the asker view');

  assert.ok(k.applyAction(s, { type: 'give_card', index: 0 }, me).error, 'you cannot pick the card on the target behalf');
});

test('a Favor that times out gives a random card rather than hanging', () => {
  const s = started(4);
  const me = cur(s);
  const t = s.order.find((id) => id !== me);
  s.hands[me] = [CARD.FAVOR];
  s.hands[t] = [CARD.SKIP];
  k.applyAction(s, { type: 'play', cards: [CARD.FAVOR], target: t }, me);
  settle(s);
  assert.strictEqual(s.phase, 'favor');

  settle(s);   // let the favor phase time out as well
  assert.strictEqual(s.phase, 'playing', 'a timeout should hand over a card automatically and carry on');
  assert.ok(s.hands[me].includes(CARD.SKIP));
});

test('Favor is skipped outright when the target has no cards', () => {
  const s = started(4);
  const me = cur(s);
  const t = s.order.find((id) => id !== me);
  s.hands[me] = [CARD.FAVOR];
  s.hands[t] = [];
  k.applyAction(s, { type: 'play', cards: [CARD.FAVOR], target: t }, me);
  settle(s);
  assert.strictEqual(s.phase, 'playing', 'with no card to give, it should never enter the waiting phase');
});

test('the discard pile is public (the five-card combo picks from it)', () => {
  const s = started(4);
  s.discard = [CARD.SKIP, CARD.ATTACK];
  const view = k.serializeStateFor(s, s.order[1]);
  assert.deepStrictEqual(view.discard, [CARD.SKIP, CARD.ATTACK], 'the discard pile is public table information');
});

// ── Winning and losing ──

test('the game ends with one player left, ranked by reverse elimination order', () => {
  const s = started(3);
  const a = s.order[0];
  s.hands[a] = []; s.deck = [CARD.BOMB];
  k.applyAction(s, { type: 'draw' }, a);      // a goes out first
  assert.strictEqual(s.alive[a], false);

  const nowCur = cur(s);
  s.hands[nowCur] = []; s.deck = [CARD.BOMB];
  k.applyAction(s, { type: 'draw' }, nowCur);

  assert.strictEqual(s.phase, 'ended');
  const over = k.isGameOver(s);
  assert.strictEqual(over.ranking.length, 3, 'everyone should have a rank');
  assert.strictEqual(over.ranking[over.ranking.length - 1].id, a, 'whoever went out first places last');
});
