// Auth route tests —— they spin up a real express instance and make HTTP calls, with no mocking.
//
// What is guarded here are two classes of problem that "turn nothing red when they go wrong":
//   1. The JWT secret degrading into a public hardcoded value (the service starts as usual and logging in works as usual, but anyone can forge a login session)
//   2. The input validation on the registration endpoint (bcrypt truncates at 72 bytes, so not blocking it means the user's password is silently shortened)
//
//   cd server && npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

// Make sure it is loaded in "local development" mode (no DATABASE_URL → in-memory storage + a random secret)
delete process.env.DATABASE_URL;
delete process.env.JWT_SECRET;

const { router, JWT_SECRET } = require('./auth');

let server, base;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', router);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/auth`;
});

after(() => server?.close());

const post = async (path, body) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

// Each test case uses a different email, to avoid "email already registered" interfering between them
let n = 0;
const freshEmail = () => `user${Date.now()}_${n++}@example.com`;

// ── The secret ──

test('the JWT secret is not a hardcoded fallback value from the code', () => {
  assert.notStrictEqual(
    JWT_SECRET, 'platform_secret_key',
    'once the secret is written into open-source code, anyone can sign a token for any user'
  );
  assert.ok(JWT_SECRET.length >= 16, 'the secret is too short');
});

test('a token forged with the old public secret is rejected', () => {
  const forged = jwt.sign({ id: 1, email: 'victim@example.com' }, 'platform_secret_key');
  assert.throws(
    () => jwt.verify(forged, JWT_SECRET),
    'a token signed with the public secret must fail verification'
  );
});

// ── Registration validation ──

test('a usable token is returned after a successful registration', async () => {
  const email = freshEmail();
  const { status, body } = await post('/register', { email, password: 'goodpassword', name: '阿猫' });
  assert.strictEqual(status, 200, JSON.stringify(body));
  assert.ok(body.token);
  assert.strictEqual(jwt.verify(body.token, JWT_SECRET).email, email);
});

test('rejects a password that is too short', async () => {
  const { status } = await post('/register', { email: freshEmail(), password: '1' });
  assert.strictEqual(status, 400, 'a one-digit password should not be able to register');
});

test("rejects a password beyond bcrypt's 72-byte limit", async () => {
  // If this is not blocked, bcrypt truncates silently: the user thinks they set a long password, but only the
  // first 72 bytes are actually in effect, and the 72-byte and 100-byte passwords can each log in as the other.
  const { status } = await post('/register', { email: freshEmail(), password: 'x'.repeat(100) });
  assert.strictEqual(status, 400, 'an over-long password should be rejected rather than silently truncated');
});

test('password length is measured in bytes (a Chinese character is up to 4 bytes)', async () => {
  // 20 Chinese characters = 60 bytes, which is valid; 30 = 90 bytes, which is over the limit
  assert.strictEqual((await post('/register', { email: freshEmail(), password: '密'.repeat(20) })).status, 200);
  assert.strictEqual((await post('/register', { email: freshEmail(), password: '密'.repeat(30) })).status, 400);
});

test('rejects malformed emails', async () => {
  for (const email of ['notanemail', 'a@b', 'a b@c.com', '@example.com']) {
    const { status } = await post('/register', { email, password: 'goodpassword' });
    assert.strictEqual(status, 400, `"${email}" should not pass`);
  }
});

test('the display name is truncated to the limit, so it cannot become broadcast content of arbitrary length', async () => {
  // display names are broadcast to the whole room
  const { body } = await post('/register', { email: freshEmail(), password: 'goodpassword', name: '很长'.repeat(100) });
  assert.ok(body.user.name.length <= 20, `the display name should be truncated, but it is actually ${body.user.name.length} characters`);
});

test('non-string parameters do not crash the service', async () => {
  for (const payload of [
    { email: { $ne: null }, password: 'goodpassword' },
    { email: freshEmail(), password: 12345678 },
    { email: [], password: [] },
  ]) {
    const { status } = await post('/register', payload);
    assert.strictEqual(status, 400, JSON.stringify(payload) + ' should be rejected');
  }
});

// ── Login ──

test('login succeeds, and is rejected when the password is wrong', async () => {
  const email = freshEmail();
  await post('/register', { email, password: 'goodpassword' });

  assert.strictEqual((await post('/login', { email, password: 'goodpassword' })).status, 200);
  assert.strictEqual((await post('/login', { email, password: 'wrongpassword' })).status, 400);
});

test('login does not apply the registration strength rules (otherwise it would lock existing users out)', async () => {
  // A password registered before the rules were tightened may not satisfy the new rules, but it must still be able to log in.
  // Here a user with a short password is written straight through the db layer, bypassing the registration
  // endpoint's validation, to simulate historical data.
  const db = require('../db');
  const email = freshEmail();
  await db.createUser(email, '123', '老用户');

  const { status } = await post('/login', { email, password: '123' });
  assert.strictEqual(status, 200, "an existing user's weak password should still be able to log in");
});

test('a failed login does not reveal "whether the email is already registered"', async () => {
  const email = freshEmail();
  await post('/register', { email, password: 'goodpassword' });

  const wrongPw = await post('/login', { email, password: 'wrongpassword' });
  const noSuchUser = await post('/login', { email: freshEmail(), password: 'goodpassword' });
  assert.strictEqual(
    wrongPw.body.error, noSuchUser.body.error,
    'the messages for the two kinds of failure must be identical, otherwise they could be used to enumerate registered emails'
  );
});

// ── /me ──

test('/me validates the token, returning 401 for both a forged and a missing one', async () => {
  const email = freshEmail();
  const { body } = await post('/register', { email, password: 'goodpassword' });

  const withToken = await fetch(base + '/me', { headers: { authorization: `Bearer ${body.token}` } });
  assert.strictEqual(withToken.status, 200);
  assert.strictEqual((await withToken.json()).user.email, email);

  assert.strictEqual((await fetch(base + '/me')).status, 401);

  const forged = jwt.sign({ id: 1, email: 'victim@example.com' }, 'platform_secret_key');
  const withForged = await fetch(base + '/me', { headers: { authorization: `Bearer ${forged}` } });
  assert.strictEqual(withForged.status, 401, 'a token forged with the public secret must be rejected');
});
