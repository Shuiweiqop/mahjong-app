# Adding or changing a game

Read this before touching anything under `server/games/` or any `client/src/*Game.jsx` view.
A game is a self-contained plugin: **one backend module + one frontend view + two registration
lines.** The platform (rooms, sockets, lobby, auth) never changes when you add a game.

## The three-plus-two you touch

1. `server/games/<id>/index.js` — the module (pure logic, no socket/db imports).
2. Register it in `server/games/registry.js` (one line: `[mod.id]: mod`).
3. `client/src/<Xxx>Game.jsx` — the view component.
4. Register it in `GAME_VIEWS` in `client/src/GameRoom.jsx` (one line, keyed by `gameId`).
5. (If the host configures it) a `configSchema` on the module + UI in `client/src/LobbySettings.jsx`.

Existing modules to copy from: `server/games/drawguess/` (timers, scoring, ranking) and
`server/games/werewolf/` (roles, multi-phase state machine, per-role hidden info).

## The backend interface (server-authoritative)

The module exports these. `applyAction` and `serializeStateFor` are where correctness lives.

```
id, displayName, minPlayers, maxPlayers          // metadata for the lobby
configSchema?                                     // optional host settings

createInitialState(players, config) -> state      // players: [{id, name}]
applyAction(state, action, playerId) -> { state, events, error }
serializeStateFor(state, playerId) -> view        // per-player; the info-hiding boundary
isGameOver(state) -> { over, ranking|winner, ... } | false
```

### `applyAction` — the only place a rule may be enforced

The client sends `{ type, ...payload }`; a player can forge **any** message with any `playerId`
effectively of their choosing (they control their own socket). So every precondition is checked
here, server-side:

- **Authority**: `if (playerId !== state.hostId) return { error: '...' }` for host-only actions.
- **Phase**: reject actions that don't belong to the current `phase` (`state.phase !== 'night'` …).
- **Liveness / role**: e.g. only a living wolf may `wolf_kill`; only the drawer may `pick`.
- Return `{ error }` to reject (the client shows it via the `act` callback). Return
  `{ state, events }` on success. `events` are non-hidden increments broadcast to the whole room
  (strokes, chat, `game_over`); see `broadcastState` in `server/server.js` for the event types.

Never add a `type: 'tick'` alternative that trusts a client clock — the **server** drives time via
`ensureTimer` in `server/server.js`, calling `applyAction(state, { type: 'tick' }, null)` each
second. If your game has deadlines, advance them in the `tick` case, not on client input.

### `serializeStateFor` — the info-hiding boundary (get this wrong = silent leak)

The full `state` contains everything secret: `state.roles` (who's a wolf), `state.word` (the answer).
**This object is never sent to a client.** Clients receive only what this function returns for their
`playerId`. The platform enforces this by only ever calling `serializeStateFor` in `broadcastState`
— but *your function* decides what each player sees. The pattern (from `werewolf/index.js`):

```js
function serializeStateFor(s, playerId) {
  const view = { phase: s.phase, /* public fields only */ };
  if (s.roles[playerId] === ROLE.WOLF) view.wolfTeammates = /* … */;   // wolves see each other
  if (s.roles[playerId] === ROLE.SEER) view.seerResults = /* … */;      // seer sees own checks
  if (s.phase === 'ended') view.roles = s.roles;                        // reveal only at the end
  return view;
}
```

**Rule of thumb: build the view by allow-list, never by copying `state` and deleting fields.**
When you add a field to `state`, the default must be "not in the view unless I explicitly add it
for the roles allowed to see it." A `return { ...state }` here leaks every secret and nothing turns
red — no test, no lint, no type error catches it. In drawguess this is why the guesser gets
`wordLength` (a number) during the draw phase while the drawer gets `word` (the answer).

If you're changing what a player can see, this function is the diff. Cross-check it against
`isGameOver` (which may also expose `roles`/`ranking` at game end).

## The frontend view

Registered in `GAME_VIEWS`, rendered by `GameRoom.jsx`. Receives props
`{ state, act, me, socket, onLeave }`:

- `state` — the **already-serialized** per-player view (never the raw server state). Render only
  from here; if a field you need isn't present, add it to `serializeStateFor` for the right role,
  don't work around it on the client.
- `act(action)` — emits `game_action`; the server validates and may reply with `{ error }` (shown
  via `alert`). This is your only channel for player intent.
- Direct `socket.current.emit(...)` is for non-hidden increments the server rebroadcasts (e.g.
  strokes), matching the `events` types in `broadcastState`.

The lobby, room code, member list, kick, host-start, and "unknown game type" fallback are all
handled by `GameRoom.jsx` generically — your view only renders the in-progress game.

## Checklist for a state-shape change

Changing `state` almost always spans all of: the module's `applyAction`, its `serializeStateFor`
(does each role's view still expose the right fields?), and the frontend view (does it read the new
field?). Touch one, check all three. A new secret field that isn't gated in `serializeStateFor` is
a leak; a new public field the view doesn't read is a no-op that looks like a bug.
