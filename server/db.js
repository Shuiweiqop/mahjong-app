// Database layer —— Postgres (Supabase) persistence, with an in-memory fallback.
//
// If DATABASE_URL is set (production / Supabase) → use Postgres.
// Otherwise (local development with no database) → use an in-memory Map, so it runs with zero configuration.
// The layers above (auth / match records) call the same set of async methods and are unaware of the underlying implementation.

const bcrypt = require('bcryptjs');

const DATABASE_URL = process.env.DATABASE_URL;
const usePg = !!DATABASE_URL;

let pool = null;
if (usePg) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Supabase requires SSL
  });
}

// ── In-memory fallback storage ──
const mem = { users: new Map(), nextUserId: 1 };

// ── Users ──
async function createUser(email, password, name) {
  const passwordHash = await bcrypt.hash(password, 10);
  const displayName = name || email.split('@')[0];
  if (usePg) {
    try {
      const { rows } = await pool.query(
        'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name',
        [email, passwordHash, displayName]
      );
      return { user: rows[0] };
    } catch (e) {
      if (e.code === '23505') return { error: 'auth.emailTaken' }; // unique_violation
      throw e;
    }
  }
  if (mem.users.has(email)) return { error: 'auth.emailTaken' };
  const user = { id: mem.nextUserId++, email, passwordHash, name: displayName };
  mem.users.set(email, user);
  return { user: { id: user.id, email: user.email, name: user.name } };
}

async function loginUser(email, password) {
  let record;
  if (usePg) {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    record = rows[0];
  } else {
    record = mem.users.get(email);
  }
  if (!record) return { error: 'auth.badCredentials' };
  const hash = record.password_hash || record.passwordHash;
  const ok = await bcrypt.compare(password, hash);
  if (!ok) return { error: 'auth.badCredentials' };
  return { user: { id: record.id, email: record.email, name: record.name } };
}

// ── Match records (only written for logged-in users; a failure does not affect the game) ──
async function saveGameResult(gameId, roomCode, ranking) {
  if (!usePg) return; // memory mode does not persist match records
  try {
    const { rows } = await pool.query(
      'INSERT INTO game_results (game_id, room_code) VALUES ($1, $2) RETURNING id',
      [gameId, roomCode]
    );
    const resultId = rows[0].id;
    for (let i = 0; i < ranking.length; i++) {
      const p = ranking[i];
      const userId = typeof p.id === 'string' && p.id.startsWith('u:')
        ? parseInt(p.id.slice(2), 10) : null;
      await pool.query(
        'INSERT INTO game_scores (result_id, user_id, player_name, score, rank) VALUES ($1, $2, $3, $4, $5)',
        [resultId, userId, p.name, p.score || 0, i + 1]
      );
    }
  } catch (e) {
    console.error('saveGameResult failed:', e.message);
  }
}

// Initialization (can create the tables automatically on the first production startup; on Supabase you can also run schema.sql by hand)
async function ensureSchema() {
  if (!usePg) { console.log('📦 No DATABASE_URL, using in-memory storage (development mode)'); return; }
  const fs = require('fs');
  const path = require('path');
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('🐘 Postgres schema ready');
}

module.exports = { usePg, createUser, loginUser, saveGameResult, ensureSchema };
