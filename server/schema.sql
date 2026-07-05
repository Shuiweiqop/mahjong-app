-- 多人游戏平台 —— Postgres 建表脚本(Supabase 可直接执行)
-- 在 Supabase 控制台 → SQL Editor 粘贴运行。

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 对局记录(每局结束存一条,用于战绩/排行榜)
CREATE TABLE IF NOT EXISTS game_results (
  id          SERIAL PRIMARY KEY,
  game_id     TEXT NOT NULL,           -- 'drawguess' 等
  room_code   TEXT,
  finished_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 单局中每个玩家的得分(登录用户才计入 user_id;访客 user_id 为 NULL)
CREATE TABLE IF NOT EXISTS game_scores (
  id         SERIAL PRIMARY KEY,
  result_id  INTEGER NOT NULL REFERENCES game_results(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  player_name TEXT NOT NULL,
  score      INTEGER NOT NULL DEFAULT 0,
  rank       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_game_scores_user ON game_scores(user_id);
CREATE INDEX IF NOT EXISTS idx_game_scores_result ON game_scores(result_id);
