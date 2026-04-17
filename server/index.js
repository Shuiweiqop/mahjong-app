const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const http = require('http');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const authRoutes = require('./routes/auth');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const JWT_SECRET = process.env.JWT_SECRET || 'mahjong_secret_key';

app.use(cors());
app.use(express.json());
app.use('/api/auth', authRoutes(pool));

async function ensureSchema() {
  const [columns] = await pool.query(
    'SHOW COLUMNS FROM sessions LIKE ?',
    ['user_id']
  );
  if (columns.length === 0) {
    await pool.query('ALTER TABLE sessions ADD COLUMN user_id INT NULL');
  }

  const [indexes] = await pool.query(
    'SHOW INDEX FROM sessions WHERE Key_name = ?',
    ['idx_sessions_user_id']
  );
  if (indexes.length === 0) {
    await pool.query('CREATE INDEX idx_sessions_user_id ON sessions (user_id)');
  }
}

function getUser(req) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return null;
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

async function requireSessionOwner(req, res, next) {
  const user = getUser(req);
  if (!user?.id) {
    return res.status(401).json({ error: '请先登录' });
  }

  try {
    const { id } = req.params;
    const [rows] = await pool.query(
      'SELECT user_id FROM sessions WHERE id = ?',
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: '局不存在' });
    }

    const session = rows[0];
    if (session.user_id !== null && session.user_id !== user.id) {
      return res.status(403).json({ error: '无权操作此局' });
    }

    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function getSessionScoreData(sessionId) {
  const [players] = await pool.query('SELECT * FROM players WHERE session_id = ?', [sessionId]);
  const [rounds] = await pool.query(
    'SELECT r.*, rs.player_id, rs.score FROM rounds r ' +
    'JOIN round_scores rs ON r.id = rs.round_id ' +
    'WHERE r.session_id = ? ORDER BY r.round_number',
    [sessionId]
  );
  const totals = {};
  for (const p of players) totals[p.id] = 0;
  for (const r of rounds) totals[r.player_id] += r.score;
  return { players, rounds, totals };
}

async function broadcastScoreUpdate(sessionId) {
  const [session] = await pool.query('SELECT room_code FROM sessions WHERE id = ?', [sessionId]);
  if (!session[0]?.room_code) return;

  const data = await getSessionScoreData(sessionId);
  io.to(session[0].room_code).emit('score_updated', data);
}

app.post('/api/sessions', async (req, res) => {
  const { name, players } = req.body;
  const user = getUser(req);
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();
    const roomCode = generateRoomCode();
    const [session] = await conn.query(
      'INSERT INTO sessions (name, room_code, user_id) VALUES (?, ?, ?)',
      [name, roomCode, user?.id || null]
    );
    const sessionId = session.insertId;

    for (const playerName of players) {
      await conn.query(
        'INSERT INTO players (session_id, name) VALUES (?, ?)',
        [sessionId, playerName]
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
  const user = getUser(req);
  if (!user?.id) return res.json([]);

  try {
    const [rows] = await pool.query(
      'SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC',
      [user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/:id', async (req, res) => {
  try {
    const data = await getSessionScoreData(req.params.id);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rooms/:code', async (req, res) => {
  const { code } = req.params;
  try {
    const [rows] = await pool.query(
      'SELECT * FROM sessions WHERE room_code = ? AND is_active = TRUE ORDER BY created_at DESC LIMIT 1',
      [code.toUpperCase()]
    );
    if (rows.length === 0) return res.status(404).json({ error: '房间不存在' });
    res.json({ sessionId: rows[0].id, name: rows[0].name, roomCode: rows[0].room_code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/:id/rounds', requireSessionOwner, async (req, res) => {
  const { id } = req.params;
  const { scores } = req.body;
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();
    const [[{ maxRound }]] = await conn.query(
      'SELECT COALESCE(MAX(round_number), 0) as maxRound FROM rounds WHERE session_id = ?',
      [id]
    );
    const [round] = await conn.query(
      'INSERT INTO rounds (session_id, round_number) VALUES (?, ?)',
      [id, maxRound + 1]
    );
    const roundId = round.insertId;

    for (const { playerId, score } of scores) {
      await conn.query(
        'INSERT INTO round_scores (round_id, player_id, score) VALUES (?, ?, ?)',
        [roundId, playerId, score]
      );
    }

    await conn.commit();
    await broadcastScoreUpdate(id);
    res.json({ roundId, roundNumber: maxRound + 1 });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

app.delete('/api/sessions/:id/rounds/last', requireSessionOwner, async (req, res) => {
  const { id } = req.params;
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();
    const [[lastRound]] = await conn.query(
      'SELECT id FROM rounds WHERE session_id = ? ORDER BY round_number DESC LIMIT 1',
      [id]
    );
    if (!lastRound) {
      await conn.rollback();
      return res.status(404).json({ error: 'No rounds found' });
    }

    await conn.query('DELETE FROM round_scores WHERE round_id = ?', [lastRound.id]);
    await conn.query('DELETE FROM rounds WHERE id = ?', [lastRound.id]);
    await conn.commit();

    await broadcastScoreUpdate(id);
    res.json({ deleted: lastRound.id });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

app.delete('/api/sessions/:id', requireSessionOwner, async (req, res) => {
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

io.on('connection', (socket) => {
  socket.on('join_room', (roomCode) => socket.join(roomCode.toUpperCase()));
  socket.on('leave_room', (roomCode) => socket.leave(roomCode.toUpperCase()));
});

app.get('/api/ping', async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

ensureSchema()
  .then(() => {
    server.listen(process.env.PORT, () => {
      console.log(`Server running on port ${process.env.PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to prepare database schema:', err);
    process.exit(1);
  });
