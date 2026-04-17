const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'mahjong_secret_key';

module.exports = (pool) => {

  router.post('/register', async (req, res) => {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ error: '请填写邮箱和密码' });
    try {
      const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
      if (existing.length > 0) return res.status(400).json({ error: '邮箱已注册' });
      const hash = await bcrypt.hash(password, 10);
      const [result] = await pool.query(
        'INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)',
        [email, hash, name || email.split('@')[0]]
      );
      const token = jwt.sign(
        { id: result.insertId, email, name: name || email.split('@')[0] },
        JWT_SECRET, { expiresIn: '30d' }
      );
      res.json({ token, user: { id: result.insertId, email, name: name || email.split('@')[0] } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: '请填写邮箱和密码' });
    try {
      const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
      if (users.length === 0) return res.status(400).json({ error: '邮箱或密码错误' });
      const user = users[0];
      if (!user.password_hash) return res.status(400).json({ error: '请用 Google 登录' });
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(400).json({ error: '邮箱或密码错误' });
      const token = jwt.sign(
        { id: user.id, email: user.email, name: user.name },
        JWT_SECRET, { expiresIn: '30d' }
      );
      res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/me', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: '未登录' });
    try {
      const user = jwt.verify(token, JWT_SECRET);
      res.json({ user });
    } catch {
      res.status(401).json({ error: 'Token 无效' });
    }
  });

  return router;
};