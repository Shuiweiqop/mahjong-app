// Behavior tests for the i18n layer.
//
// scripts/check-i18n.mjs already checks that the two tables line up and that no
// server error code is missing an entry. What it cannot check is whether the logic
// around those tables behaves: the fallback chain, placeholder interpolation, and
// the `code:arg` form that carries a server-side limit into a message. All of that
// is hand-written, so it is tested here.
//
// These import the real implementations from strings.js, which is why that file is
// plain .js with no React or DOM access -- node cannot load .jsx. Anything that
// does touch React lives in i18n.jsx and is not covered here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { LANGS, translate, interpolate, gameName, serverError, yakuText } from './strings.js';

// t() as the components see it, bound to one language.
const tFor = (lang) => (key, vars) => translate(lang, key, vars);
const en = tFor('en');
const zh = tFor('zh');

// -- lookup and fallback ------------------------------------------------------

test('a known key resolves in each language', () => {
  assert.equal(en('lobby.join'), 'Join');
  assert.equal(zh('lobby.join'), '加入');
});

test('a missing key returns the key itself, never a blank', () => {
  // Rendering blank would hide the omission; the key on screen makes it obvious.
  assert.equal(en('nope.not.a.key'), 'nope.not.a.key');
  assert.equal(zh('nope.not.a.key'), 'nope.not.a.key');
});

test('an unknown language falls back to English rather than throwing', () => {
  assert.equal(translate('de', 'lobby.join'), 'Join');
});

test('both languages are declared in LANGS', () => {
  assert.deepEqual(Object.keys(LANGS).sort(), ['en', 'zh']);
});

// -- interpolation ------------------------------------------------------------

test('placeholders are filled from vars', () => {
  assert.equal(en('room.needPlayers', { n: 4 }), 'Needs at least 4 players');
  assert.equal(zh('room.needPlayers', { n: 4 }), '至少需要 4 人');
});

test('multiple placeholders are all filled', () => {
  assert.equal(en('lobby.playerRange', { min: 2, max: 8 }), '2-8 players · real-time');
});

test('a missing var leaves its placeholder visible', () => {
  // Better a literal {n} on screen than a silently mangled sentence.
  assert.match(en('room.needPlayers', {}), /\{n\}/);
});

test('zero and empty string interpolate rather than counting as absent', () => {
  const out = en('room.spectatorCount', { n: 0, god: '' });
  assert.match(out, /0/);
  assert.doesNotMatch(out, /\{god\}/);
});

test('interpolate leaves a string alone when given no vars', () => {
  assert.equal(interpolate('{n} players', undefined), '{n} players');
});

// -- server error codes -------------------------------------------------------

test('a plain error code resolves in both languages', () => {
  assert.equal(serverError(en, 'room.notFound'), 'Room not found');
  assert.equal(serverError(zh, 'room.notFound'), '房间不存在');
});

test('a code carrying an argument fills the placeholder', () => {
  // The server sends auth.passwordTooShort:8 so the limit can change without
  // touching either translation table.
  assert.equal(serverError(en, 'auth.passwordTooShort:8'), 'Password must be at least 8 characters');
  assert.equal(serverError(zh, 'auth.passwordTooShort:8'), '密码至少 8 个字符');
});

test('an unknown code is shown verbatim, not blank', () => {
  // Keeps an older server that still sends prose readable, and makes a code with no
  // entry visible instead of silently empty.
  assert.equal(serverError(en, 'some.unmapped.code'), 'some.unmapped.code');
  assert.equal(serverError(en, '请填写邮箱'), '请填写邮箱');
});

test('a falsy code yields an empty string', () => {
  for (const v of [null, undefined, '']) assert.equal(serverError(en, v), '');
});

// -- game names ---------------------------------------------------------------

test('a known game id uses the translation, not the server displayName', () => {
  assert.equal(gameName(en, 'werewolf', '狼人杀'), 'Werewolf');
  assert.equal(gameName(zh, 'werewolf', 'ignored'), '狼人杀');
});

test('an unknown game id falls back to the name the server sent', () => {
  // A game added without a translation should still be nameable in the lobby.
  assert.equal(gameName(en, 'chess', 'Chess'), 'Chess');
  assert.equal(gameName(en, 'chess', undefined), 'chess');
});

// -- yaku names ---------------------------------------------------------------

test('a yaku is translated for English and left alone for Chinese', () => {
  const y = { name: '大四喜', fan: 88, description: '四种风牌各一组刻子' };
  assert.equal(yakuText('en', y).name, 'Big Four Winds');
  assert.equal(yakuText('zh', y).name, '大四喜');
  assert.equal(yakuText('en', y).fan, 88, 'fan must survive translation');
});

test('a yaku name with a count suffix keeps the suffix', () => {
  // The engine emits names like "幺九刻 x3"; the base is translated and the count
  // appended back.
  const out = yakuText('en', { name: '幺九刻 x3', fan: 3, description: '' });
  assert.match(out.name, /x3$/);
  assert.match(out.name, /Terminal/);
});

test('an untranslated yaku falls back to the Chinese original', () => {
  // A newly added yaku without an entry should still render, not vanish.
  const out = yakuText('en', { name: '某个新番型', fan: 2, description: 'desc' });
  assert.equal(out.name, '某个新番型');
});

// -- content sanity -----------------------------------------------------------
// These overlap with scripts/check-i18n.mjs but run in the normal test suite, so a
// regression shows up as a failing test rather than only in the separate check.

// Keys known to carry placeholders; kept explicit so the test states what it covers
// rather than silently passing if the tables were empty.
const SAMPLE_KEYS_WITH_VARS = [
  'room.needPlayers', 'room.playersCount', 'room.badge', 'room.unknownGame',
  'lobby.playerRange', 'settings.roundsUnit', 'settings.customCount',
  'draw.round', 'draw.guessed', 'draw.answerWas', 'draw.picking',
  'wolf.day', 'wolf.killed', 'wolf.exiled', 'wolf.shotTook', 'wolf.aliveCount',
  'kittens.theirTurn', 'kittens.extraTurns', 'kittens.handCount', 'kittens.myHand',
  'speech.position', 'hunter.aim', 'night.kill', 'vote.votePlayer',
  'err.auth.passwordTooShort', 'err.auth.passwordTooLong',
];

test('every placeholder in an English string appears in its Chinese twin', () => {
  // A dropped placeholder means one language silently loses a number or a name.
  const names = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  // Probe via translate() so this reads only through the public surface.
  for (const key of SAMPLE_KEYS_WITH_VARS) {
    assert.deepEqual(names(zh(key)), names(en(key)), `placeholders differ for '${key}'`);
  }
});
