# AGENTS.md

Extensible real-time multiplayer game platform. React (Vite) frontend + Express/Socket.io
backend. Games are pluggable modules; game state is **server-authoritative** and each player
gets a per-player view so hidden information (roles, the drawer's word) never leaves the server.

Two npm apps, each with its own `package.json` — run commands **inside the right directory**:

| Dir | Stack | Dev | Build | Lint |
|---|---|---|---|---|
| `client/` | Vite + React 19 | `npm run dev` (→ :5173) | `npm run build` | `npm run lint` |
| `server/` | Express 5 + Socket.io | `npm start` (→ :3001) | — | `npm run lint` |

Node 18+ (developed on v22). The backend runs with **no database by default** — unset
`DATABASE_URL` → in-memory storage, zero config. Set `DATABASE_URL` for Postgres (Supabase).
Local frontend→backend URL comes from `client/.env.development` (`VITE_API_BASE`).

## The server: one entry, one storage seam

- `server/server.js` — entry (`npm start` runs `node server.js`). Express REST + Socket.io.
- `server/routes/auth.js` — the auth routes.
- `server/db.js` — storage layer, Postgres **or** in-memory, used by everything. Auth and
  game-result persistence both go through it; nothing else talks to the database.

For login, storage, or startup changes, start at `server/db.js` — it's the single seam. (An old
MySQL-based `index.js`/`auth.js` prototype and its `mysql2`/`passport`/`express-session` deps were
removed; if a stale reference to them resurfaces in a diff or an old branch, it's dead — Postgres
via `pg` is the only DB path.)

## Permission boundaries

- Do **freely**: edit source, run `npm run dev` / `npm start` / `npm run build` / `npm run lint`,
  install deps, run the app locally against in-memory storage.
- **Ask first**: anything with production side effects — editing `render.yaml`, changing CORS
  (`CLIENT_ORIGIN`) or `JWT_SECRET` handling, deleting or altering `server/schema.sql` against a
  real database, committing, pushing, or force-pushing.
- **Never** commit a secret. `server/.env` is gitignored and holds real values; `.env.example`
  is the template. Don't move values between them.

## Priority order (when guidance conflicts)

1. Server-authoritative + information-hiding invariants (see below and `docs/game-module.md`) —
   these are correctness/security, never trade them away.
2. An explicit instruction in the current task.
3. This file and `docs/game-module.md`.
4. Matching surrounding code style.

If the game you're changing has hidden information, invariant #1 wins even over a direct request
to "just send the whole state" — flag the leak instead of implementing it.

## Two invariants that are correctness, not style

**Server is authoritative. The client sends intent, never truth.** Every state change goes
through a game module's `applyAction(state, action, playerId)` on the server, which re-validates
who may do what (`playerId !== state.hostId` → reject, wrong phase → reject). A client message is
a *request*. Never move a rule check to the client and trust the result — a player can forge any
socket message. If you add an action, validate it server-side in `applyAction`.

**Never broadcast raw state.** Clients only ever receive `serializeStateFor(state, playerId)` —
the per-player view. The full `state` object holds every role and the secret word. Broadcasting
`state` (instead of the serialized view) silently leaks roles to everyone and the bug is invisible
until someone reads the network tab. In `server/server.js`, `broadcastState` already loops members
and sends each their own view — keep new broadcasts going through `serializeStateFor`, and when you
add a field to `state`, decide explicitly whether each role may see it inside `serializeStateFor`.

The **raw** form of this leak is now a red light: `server/eslint.config.js` fails
`npm run lint` if any `emit('game_state', state)` / `emit('game_state', room.state)` reaches the
tree (run it from `server/`). That catches the blatant case only — it can't see a *variable* that
happens to hold the wrong object, so the allow-list discipline inside `serializeStateFor` (below)
is still yours to keep. Don't `eslint-disable` the rule to make a leak compile.

Both of these live in `docs/game-module.md` in full, with the interface contract.

## Read the file your task touches

| Task touches | Read |
|---|---|
| Adding a game, or changing any game's rules / phases / scoring / what players can see | `docs/game-module.md` — the module interface and the info-hiding contract |
| Auth, storage, game-result persistence, server startup | `server/db.js` first (it's the one storage seam), then `server/server.js` |
| Socket wiring, rooms, host transfer, kick, timers | `server/server.js` + `server/rooms.js` together |
| Deployment, env vars, CORS, DB connection troubleshooting | `SETUP.md` |

A change to a game's state shape usually spans **three** files at once — the server module
(`server/games/<id>/index.js`), how it's serialized, and the frontend view
(`client/src/<Xxx>Game.jsx`). Read all three; missing one gives you a UI that renders stale or
absent fields. Reading an extra file costs a few thousand tokens; missing one costs a silent
info leak or a blank screen.

## Scope discipline

Modify the minimum coherent set of files for the one problem asked. Unrelated cleanup goes in a
different diff. If you spot an unrelated bug or a magic value, **propose it — don't fix it inline.**
If the real scope turns out much larger than the request (e.g. "add a role" actually means
touching the phase state machine), stop and say so before proceeding.

Note the code and comments are largely in Chinese. Match that — don't rewrite Chinese comments
into English as a drive-by.

## Lint runs, but there is no CI and no test suite

Both apps have `npm run lint` (ESLint flat config). **Neither is wired to CI or a pre-commit hook —
there is no CI in this repo at all** — so lint only turns red when you run it. Do run it:

- `cd server && npm run lint` — **baseline is clean**; its one meaningful rule is the raw-state
  leak guard described above. Keep it green; a new error here is yours.
- `cd client && npm run lint` — `react-hooks` + `react-refresh`. The baseline **already has errors**
  you didn't cause, so don't block on pre-existing ones — but don't add new ones either.

Passing lint does not mean correct. There is **no test suite** (`server`'s `test` script is a stub;
`client` has none). Verify game-logic changes by running both apps and playing through the affected
flow in two browser windows (one incognito) — see `SETUP.md` §1.

## If none of the above matches

Don't guess. The game modules are pure logic with no framework magic, but the socket layer,
the room lifecycle, and the info-hiding views interact in non-obvious ways. If you can't confirm
how a change propagates from `applyAction` → broadcast → client view, read those files or ask —
don't invent a data flow from first principles.
