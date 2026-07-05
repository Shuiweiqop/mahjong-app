# Playground — Real-Time Multiplayer Game Platform · Setup Guide

An extensible real-time multiplayer game platform with two built-in games:
- **Draw & Guess** — real-time canvas sync, configurable word bank / rounds, guess-to-score.
- **Werewolf** — multi-phase state machine (night / day / vote), per-role information hiding
  (wolves see teammates, seer sees check results, villagers see only public info).

Both are **server-authoritative**. The host can configure the game in the lobby
(rounds / timer / word categories / custom words), kick players, and transfer host.
There is also an optional **Mahjong fan calculator** tool page (algorithm demo).

The architecture supports plugging in more games — a new game = one backend module
+ one frontend view component + one registry line.

---

## Tech Stack

| Layer | Tech | Host (production) |
|-------|------|-------------------|
| Frontend | React 19 + Vite | **Vercel** |
| Backend | Node.js + Express + **Socket.io** | **Render** |
| Database | PostgreSQL | **Supabase** |
| Auth | JWT (login) + guest mode | — |

**Architecture seam**: a generic layer (lobby / rooms / realtime / auth) plus a
pluggable game-module interface. Each game implements a shared interface on both ends:
- **Backend module**: `createInitialState(players, config)` /
  `applyAction(state, action, playerId)` / `serializeStateFor(state, playerId)`
  (per-player view for information hiding) / `isGameOver(state)`, plus optional
  `configSchema` (host settings). Register it in `server/games/registry.js`.
- **Frontend view component**: receives `state / act / me / socket`; register one line
  in `GAME_VIEWS` inside `client/src/GameRoom.jsx` (dispatched by `gameId`).

```
mahjong-app/
├── client/                   Frontend (Vite + React)
│   └── src/
│       ├── App.jsx           Top level: auth → lobby → room + socket connection
│       ├── AuthScreen.jsx    Login / register / guest
│       ├── Lobby.jsx         Pick game + create/join room + calculator entry
│       ├── LobbySettings.jsx Host lobby settings (rounds / timer / words / custom)
│       ├── GameRoom.jsx      Room router: generic lobby + dispatch by gameId
│       ├── DrawGuessGame.jsx Draw & Guess view (canvas / guessing / scores / timer)
│       ├── DrawCanvas.jsx    Canvas brush + batched real-time stroke sync
│       ├── WerewolfGame.jsx  Werewolf view (role card / night actions / vote / reveal)
│       ├── CalculatorScreen.jsx  Mahjong fan calculator (optional tool page)
│       ├── calculator/       Mahjong algorithm (pure logic: parse/decompose/score/tenpai)
│       └── config.js         Reads VITE_API_BASE (backend URL)
└── server/                   Backend (Express + Socket.io)
    ├── server.js             Entry: REST (auth/games) + Socket.io (rooms/game/set_config/kick)
    ├── db.js                 Storage layer: Postgres if DATABASE_URL set, else in-memory
    ├── rooms.js              Room manager (in-memory): create/join/leave/kick/host-transfer/config
    ├── schema.sql            Postgres schema script
    ├── routes/auth.js        register / login / me
    └── games/
        ├── registry.js       Game registry
        ├── drawguess/        Draw & Guess module (logic + word bank + host config)
        └── werewolf/         Werewolf module (roles / phase state machine / info hiding / win)
```

---

## 1. Local Development (no database, fastest)

When `DATABASE_URL` is unset, the backend falls back to **in-memory storage** — no
database needed for local dev.

**Prerequisite**: Node.js 18+ (developed on v22).

```bash
# 1. Install dependencies
cd server && npm install
cd ../client && npm install

# 2. Start the backend (terminal 1)
cd server && npm start          # → http://localhost:3001
#   Success when you see "📦 无 DATABASE_URL, 使用内存存储" + "🎮 ... 运行于"

# 3. Start the frontend (terminal 2)
cd client && npm run dev        # → http://localhost:5173
```

