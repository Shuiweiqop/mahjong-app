# CLAUDE.md

Extensible real-time multiplayer game platform (React + Socket.io); games are pluggable modules.

Two apps in this repo — run commands inside the right one:
- `client/` — Vite + React frontend (`npm run dev`)
- `server/` — Express + Socket.io backend (`npm start`)

Backend runs with no database by default (in-memory fallback); set `DATABASE_URL` for Postgres.

## Adding a game (the core extension point)
A game = one backend module in `server/games/<id>/` implementing the shared interface
(`createInitialState` / `applyAction` / `serializeStateFor` / `isGameOver`), registered in
`server/games/registry.js`, plus one frontend view registered in `GAME_VIEWS` in
`client/src/GameRoom.jsx`. Game state is server-authoritative; per-player views enforce
information hiding.

## More
Architecture, local dev, deployment, env vars, and troubleshooting live in [SETUP.md](SETUP.md).
