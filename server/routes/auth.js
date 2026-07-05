// 认证路由 —— 走 db 层(Postgres 或内存降级),返回 { token, user }。
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'platform_secret_key';
const router = express.Router();

const sign = (u) => jwt.sign({ id: u.id, email: u.email, name: u.name }, JWT_SECRET, { expiresIn: '30d' });

router.post('/register', async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: '请填写邮箱和密码' });
  try {
    const { user, error } = await db.createUser(email, password, name);
    if (error) return res.status(400).json({ error });
    res.json({ token: sign(user), user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: '请填写邮箱和密码' });
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
