// Draw & Guess rule tests -- focused on stroke limits, stroke validation, and view size.
//
// Breaking these constraints does not crash anything: the canvas simply grows, broadcasts
// get slower, and eventually a free-tier instance cannot keep up.
// Without tests nobody would notice, because two local tabs never fill a whole round.
//
//   cd server && npm test

const { test } = require('node:test');
const assert = require('node:assert');

const dg = require('./index');

const P = (n) => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i }));
const seg = () => ({
  from: [Math.random(), Math.random()], to: [Math.random(), Math.random()],
  color: '#000000', size: 4,
});

// Build a state that has already reached the drawing phase
function drawState(n = 4) {
  const s = dg.createInitialState(P(n), {});
  dg.applyAction(s, { type: 'start' }, s.hostId);
  if (s.phase === 'pick') dg.applyAction(s, { type: 'pick', word: s.wordChoices[0] }, s.drawerId);
  return s;
}
const guesserOf = (s) => s.players.find((p) => p.id !== s.drawerId).id;

// ── Stroke limits (stop the canvas growing without bound) ──

test('a round has a stroke cap, and the excess is dropped rather than erroring', () => {
  const s = drawState();
  for (let i = 0; i < 100; i++) {
    const r = dg.applyAction(s, { type: 'stroke', strokes: Array.from({ length: 500 }, seg) }, s.drawerId);
    assert.ok(!r.error, 'past the cap strokes should be dropped silently, never interrupting the drawer');
  }
  assert.ok(s.strokes.length <= 20000, `the stroke count should be capped, got ${s.strokes.length}`);
});

test('a single message has a stroke cap (blocks blowing up memory in one shot)', () => {
  const s = drawState();
  dg.applyAction(s, { type: 'stroke', strokes: Array.from({ length: 200000 }, seg) }, s.drawerId);
  assert.ok(s.strokes.length <= 500, `one message should not be able to push ${s.strokes.length} segments`);
});

test('malformed strokes are dropped and out-of-range values are clamped', () => {
  const s = drawState();
  dg.applyAction(s, { type: 'stroke', strokes: [
    { evil: '<script>' },                                             // no from/to -> dropped
    { from: [5, -3], to: [0.5, 0.5], color: 'javascript:x', size: 9999 }, // clamped + reset to the default colour
  ] }, s.drawerId);

  assert.strictEqual(s.strokes.length, 1, 'a malformed stroke should be dropped');
  const [k] = s.strokes;
  assert.deepStrictEqual(k.from, [1, 0], 'coordinates should be clamped back into 0..1');
  assert.strictEqual(k.color, '#000000', 'an invalid colour should fall back to the default');
  assert.ok(k.size <= 64, 'line width should be capped');
  assert.deepStrictEqual(Object.keys(k).sort(), ['color', 'from', 'size', 'to'], 'no extra fields should be kept');
});

test('a non-drawer cannot draw', () => {
  const s = drawState();
  assert.ok(dg.applyAction(s, { type: 'stroke', strokes: [seg()] }, guesserOf(s)).error);
});

// ── View size (the key point: a routine broadcast never carries the full canvas) ──

test('the routine view for a present player does not carry every stroke', () => {
  const s = drawState(8);
  for (let i = 0; i < 20; i++) {
    dg.applyAction(s, { type: 'stroke', strokes: Array.from({ length: 500 }, seg) }, s.drawerId);
  }
  assert.ok(s.strokes.length > 5000, 'precondition: the canvas should hold a lot of strokes');

  const view = dg.serializeStateFor(s, guesserOf(s));
  assert.strictEqual(view.strokes, undefined, 'players who are present receive increments via the stroke event, and should not get the full set on every broadcast');

  const kb = Buffer.byteLength(JSON.stringify(view), 'utf8') / 1024;
  assert.ok(kb < 50, `the view should stay small, got ${kb.toFixed(1)} KB`);
});

test('someone joining mid-round or reconnecting gets every stroke (otherwise their canvas is blank)', () => {
  const s = drawState(4);
  dg.applyAction(s, { type: 'stroke', strokes: Array.from({ length: 10 }, seg) }, s.drawerId);

  const spec = dg.serializeStateFor(s, '__spectator__');
  assert.strictEqual(spec.strokes?.length, 10, 'a spectator needs the full catch-up redraw');

  const g = guesserOf(s);
  s.absent[g] = true;
  assert.strictEqual(dg.serializeStateFor(s, g).strokes?.length, 10, 'a reconnecting player needs the full catch-up redraw');
});

