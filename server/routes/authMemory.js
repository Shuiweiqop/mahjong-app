// 内存版认证 —— 开发/无数据库阶段用。
// 保持与原 routes/auth.js 相同的 API 形状({ token, user }),
// 以后接 Supabase 时替换存储层即可,前端无需改动。
//
// 也支持"访客"直接用(前端 onSkip),所以登录非强制。

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'platform_secret_key';

// 内存用户表(进程重启即清空 —— 开发阶段可接受)
const users = new Map(); // email -> { id, email, passwordHash, name }
let nextId = 1;

function sign(user) {
  return jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, {
    expiresIn: '30d',
  });
}

const router = express.Router();

router.post('/register', async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: '请填写邮箱和密码' });
  if (users.has(email)) return res.status(400).json({ error: '邮箱已注册' });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = { id: nextId++, email, passwordHash, name: name || email.split('@')[0] };
  users.set(email, user);
  const pub = { id: user.id, email: user.email, name: user.name };
  res.json({ token: sign(pub), user: pub });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: '请填写邮箱和密码' });
  const user = users.get(email);
  if (!user) return res.status(400).json({ error: '邮箱或密码错误' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(400).json({ error: '邮箱或密码错误' });
  const pub = { id: user.id, email: user.email, name: user.name };
  res.json({ token: sign(pub), user: pub });
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
