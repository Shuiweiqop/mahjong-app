const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const authRoutes = require('./routes/auth');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// pool 必须在 authRoutes 之前定义
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

app.use(cors());
app.use(express.json());
app.use('/api/auth', authRoutes(pool));
// ── 生成6位房间码 ────────────────────────────────────────
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ── SESSIONS ─────────────────────────────────────────────

app.post('/api/sessions', async (req, res) => {
  const { name, players } = req.body;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const roomCode = generateRoomCode();
    const [session] = await conn.query(
      'INSERT INTO sessions (name, room_code) VALUES (?, ?)', [name, roomCode]
    );
    const sessionId = session.insertId;
    for (const playerName of players) {
      await conn.query(
        'INSERT INTO players (session_id, name) VALUES (?, ?)', [sessionId, playerName]
      );
    }
    await conn.commit();
    res.json({ sessionId, roomCode });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

app.get('/api/sessions', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM sessions ORDER BY created_at DESC');
  res.json(rows);
});

app.get('/api/sessions/:id', async (req, res) => {
  const { id } = req.params;
  const [players] = await pool.query('SELECT * FROM players WHERE session_id = ?', [id]);
  const [rounds] = await pool.query(
    'SELECT r.*, rs.player_id, rs.score FROM rounds r ' +
    'JOIN round_scores rs ON r.id = rs.round_id ' +
    'WHERE r.session_id = ? ORDER BY r.round_number', [id]
  );
  const totals = {};
  for (const p of players) totals[p.id] = 0;
  for (const r of rounds) totals[r.player_id] += r.score;
  res.json({ players, rounds, totals });
});

// 用房间码加入
app.get('/api/rooms/:code', async (req, res) => {
  const { code } = req.params;
  const [rows] = await pool.query(
    'SELECT * FROM sessions WHERE room_code = ? AND is_active = TRUE ORDER BY created_at DESC LIMIT 1',
    [code.toUpperCase()]
  );
  if (rows.length === 0) return res.status(404).json({ error: '房间不存在' });
  res.json({ sessionId: rows[0].id, name: rows[0].name, roomCode: rows[0].room_code });
});

// ── ROUNDS ───────────────────────────────────────────────

app.post('/api/sessions/:id/rounds', async (req, res) => {
  const { id } = req.params;
  const { scores } = req.body;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[{ maxRound }]] = await conn.query(
      'SELECT COALESCE(MAX(round_number), 0) as maxRound FROM rounds WHERE session_id = ?', [id]
    );
    const [round] = await conn.query(
      'INSERT INTO rounds (session_id, round_number) VALUES (?, ?)', [id, maxRound + 1]
    );
    const roundId = round.insertId;
    for (const { playerId, score } of scores) {
      await conn.query(
        'INSERT INTO round_scores (round_id, player_id, score) VALUES (?, ?, ?)',
        [roundId, playerId, score]
      );
    }
    await conn.commit();

    // 广播给房间里所有人
    const [session] = await pool.query('SELECT room_code FROM sessions WHERE id = ?', [id]);
    if (session[0]?.room_code) {
      const [players] = await pool.query('SELECT * FROM players WHERE session_id = ?', [id]);
      const [rounds] = await pool.query(
        'SELECT r.*, rs.player_id, rs.score FROM rounds r ' +
        'JOIN round_scores rs ON r.id = rs.round_id ' +
        'WHERE r.session_id = ? ORDER BY r.round_number', [id]
      );
      const totals = {};
      for (const p of players) totals[p.id] = 0;
      for (const r of rounds) totals[r.player_id] += r.score;
      io.to(session[0].room_code).emit('score_updated', { players, rounds, totals });
    }

    res.json({ roundId, roundNumber: maxRound + 1 });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

app.delete('/api/sessions/:id/rounds/last', async (req, res) => {
  const { id } = req.params;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[lastRound]] = await conn.query(
      'SELECT id FROM rounds WHERE session_id = ? ORDER BY round_number DESC LIMIT 1', [id]
    );
    if (!lastRound) return res.status(404).json({ error: 'No rounds found' });
    await conn.query('DELETE FROM round_scores WHERE round_id = ?', [lastRound.id]);
    await conn.query('DELETE FROM rounds WHERE id = ?', [lastRound.id]);
    await conn.commit();

    // 广播撤销
    const [session] = await pool.query('SELECT room_code FROM sessions WHERE id = ?', [id]);
    if (session[0]?.room_code) {
      const [players] = await pool.query('SELECT * FROM players WHERE session_id = ?', [id]);
      const [rounds] = await pool.query(
        'SELECT r.*, rs.player_id, rs.score FROM rounds r ' +
        'JOIN round_scores rs ON r.id = rs.round_id ' +
        'WHERE r.session_id = ? ORDER BY r.round_number', [id]
      );
      const totals = {};
      for (const p of players) totals[p.id] = 0;
      for (const r of rounds) totals[r.player_id] += r.score;
      io.to(session[0].room_code).emit('score_updated', { players, rounds, totals });
    }

    res.json({ deleted: lastRound.id });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ── SOCKET.IO ────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // 加入房间
  socket.on('join_room', (roomCode) => {
    socket.join(roomCode.toUpperCase());
    console.log(`${socket.id} joined room ${roomCode}`);
  });

  // 离开房间
  socket.on('leave_room', (roomCode) => {
    socket.leave(roomCode.toUpperCase());
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// ── START ─────────────────────────────────────────────────
app.get('/api/ping', async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

server.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});

// 删除整局游戏
app.delete('/api/sessions/:id', async (req, res) => {
  const { id } = req.params;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rounds] = await conn.query('SELECT id FROM rounds WHERE session_id = ?', [id]);
    for (const r of rounds) {
      await conn.query('DELETE FROM round_scores WHERE round_id = ?', [r.id]);
    }
    await conn.query('DELETE FROM rounds WHERE session_id = ?', [id]);
    await conn.query('DELETE FROM players WHERE session_id = ?', [id]);
    await conn.query('DELETE FROM sessions WHERE id = ?', [id]);
    await conn.commit();
    res.json({ deleted: id });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});