// Tests for Chinese Official fan scoring. Pure functions, run with node --test, no framework needed:
//
//   cd client && npm test
//
// Everything pinned down here is of the "a miscalculation raises no error, it just quietly
// returns a wrong number" kind -- nobody notices a wrong fan count unless someone checks the rulebook.

import { test } from 'node:test';
import assert from 'node:assert';

import { parseHand } from './parser.js';
import { analyzeHand } from './decomposer.js';
import { calcGB } from './rules/guobiao.js';
import { calcHK } from './rules/hk.js';
import { calcTenpai } from './tenpai.js';

// Score a hand: returns { fan, names[] }
const gb = (hand, ctx = {}) => {
  const p = parseHand(hand);
  assert.ok(!p.error, `parse failed: ${p.error}`);
  const a = analyzeHand(p.tiles);
  assert.ok(a.win, `${hand} should be a winning hand`);
  const r = calcGB(a.decompositions, ctx);
  return { fan: r.fan, names: (r.yaku || []).map((y) => y.name), below: !!r.belowMinimum };
};

const CONCEALED_SELF = { hasOpen: false, selfDraw: true };
const CONCEALED_RON = { hasOpen: false, selfDraw: false };

// ── Four Concealed Triplets: must be concealed, and must not swallow Full Flush ──

test('Four Concealed Triplets requires a concealed self-draw -- a discard win does not count', () => {
  // The pattern's own description says "four concealed triplets"; on a discard win the last group is melded.
  const self = gb('111222333444m55m', CONCEALED_SELF);
  const ron = gb('111222333444m55m', CONCEALED_RON);
  assert.ok(self.names.includes('四暗刻'), 'a concealed self-draw should score Four Concealed Triplets');
  assert.ok(!ron.names.includes('四暗刻'), 'a discard win should not score Four Concealed Triplets');
});

test('Four Concealed Triplets does not swallow Full Flush', () => {
  // The original implementation returned as soon as Four Concealed Triplets hit, with Full Flush scored later -- a Full Flush + Four Concealed Triplets hand lost 24 fan.
  const r = gb('111222333444m55m', CONCEALED_SELF);
  assert.ok(r.names.includes('四暗刻'), 'should have Four Concealed Triplets');
  assert.ok(r.names.includes('清一色'), 'the same hand is also a Full Flush, which an early return must not swallow');
});

test('Four Concealed Triplets and Three Concealed Triplets are not double counted', () => {
  // Four concealed triplets already contain three of them; Chinese Official does not count it twice
  const r = gb('111222333444m55m', CONCEALED_SELF);
  assert.ok(!(r.names.includes('四暗刻') && r.names.includes('三暗刻')),
    'Four Concealed Triplets and Three Concealed Triplets must not both appear');
});

// ── All Simples: used to be blocked by Fully Concealed Self-Drawn Hand ──

test('All Simples is not blocked by Fully Concealed Self-Drawn Hand', () => {
  // All Simples describes the hand's shape, Fully Concealed Self-Drawn Hand describes how it was won; not the same dimension, so blocking each other is wrong.
  // Before the fix this concealed self-draw only had Fully Concealed 4 + Self-Draw 1 + Concealed Hand 2 = 7 fan < 8, and was judged unable to win.
  const r = gb('234m567m345p678s55p', CONCEALED_SELF);
  assert.ok(r.names.includes('断幺'), 'no terminals or honours should score All Simples');
  assert.ok(r.fan >= 8, `Chinese Official needs 8 fan to win, got ${r.fan} fan`);
  assert.ok(!r.below, 'should not be judged as below the minimum fan');
});

test('Fully Concealed Self-Drawn Hand is not double counted with Self-Draw / Concealed Hand', () => {
  // Fully Concealed Self-Drawn Hand = concealed + self-draw; scoring all three gives 3 fan too many
  const r = gb('234m567m345p678s55p', CONCEALED_SELF);
  assert.ok(r.names.includes('不求人'));
  assert.ok(!r.names.includes('自摸'), 'Fully Concealed Self-Drawn Hand already includes Self-Draw');
  assert.ok(!r.names.includes('门前清'), 'Fully Concealed Self-Drawn Hand already includes Concealed Hand');
});

test('Self-Draw / Concealed Hand are still scored separately when it is not a concealed self-draw', () => {
  const r = gb('123456789m123p11s', CONCEALED_RON);
  assert.ok(r.names.includes('门前清'), 'a concealed discard win should still score Concealed Hand');
  assert.ok(!r.names.includes('不求人'), 'a discard win is not a Fully Concealed Self-Drawn Hand');
});

// ── Regression for the high-fan patterns (the change did not touch them, but the structure moved, so confirm nothing broke) ──

test('the high-fan patterns are still correct', () => {
  const cases = [
    ['111z222z333z444z55z', '大四喜', 88],
    ['555z666z777z123m11p', '大三元', 88],
    ['19m19p19s1234567z1z', '十三幺', 88],
  ];
  for (const [hand, name, fan] of cases) {
    const r = gb(hand, {});
    assert.ok(r.names.includes(name), `${hand} should be ${name}, got ${r.names}`);
    assert.strictEqual(r.fan, fan, `${name} should be ${fan} fan`);
  }
});

test('Chinese Official needs 8 fan to win: too few fan means no win', () => {
  // All Simples + All Sequences won on a discard is only 4+2=6 fan, which simply cannot win under Chinese Official -- that is the rule, not a bug
  const r = gb('234m567m345p678s55p', CONCEALED_RON);
  assert.strictEqual(r.fan, 0);
  assert.ok(r.below, 'should set belowMinimum, which the UI uses to say "below 8 fan"');
});

// ── Parser ──

test('parser: both the Chinese-character and numeric formats are supported', () => {
  assert.strictEqual(parseHand('123m456m789m东东东中中').tiles.length, 14);
  assert.strictEqual(parseHand('1122m3344p5566s77z').tiles.length, 14);
});

test('parser: invalid input raises an error instead of silently returning garbage', () => {
  for (const bad of ['abc', '0m', '123x', '999999999m']) {
    assert.ok(parseHand(bad).error, `${bad} should raise an error`);
  }
});

// ── Waits ──

test('the wait calculation returns the tiles being waited on', () => {
  const p = parseHand('123m456m789m123p1s');
  const waits = calcTenpai(p.tiles);
  assert.strictEqual(waits.length, 1, 'should wait on 1 kind of tile');
  assert.strictEqual(waits[0].suit, 's');
  assert.strictEqual(waits[0].num, 1);
});

test('Thirteen Orphans waits on all 13 tiles', () => {
  const p = parseHand('19m19p19s1234567z');
  assert.strictEqual(p.tiles.length, 13);
  assert.strictEqual(calcTenpai(p.tiles).length, 13, 'a pure Thirteen Orphans wait should be a 13-way wait');
});

// ── Hong Kong rules (untouched, kept as a regression check) ──

test('the basic Hong Kong patterns can be scored', () => {
  const p = parseHand('1122m3344p5566s77z');
  const a = analyzeHand(p.tiles);
  const r = calcHK(a.decompositions, {});
  assert.ok(r.fan > 0, 'Seven Pairs should score some fan');
});