**Try it**: open `http://localhost:5173` → enter as guest → pick a game and create a room;
open an **incognito window** at the same URL → join with the room code → host starts.
- Draw & Guess: 2+ players, pick a word / draw / guess.
- Werewolf: 4+ players (open a few more incognito windows), night actions → day vote.

> The frontend defaults to `http://localhost:3001` locally (see `client/.env.development`).

---

## 2. Cloud Deployment (free: Supabase + Render + Vercel)

### 1. Supabase (database)
1. https://supabase.com → New project (**save the DB password**).
2. **SQL Editor** → paste all of `server/schema.sql` → Run (creates 3 tables).
   - When prompted about RLS, choose **Run without RLS** (only the backend accesses
     the DB via connection string, so RLS is unnecessary here).
3. Top **Connect** → **Direct** → choose **Session pooler** → copy the URI:
   ```
   postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
   ```
   Replace `<password>` with your DB password (**remove the square brackets**).
   This is your `DATABASE_URL`.

### 2. Render (backend)
1. https://render.com → connect GitHub → New **Web Service** → select this repo (branch `main`).
2. Settings:
   - **Root Directory**: `server`
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Instance Type: **Free**
3. Environment variables (see table below).
4. Deploy, note the backend URL, e.g. `https://xxx.onrender.com`.
5. Verify: open `https://xxx.onrender.com/api/health` → `{"ok":true}`.

> Free instances spin down when idle; first request after that takes ~30-50s to wake.
> You can keep it warm by pinging `/api/health` every 5 min with UptimeRobot.

### 3. Vercel (frontend)
1. https://vercel.com → connect GitHub → Import this repo (branch `main`).
2. Settings:
   - **Root Directory**: `client`
   - Framework: Vite (auto-detected)
   - Environment variable: `VITE_API_BASE` = the Render backend URL (**no trailing slash**).
3. Deploy, get the frontend URL, e.g. `https://xxx.vercel.app`.
4. **Back in Render**, set `CLIENT_ORIGIN` to that Vercel URL and redeploy (tightens CORS).

---

## 3. Environment Variables

### Backend (Render)
| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | Supabase connection string (with password). **Empty → in-memory storage.** | `postgresql://postgres.xxx:pwd@...pooler.supabase.com:5432/postgres` |
| `JWT_SECRET` | JWT signing key, long random string | Render can auto-generate |
| `CLIENT_ORIGIN` | Allowed frontend origin(s), comma-separated. **Empty → allow all.** | `https://xxx.vercel.app` |
| `PORT` | Listen port (injected by Render; 3001 locally) | `3001` |

### Frontend (Vercel / local `client/.env.development`)
| Variable | Description | Example |
|----------|-------------|---------|
| `VITE_API_BASE` | Backend URL (no trailing slash) | `https://xxx.onrender.com` |

> ⚠️ `.env` is in `.gitignore` — **never commit a connection string containing a password.**

---

## 4. Troubleshooting (lessons learned)

| Symptom | Cause | Fix |
|---------|-------|-----|
| `password authentication failed for user "postgres"` | Square brackets left around the password, wrong password, or username missing the `.project-ref` suffix | Re-copy the full Session-pooler string from Supabase Connect; only replace the password, drop the brackets; use an alphanumeric password (avoid `@ / : ?`) |
| Sign-up stuck on "please wait…" / request times out | Free Render instance waking from idle (~30-50s), or a redeploy is in progress | Wait or refresh; check the service is Live in Render |
| `Exited with status 1` | Backend can't connect to the DB on startup | Check `DATABASE_URL`; read the Render deploy logs |
| Frontend loads but can't reach backend / blocked by CORS | `VITE_API_BASE` unset/wrong, or `CLIENT_ORIGIN` doesn't match the frontend domain | Verify both; update `CLIENT_ORIGIN` whenever the Vercel domain changes |
| Local MySQL (XAMPP) won't start, error 10013 | Windows (WSL2/Hyper-V) reserved the port; unrelated to this project | This platform doesn't use MySQL — ignore |

**Successful startup log markers**:
```
🐘 Postgres schema 就绪          # connected to Supabase (production)
🎮 游戏平台服务器运行于 ...        # server running
```
