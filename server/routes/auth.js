// 认证路由 —— 走 db 层(Postgres 或内存降级),返回 { token, user }。
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');

// JWT 密钥。这里绝不能有硬编码兜底值:密钥写在开源代码里 = 任何人都能签出
// 任意用户的 token(socket 层认 token 里的 id,伪造后可顶替他人重连进房间,
// 战绩也会记到别人名下)。而且这种降级是无声的 —— 服务照常启动,登录照常工作。
//
// 所以按环境分两条路,都不给"看起来能用的假密钥":
//   生产(有 DATABASE_URL,即真在存用户)→ 缺密钥直接退出,不启动。
//   本地开发 → 用每次启动随机生成的密钥。随机而非固定,是为了让重启后旧 token
//             自然失效,避免"本地一直能用"给人线上也没问题的错觉。
const IS_PROD = !!process.env.DATABASE_URL;
const JWT_SECRET = resolveSecret();

function resolveSecret() {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;

  if (IS_PROD) {
    console.error(
      fromEnv
        ? '❌ JWT_SECRET 太短(至少 16 字符),拒绝启动。'
        : '❌ 检测到 DATABASE_URL(生产环境)但未设置 JWT_SECRET,拒绝启动。\n' +
          '   没有密钥就无法安全签发登录态。请在部署平台设置 JWT_SECRET(Render 可用 generateValue)。'
    );
    process.exit(1);
  }
  console.warn('⚠️  未设置 JWT_SECRET,本次启动使用随机密钥(重启后登录态失效)。仅供本地开发。');
  return crypto.randomBytes(32).toString('hex');
}

const router = express.Router();

const sign = (u) => jwt.sign({ id: u.id, email: u.email, name: u.name }, JWT_SECRET, { expiresIn: '30d' });

// bcrypt 在 72 字节处截断,超出部分完全不参与哈希 —— 不挡住的话,用户设了
// 100 字的密码,实际只有前 72 字有效,而且 72 字和 100 字的密码会互相通过校验。
// 与其静默截断,不如直接拒绝并说明。
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;
const NAME_MAX = 20;          // 昵称会广播给全房间,需有上限
const EMAIL_MAX = 254;        // RFC 5321 的地址长度上限
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 返回错误字符串;通过校验则返回 null。
function validateCredentials(email, password) {
  if (!email || !password) return '请填写邮箱和密码';
  if (typeof email !== 'string' || typeof password !== 'string') return '参数格式错误';
  if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) return '邮箱格式不正确';
  // 按字节数算:中文密码一个字最多 4 字节,用长度判断会漏
  const bytes = Buffer.byteLength(password, 'utf8');
  if (bytes < PASSWORD_MIN) return `密码至少 ${PASSWORD_MIN} 个字符`;
  if (bytes > PASSWORD_MAX) return `密码过长(最多 ${PASSWORD_MAX} 字节)`;
  return null;
}

router.post('/register', async (req, res) => {
  const { email, password, name } = req.body || {};
  const invalid = validateCredentials(email, password);
  if (invalid) return res.status(400).json({ error: invalid });
  const displayName = typeof name === 'string' ? name.trim().slice(0, NAME_MAX) : name;
  try {
    const { user, error } = await db.createUser(email, password, displayName);
    if (error) return res.status(400).json({ error });
    res.json({ token: sign(user), user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  // 登录只做类型/非空检查,不套用注册的强度规则 —— 规则收紧前注册的老用户
  // 密码可能不满足新规则,拿新规则挡登录会把他们锁在门外。密码对不对由
  // bcrypt.compare 说了算。
  if (!email || !password) return res.status(400).json({ error: '请填写邮箱和密码' });
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: '参数格式错误' });
  }
  try {
    const { user, error } = await db.loginUser(email, password);
    if (error) return res.status(400).json({ error });
    res.json({ token: sign(user), user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/me', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    res.json({ user: jwt.verify(token, JWT_SECRET) });
  } catch {
    res.status(401).json({ error: 'Token 无效' });
  }
});

module.exports = { router, JWT_SECRET };
