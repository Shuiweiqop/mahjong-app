// 认证路由测试 —— 起一个真实的 express 实例打 HTTP,不 mock。
//
// 这里守的是两类"错了也不会有任何东西变红"的问题:
//   1. JWT 密钥降级成公开的硬编码值(服务照常启动,登录照常工作,但谁都能伪造登录态)
//   2. 注册端的输入校验(bcrypt 在 72 字节处截断,不挡住就等于用户密码被静默削短)
//
//   cd server && npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');

// 确保以"本地开发"模式载入(无 DATABASE_URL → 内存存储 + 随机密钥)
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

// 每个用例用不同邮箱,避免"邮箱已注册"互相干扰
let n = 0;
const freshEmail = () => `user${Date.now()}_${n++}@example.com`;

// ── 密钥 ──

test('JWT 密钥不是代码里的硬编码兜底值', () => {
  assert.notStrictEqual(
    JWT_SECRET, 'platform_secret_key',
    '密钥一旦写在开源代码里,任何人都能签出任意用户的 token'
  );
  assert.ok(JWT_SECRET.length >= 16, '密钥太短');
});

test('用旧的公开密钥伪造的 token 会被拒绝', () => {
  const forged = jwt.sign({ id: 1, email: 'victim@example.com' }, 'platform_secret_key');
  assert.throws(
    () => jwt.verify(forged, JWT_SECRET),
    '用公开密钥签出的 token 必须验不过'
  );
});

// ── 注册校验 ──

test('注册成功后返回可用的 token', async () => {
  const email = freshEmail();
  const { status, body } = await post('/register', { email, password: 'goodpassword', name: '阿猫' });
  assert.strictEqual(status, 200, JSON.stringify(body));
  assert.ok(body.token);
  assert.strictEqual(jwt.verify(body.token, JWT_SECRET).email, email);
});

test('拒绝过短的密码', async () => {
  const { status } = await post('/register', { email: freshEmail(), password: '1' });
  assert.strictEqual(status, 400, '一位数密码不该能注册');
});

test('拒绝超过 bcrypt 72 字节上限的密码', async () => {
  // 不挡住的话 bcrypt 会静默截断:用户以为设了长密码,实际只有前 72 字节有效,
  // 且 72 字节与 100 字节的密码可以互相登录成功。
  const { status } = await post('/register', { email: freshEmail(), password: 'x'.repeat(100) });
  assert.strictEqual(status, 400, '超长密码应被拒绝而不是静默截断');
});

test('密码长度按字节算(中文一个字最多 4 字节)', async () => {
  // 20 个中文字 = 60 字节,合法;30 个 = 90 字节,超限
  assert.strictEqual((await post('/register', { email: freshEmail(), password: '密'.repeat(20) })).status, 200);
  assert.strictEqual((await post('/register', { email: freshEmail(), password: '密'.repeat(30) })).status, 400);
});

test('拒绝格式错误的邮箱', async () => {
  for (const email of ['notanemail', 'a@b', 'a b@c.com', '@example.com']) {
    const { status } = await post('/register', { email, password: 'goodpassword' });
    assert.strictEqual(status, 400, `"${email}" 不该通过`);
  }
});

test('昵称被截断到上限,不能当成任意长度的广播内容', async () => {
  // 昵称会广播给全房间
  const { body } = await post('/register', { email: freshEmail(), password: 'goodpassword', name: '很长'.repeat(100) });
  assert.ok(body.user.name.length <= 20, `昵称应被截断,实际 ${body.user.name.length} 字`);
});

test('非字符串参数不会让服务崩溃', async () => {
  for (const payload of [
    { email: { $ne: null }, password: 'goodpassword' },
    { email: freshEmail(), password: 12345678 },
    { email: [], password: [] },
  ]) {
    const { status } = await post('/register', payload);
    assert.strictEqual(status, 400, JSON.stringify(payload) + ' 应被拒绝');
  }
});

// ── 登录 ──

test('登录成功,且密码错误时被拒绝', async () => {
  const email = freshEmail();
  await post('/register', { email, password: 'goodpassword' });

  assert.strictEqual((await post('/login', { email, password: 'goodpassword' })).status, 200);
  assert.strictEqual((await post('/login', { email, password: 'wrongpassword' })).status, 400);
});

test('登录不套用注册的强度规则(否则会把老用户锁在门外)', async () => {
  // 规则收紧前注册的密码可能不满足新规则,但仍必须能登录。
  // 这里直接用 db 层写入一个短密码用户,绕过注册端校验模拟历史数据。
  const db = require('../db');
  const email = freshEmail();
  await db.createUser(email, '123', '老用户');

  const { status } = await post('/login', { email, password: '123' });
  assert.strictEqual(status, 200, '老用户的弱密码仍应能登录');
});

test('登录失败不泄露"邮箱是否已注册"', async () => {
  const email = freshEmail();
  await post('/register', { email, password: 'goodpassword' });

  const wrongPw = await post('/login', { email, password: 'wrongpassword' });
  const noSuchUser = await post('/login', { email: freshEmail(), password: 'goodpassword' });
  assert.strictEqual(
    wrongPw.body.error, noSuchUser.body.error,
    '两种失败的提示必须一致,否则可用于枚举已注册邮箱'
  );
});

// ── /me ──

test('/me 校验 token,伪造与缺失都返回 401', async () => {
  const email = freshEmail();
  const { body } = await post('/register', { email, password: 'goodpassword' });

  const withToken = await fetch(base + '/me', { headers: { authorization: `Bearer ${body.token}` } });
  assert.strictEqual(withToken.status, 200);
  assert.strictEqual((await withToken.json()).user.email, email);

  assert.strictEqual((await fetch(base + '/me')).status, 401);

  const forged = jwt.sign({ id: 1, email: 'victim@example.com' }, 'platform_secret_key');
  const withForged = await fetch(base + '/me', { headers: { authorization: `Bearer ${forged}` } });
  assert.strictEqual(withForged.status, 401, '用公开密钥伪造的 token 必须被拒');
});
