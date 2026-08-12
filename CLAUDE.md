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
- Agent working rules — invariants, the live-vs-legacy server trap, permission boundaries,
  and the game-module contract — are in [AGENTS.md](AGENTS.md), [docs/game-module.md](docs/game-module.md),
  and [docs/rooms-and-sockets.md](docs/rooms-and-sockets.md). Read AGENTS.md first.
- Architecture, local dev, deployment, env vars, and troubleshooting live in [SETUP.md](SETUP.md).