test('clearing or changing round bumps strokeRev, telling the client to redraw', () => {
  const s = drawState();
  const rev0 = s.strokeRev;

  dg.applyAction(s, { type: 'stroke', strokes: [seg()] }, s.drawerId);
  assert.strictEqual(s.strokeRev, rev0, 'an ordinary stroke should not bump the revision (increments travel on the stroke event)');

  dg.applyAction(s, { type: 'clear' }, s.drawerId);
  assert.ok(s.strokeRev > rev0, 'clearing must bump the revision');
  assert.deepStrictEqual(
    dg.serializeStateFor(s, guesserOf(s)).strokes, [],
    'after a clear, send an empty array so the client wipes its canvas'
  );
});

// ── Guessing ──

test('guess text is truncated, so it cannot be used as an arbitrary-length broadcast channel', () => {
  const s = drawState();
  const r = dg.applyAction(s, { type: 'guess', text: 'x'.repeat(100000) }, guesserOf(s));
  assert.ok(r.events[0].text.length <= 100, `the broadcast guess length should be capped, got ${r.events[0].text.length}`);
});

test('a correct guess still scores, and leading/trailing spaces do not affect the match', () => {
  const s = drawState();
  const g = guesserOf(s);
  dg.applyAction(s, { type: 'guess', text: '  ' + s.word + ' ' }, g);
  assert.ok(s.scores[g] > 0, 'a correct answer with spaces around it should be accepted');
  assert.ok(s.scores[s.drawerId] > 0, 'the drawer should score too');
});

test('a wrong guess does not leak the answer, and someone who already guessed cannot score twice', () => {
  const s = drawState();
  const g = guesserOf(s);
  const wrong = dg.applyAction(s, { type: 'guess', text: 'wrong' }, g);
  assert.ok(!JSON.stringify(wrong.events).includes(s.word), 'the answer must not appear in the broadcast of a wrong guess');

  dg.applyAction(s, { type: 'guess', text: s.word }, g);
  const pts = s.scores[g];
  assert.ok(dg.applyAction(s, { type: 'guess', text: s.word }, g).error, 'someone who already guessed cannot guess again');
  assert.strictEqual(s.scores[g], pts, 'the score must not accumulate twice');
});

test('the drawer cannot guess their own word', () => {
  const s = drawState();
  assert.ok(dg.applyAction(s, { type: 'guess', text: s.word }, s.drawerId).error);
});

test('spectators cannot act, and above all cannot coax the answer out by guessing', () => {
  // serializeStateFor decides whether to send word based on guessedThisRound. If a
  // spectator could guess, a correct one would write them into guessedThisRound and the
  // next broadcast would hand them the answer.
  // The client already hides the input box from spectators, but a client message is only
  // a request -- the server has to be the one that refuses.
  const s = drawState();
  const r = dg.applyAction(s, { type: 'guess', text: s.word }, '__spectator__');

  assert.ok(r.error, 'a spectator should not be able to guess');
  assert.strictEqual(s.scores['__spectator__'], undefined, 'a spectator should not end up in the score table');
  assert.strictEqual(s.guessedThisRound['__spectator__'], undefined, 'a spectator should not end up in the guessed table');
  assert.strictEqual(
    dg.serializeStateFor(s, '__spectator__').word, undefined,
    'the answer must never appear in a spectator view'
  );
});

test('tick is exempt from the must-be-a-player check (it is server-driven, with no actor)', () => {
  const s = drawState();
  assert.ok(!dg.applyAction(s, { type: 'tick' }, null).error, 'tick passes a null playerId, which must be allowed through');
});

test('a guesser view omits the answer while the drawer view includes it', () => {
  const s = drawState();
  const view = dg.serializeStateFor(s, guesserOf(s));
  assert.strictEqual(view.word, undefined, 'a guesser view must never carry word');
  assert.strictEqual(typeof view.wordLength, 'number', 'a guesser should receive the word-length placeholder');
  assert.strictEqual(dg.serializeStateFor(s, s.drawerId).word, s.word, 'the drawer should see the answer');
});
