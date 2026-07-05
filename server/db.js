// 数据库层 —— Postgres(Supabase)持久化,带内存降级。
//
// 若设置了 DATABASE_URL(线上/Supabase) → 用 Postgres。
// 否则(本地开发无数据库) → 用内存 Map,零配置即可跑。
// 上层(auth / 战绩)调用同一组异步方法,不感知底层实现。

const bcrypt = require('bcryptjs');

const DATABASE_URL = process.env.DATABASE_URL;
const usePg = !!DATABASE_URL;

let pool = null;
if (usePg) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Supabase 需要 SSL
  });
}

// ── 内存降级存储 ──
const mem = { users: new Map(), nextUserId: 1 };

// ── 用户 ──
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
      if (e.code === '23505') return { error: '邮箱已注册' }; // unique_violation
      throw e;
    }
  }
  if (mem.users.has(email)) return { error: '邮箱已注册' };
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
  if (!record) return { error: '邮箱或密码错误' };
  const hash = record.password_hash || record.passwordHash;
  const ok = await bcrypt.compare(password, hash);
  if (!ok) return { error: '邮箱或密码错误' };
  return { user: { id: record.id, email: record.email, name: record.name } };
}

// ── 战绩(登录用户才写;失败不影响游戏) ──
async function saveGameResult(gameId, roomCode, ranking) {
  if (!usePg) return; // 内存模式不持久化战绩
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

// 初始化(线上首启时可自动建表;Supabase 也可手工跑 schema.sql)
async function ensureSchema() {
  if (!usePg) { console.log('📦 无 DATABASE_URL,使用内存存储(开发模式)'); return; }
  const fs = require('fs');
  const path = require('path');
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('🐘 Postgres schema 就绪');
}

module.exports = { usePg, createUser, loginUser, saveGameResult, ensureSchema };
