# AGENTS.md

Extensible real-time multiplayer game platform. React (Vite) frontend + Express/Socket.io
backend. Games are pluggable modules; game state is server-authoritative and each player gets a
per-player view, so hidden information (roles, the drawer's word) never leaves the server.

Two npm apps, each with its own `package.json` — run commands **inside the right directory**:

| Dir | Stack | Dev | Build | Checks |
|---|---|---|---|---|
| `client/` | Vite + React 19 | `npm run dev` (→ :5173) | `npm run build` | `npm run lint` |
| `server/` | Express 5 + Socket.io | `npm start` (→ :3001) | — | `npm run check` (lint + test) |

Node 18+ (developed on v22.12). The backend runs with **no database by default** — unset
`DATABASE_URL` → in-memory storage, zero config. Set `DATABASE_URL` for Postgres (Supabase).
The local frontend→backend URL comes from `client/.env.development` (`VITE_API_BASE`).

There is **no CI in this repo and no git hooks** — `.github/` does not exist. Nothing runs
automatically on commit or push. `server`'s checks are only red if you run them, so run them.

## The server: one entry, one storage seam

- `server/server.js` — entry (`npm start` runs `node server.js`). Express REST + Socket.io.
- `server/routes/auth.js` — the auth routes.
- `server/db.js` — storage layer, Postgres **or** in-memory, used by everything. Auth and
  game-result persistence both go through it; nothing else talks to the database.

For login, storage, or startup changes, start at `server/db.js` — it's the single seam. An old
MySQL-based `index.js`/`auth.js` prototype and its `mysql2`/`passport`/`express-session` deps were
removed; if a stale reference to them resurfaces in a diff or an old branch, it's dead — Postgres
via `pg` is the only DB path.

## Permission boundaries

- Do **freely**: edit source, run `npm run dev` / `npm start` / `npm run build` / `npm run lint` /
  `npm test`, install deps, run the app locally against in-memory storage.
- **Ask first**: anything with production side effects — editing `render.yaml`, changing CORS
  (`CLIENT_ORIGIN`) or `JWT_SECRET` handling, running `server/schema.sql` against a real database,
  committing, pushing, or force-pushing.
- **Never** commit a secret. `server/.env` is gitignored and holds real values; `.env.example` is
  the template. Don't move values between them.

`JWT_SECRET` has no fallback value on purpose. With `DATABASE_URL` set (treated as production)
the server refuses to start without it; locally it generates a random one per boot. Never
reintroduce a hardcoded default to "make it run" — a secret committed to an open repo lets anyone
sign a token for any user, and nothing about the running service would look wrong.

## Priority order (when guidance conflicts)

1. The information-hiding and server-authority invariants below — these are correctness and
   security, never trade them away.
2. An explicit instruction in the current task.
3. This file and the files in `docs/`.
4. Matching surrounding code style.

If the game you're changing has hidden information, #1 wins even over a direct request to "just
send the whole state" — flag the leak instead of implementing it.

## The one invariant worth all the bold in this file

**Clients receive only `serializeStateFor(state, playerId)` — never the raw `state`.** The full
state object holds every role and the secret word. Send it and you leak the entire game to
everyone, and *nothing turns red*: no crash, no failing request, no visible bug. The game just
quietly stops being a game, and nobody notices until someone opens the network tab.

Two mechanisms now catch the common shapes of this mistake, and neither is complete:

- `server/eslint.config.js` fails `npm run lint` on a literal `emit('game_state', state)` or
  `emit('game_state', room.state)`. It cannot see a *variable* that happens to hold the wrong object.
- `server/games/contract.test.js` fails `npm test` if a module's `serializeStateFor` copies the
  whole state (a canary field survives into the view), or if an unknown player id gets back
  `roles`/`myRole`.

What neither can check is the judgment call: **when you add a field to `state`, decide explicitly
which roles may see it** inside `serializeStateFor`. Build the view by allow-list — never by
spreading `state` and deleting the secrets. Don't `eslint-disable` the rule or edit the test to
make a leak pass; if a check is in your way, the check is probably right.

The other half of correctness: **the server is authoritative — the client sends intent, never
truth.** Every state change goes through `applyAction(state, action, playerId)` on the server,
which re-validates who may do what. A client message is a *request*; a player can forge any socket
message. Never move a rule check to the client and trust the result.

## Read the file your task touches. When unsure, read it.

| Task touches | Read |
|---|---|
| Adding a game, or changing any game's rules, phases, scoring, or what players can see | `docs/game-module.md` — the module interface and the info-hiding contract |
| Join/rejoin, spectators, host transfer, kick, timers, countdown, chat channels | `docs/rooms-and-sockets.md` — then `server/server.js` + `server/rooms.js` together |
| Auth, storage, game-result persistence, server startup | `server/db.js` first (the one storage seam), then `server/server.js` |
| Deployment, env vars, CORS, DB connection troubleshooting | `SETUP.md` |

Changes spanning several areas — especially anything that alters a game's **state shape** — need
all the relevant files. A state-shape change usually spans **three** at once: the server module
(`server/games/<id>/index.js`), its `serializeStateFor`, and the frontend view
(`client/src/<Xxx>Game.jsx`). Reading an extra file costs a few thousand tokens; missing one costs
a silent info leak or a blank screen.

## Scope discipline

Modify the minimum coherent set of files for the one problem asked. Unrelated cleanup goes in a
different diff. If you spot an unrelated bug or a magic value, **propose it — don't fix it inline.**
If the real scope turns out much larger than the request (e.g. "add a role" actually means touching
the phase state machine), stop and say so before proceeding.

The code and comments are largely in Chinese. Match that — don't rewrite Chinese comments into
English as a drive-by.

## Verifying a change

`npm run check` in `server/` (lint + contract tests) and `npm run lint` in `client/`.

- **`server` lint and tests are both clean at baseline.** A new failure is yours.
- **`client` lint already has 4 pre-existing errors** (`react-hooks/refs` in `DrawCanvas.jsx`,
  `react-hooks/set-state-in-effect` in `Lobby.jsx`). Don't block on them; don't add more.

77 tests across four files: `games/contract.test.js` (module interface + info-hiding),
`games/werewolf/rules.test.js`, `games/drawguess/rules.test.js`, `routes/auth.test.js`.

Passing these does not mean correct. **Nothing on the client is tested** — no component renders in
any test, so every animation, disabled button, and phase panel is unverified by CI. The socket
layer (`server.js`) and room lifecycle (`rooms.js`) have no direct tests either; they're only
exercised indirectly. Verify game-logic changes by running both apps and playing through the
affected flow in two browser windows (one incognito) — see `SETUP.md` §1. Append `?guest=<name>`
to the URL to sit at multiple seats in one browser.

When you fix a rules bug, add the test that would have caught it, then **verify the test actually
fails against the old behaviour** — reintroduce the bug, watch it go red, restore. A test that
passes both before and after your fix proves nothing, and it is easy to write one by accident
(a mis-applied patch or a typo'd assertion looks identical to a passing suite).

## If none of the above matches

Don't guess. The game modules are pure logic with no framework magic, but the socket layer, the
room lifecycle, and the info-hiding views interact in non-obvious ways. If you can't confirm how a
change propagates from `applyAction` → broadcast → client view, read those files or ask — don't
invent a data flow from first principles, and don't answer from what a project like this one
usually does.
