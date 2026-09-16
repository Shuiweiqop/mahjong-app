// Multiplayer game platform —— server entry point.
// Express (REST: auth + game list) + Socket.io (real-time matches, server-authoritative).
// Database: with DATABASE_URL use Postgres (Supabase), otherwise fall back to memory (see db.js).
//
// Convention for returned errors: what goes inside { error } is an **error code**
// (such as 'room.notInRoom'), not human-readable copy.
// The server does not know what language the user interface is in, so the copy is looked up
// by the frontend from the code (the err.* entries in client/src/i18n.jsx).
// When adding an error: add the code here → add one entry to each of the frontend's two language
// tables, otherwise the interface will display the error code itself.

const express = require('express');
const http = require('http');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
require('dotenv').config();

const { router: authRouter, JWT_SECRET } = require('./routes/auth');
const { listGames } = require('./games/registry');
const roomsMgr = require('./rooms');
const db = require('./db');

const PORT = process.env.PORT || 3001;
// CORS: in production use the CLIENT_ORIGIN allow-list (comma-separated); if unset, allow all (local development)
const ORIGINS = process.env.CLIENT_ORIGIN
  ? process.env.CLIENT_ORIGIN.split(',').map((s) => s.trim())
  : '*';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: ORIGINS } });

app.use(cors({ origin: ORIGINS }));
app.use(express.json());
app.use('/api/auth', authRouter);
app.get('/api/games', (req, res) => res.json(listGames()));
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ── Socket authentication: allow logged-in users (with a token) or guests (with a guest identity) ──
io.use((socket, next) => {
  const { token, guestName, guestId } = socket.handshake.auth || {};
  if (token) {
    try {
      const u = jwt.verify(token, JWT_SECRET);
      socket.user = { id: `u:${u.id}`, name: u.name };
      return next();
    } catch {
      /* fall through to guest */
    }
  }
  if (guestName) {
    // Prefer the guestId the client persisted: the id stays the same across a reconnect,
    // so the guest can sit back down in their original seat.
    // When an older client sends no guestId, fall back to socket.id (a reconnect then means
    // a new identity, which matches the old behavior).
    const stable = typeof guestId === 'string' && /^[\w-]{1,64}$/.test(guestId);
    socket.user = { id: `g:${stable ? guestId : socket.id}`, name: guestName };
    return next();
  }
  // Same as cb({error}): pass an error code, which the frontend looks up for display (see the err.* entries in client/src/i18n.jsx)
  next(new Error('auth.needLoginOrGuest'));
});

// ── Broadcast room state (each player receives their own view, so information stays isolated) ──
// A player view = the game module's role-specific view + room-level spectator info (so players know who is watching).
// Shared by sync and broadcastState, to avoid assembling it twice in two places and letting the fields drift apart.
function playerViewFor(room, playerId) {
  const view = room.game.serializeStateFor(room.state, playerId);
  view.spectators = room.spectators;
  view.spectatorGodView = room.spectatorGodView;
  return view;
}

function broadcastState(room, extraEvents = []) {
  for (const m of room.members) {
    io.to(socketIdOf(room, m.id)).emit('game_state', playerViewFor(room, m.id));
  }
  // Spectators: one shared public view (identities are attached only if the host enabled god view)
  if (room.spectators.length) {
    const specView = roomsMgr.spectatorViewFor(room);
    for (const s of room.spectators) {
      io.to(socketIdOf(room, s.id)).emit('game_state', specView);
    }
  }
  // Broadcast the non-isolated incremental events (strokes / chat / correct-guess notices, etc.) to the whole room
  for (const ev of extraEvents) {
    if (ev.type === 'stroke') {
      // A batch of strokes is sent only to the non-drawers (the drawer has already drawn them locally)
      socketsExcept(room, room.state.drawerId).forEach((sid) =>
        io.to(sid).emit('stroke', ev.strokes)
      );
    } else if (ev.type === 'clear') {
      io.to(room.code).emit('clear');
    } else if (ev.type === 'chat') {
      // No channel marked → public to the whole room (draw & guess).
      // 'alive' → also a public message (living players discussing during the day), visible to the whole room.
      // 'dead'  → the dead channel: sent only to the dead players + spectators, invisible to living players (to prevent spoilers).
      if (ev.channel === 'dead') {
        deadChannelSockets(room).forEach((sid) =>
          io.to(sid).emit('chat', { playerId: ev.playerId, text: ev.text, channel: 'dead' }));
      } else {
        io.to(room.code).emit('chat', { playerId: ev.playerId, text: ev.text, channel: ev.channel || 'alive' });
      }
    } else if (ev.type === 'guessed') {
      io.to(room.code).emit('guessed', { playerId: ev.playerId, points: ev.points });
    } else if (ev.type === 'reveal') {
      io.to(room.code).emit('reveal', { word: ev.word, reason: ev.reason });
    } else if (ev.type === 'game_over') {
      io.to(room.code).emit('game_over');
      // Save the match record (only logged-in users get a user_id; in memory mode the db layer simply skips this)
      const over = room.game.isGameOver(room.state);
      if (over && over.ranking) db.saveGameResult(room.gameId, room.code, over.ranking);
    }
  }
}

// Socket id mapping: member.id -> that member's socket id
const memberSockets = new Map(); // roomCode -> Map(memberId -> socketId)
function socketIdOf(room, memberId) {
  return memberSockets.get(room.code)?.get(memberId);
}
function socketsExcept(room, exceptMemberId) {
  const map = memberSockets.get(room.code);
  if (!map) return [];
  return [...map.entries()].filter(([mid]) => mid !== exceptMemberId).map(([, sid]) => sid);
}

// Recipients of the dead channel: players who are already out + all spectators. Living players are excluded (to prevent spoilers).
// Alive/dead is decided from the game state's alive table; spectators are not in state.alive, so they are merged in separately.
function deadChannelSockets(room) {
  const map = memberSockets.get(room.code);
  if (!map || !room.state) return [];
  const alive = room.state.alive || {};
  const specIds = new Set(room.spectators.map((s) => s.id));
  return [...map.entries()]
    .filter(([mid]) => specIds.has(mid) || alive[mid] === false)
    .map(([, sid]) => sid);
}
function bindSocket(room, memberId, socketId) {
  if (!memberSockets.has(room.code)) memberSockets.set(room.code, new Map());
  memberSockets.get(room.code).set(memberId, socketId);
}

// Whether the room has no connections at all (no players, no eliminated players, no spectators online).
// "Whether the clock should stop" depends on whether anyone is still watching —— that is information only the
// transport layer has; the game module can only see "whether anyone can still act", and the two are not
// equivalent, so they must not be used interchangeably.
function roomIsEmpty(room) {
  return (memberSockets.get(room.code)?.size || 0) === 0;
}

// Stop the clock: clear the per-second tick, and have the game module suspend the deadline
// (an absolute timestamp, which would otherwise keep running while the clock is stopped)
function pauseRoomClock(room) {
  roomsMgr.clearTimer(room);
  if (room.state && room.game.pauseClock) room.game.pauseClock(room.state);
}

// Resume: reset the deadline from the remaining duration recorded when it was suspended, then restart the tick
function resumeRoomClock(room) {
  if (!room.state || room.state.phase === 'ended') return;
  if (room.game.resumeClock) room.game.resumeClock(room.state);
  ensureTimer(room);
}

// ── Reconnect grace period ──
// When someone drops, do not remove them from the room immediately; leave a window for them
// to reconnect into their original seat.
// Only if they fail to return before the timeout do they really leave (that is when the slot is
// released and the host is transferred if necessary).
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) || 60 * 1000;
const dropTimers = new Map(); // `${roomCode}:${memberId}` -> timeout

function cancelDrop(roomCode, memberId) {
  const key = `${roomCode}:${memberId}`;
  const t = dropTimers.get(key);
  if (t) { clearTimeout(t); dropTimers.delete(key); }
}

function scheduleDrop(roomCode, memberId) {
  cancelDrop(roomCode, memberId);
  const key = `${roomCode}:${memberId}`;
  dropTimers.set(key, setTimeout(() => {
    dropTimers.delete(key);
    const room = roomsMgr.getRoom(roomCode);
    if (!room) return;
    // If they reconnected in the meantime, do not remove them after all
    if (socketIdOf(room, memberId)) return;
    const events = roomsMgr.leaveRoom(roomCode, memberId) || [];
    const still = roomsMgr.getRoom(roomCode);
    if (!still) return;                       // room is already empty → already destroyed
    // Still nobody online when the grace period ends (both players and spectators are gone): the match
    // cannot possibly continue, so destroy the room and release its resources.
    // It must not be deleted while spectators are still watching —— otherwise they would be stuck in a
    // room that no longer exists.
    if ((memberSockets.get(roomCode)?.size || 0) === 0 && still.spectators.length === 0) {
      roomsMgr.clearTimer(still);
      memberSockets.delete(roomCode);
      roomsMgr.rooms.delete(roomCode);
      return;
    }
    still.state ? broadcastState(still, events) : broadcastLobby(still);
  }, RECONNECT_GRACE_MS));
}

// ── Timer: ticks once per second, advancing the word-choosing / drawing / reveal phases ──
function ensureTimer(room) {
  if (room.timer) return;
  room.timer = setInterval(() => {
    if (!room.state) return;
    const before = room.state.phase;
    const { events } = room.game.applyAction(room.state, { type: 'tick' }, null);
    if (events && events.length) broadcastState(room, events);
    else if (room.state.phase !== before) broadcastState(room);
    if (room.state.phase === 'ended') roomsMgr.clearTimer(room);
  }, 1000);
}

io.on('connection', (socket) => {
  const user = socket.user;

  // Once the frontend has entered the room screen and registered its listeners, it actively pulls the current state once, so it does not miss the first broadcast sent when it joined (a race)
  socket.on('sync', () => {
    const room = roomsMgr.getRoom(socket.data.roomCode);
    if (!room) return;
    if (room.state) {
      const isSpec = room.spectators.some((s) => s.id === user.id);
      socket.emit('game_state', isSpec
        ? roomsMgr.spectatorViewFor(room)
        : playerViewFor(room, user.id));
    } else {
      socket.emit('lobby', lobbyPayload(room));
    }
  });

  socket.on('create_room', ({ gameId }, cb) => {
    const { room, error } = roomsMgr.createRoom(gameId, user);
    if (error) return cb?.({ error });
    socket.join(room.code);
    bindSocket(room, user.id, socket.id);
    socket.data.roomCode = room.code;
    cb?.({ roomCode: room.code, hostId: room.hostId, playerId: user.id });
    broadcastLobby(room);
  });

  socket.on('join_room', ({ roomCode }, cb) => {
    const { room, error, events: rejoinEvents, spectator } = roomsMgr.joinRoom(roomCode, user);
    if (error) return cb?.({ error });
    socket.join(room.code);
    bindSocket(room, user.id, socket.id);
    socket.data.roomCode = room.code;
    cancelDrop(room.code, user.id);   // reconnected successfully → cancel the pending removal
    cb?.({ roomCode: room.code, hostId: room.hostId, playerId: user.id, spectator: !!spectator });
    if (room.state) {
      // Resume the countdown before broadcasting, so what the client receives is the already-reset deadline
      resumeRoomClock(room);
      broadcastState(room, rejoinEvents || []);
    } else broadcastLobby(room);
  });

  // The host updates the game configuration in the lobby
  socket.on('set_config', ({ config }, cb) => {
    const room = roomsMgr.getRoom(socket.data.roomCode);
    if (!room) return cb?.({ error: 'room.notInRoom' });
    if (user.id !== room.hostId) return cb?.({ error: 'room.hostOnlySettings' });
    if (room.state) return cb?.({ error: 'room.alreadyStarted' });
    room.config = { ...room.config, ...config };
    cb?.({ ok: true });
    broadcastLobby(room); // broadcast to everyone, to keep the displayed settings in sync
  });

  // The host toggles "spectator god view" (can be changed at any time, in the lobby or mid-match)
  socket.on('set_spectator_godview', ({ enabled }, cb) => {
    const room = roomsMgr.getRoom(socket.data.roomCode);
    if (!room) return cb?.({ error: 'room.notInRoom' });
    if (user.id !== room.hostId) return cb?.({ error: 'room.hostOnlySettings' });
    room.spectatorGodView = !!enabled;
    cb?.({ ok: true });
    if (room.state) broadcastState(room); else broadcastLobby(room);
  });

  // The host kicks someone (lobby phase only)
  socket.on('kick_player', ({ playerId }, cb) => {
    const room = roomsMgr.getRoom(socket.data.roomCode);
    if (!room) return cb?.({ error: 'room.notInRoom' });
    if (user.id !== room.hostId) return cb?.({ error: 'room.hostOnlyKick' });
    if (room.state) return cb?.({ error: 'room.noKickInGame' });
    if (playerId === room.hostId) return cb?.({ error: 'room.noKickSelf' });

    const kickedSid = socketIdOf(room, playerId);
    memberSockets.get(room.code)?.delete(playerId);
    cancelDrop(room.code, playerId);
    roomsMgr.leaveRoom(room.code, playerId);   // lobby phase only, so there are no match events
    cb?.({ ok: true });

    // Notify the kicked player and make them leave the socket room
    if (kickedSid) {
      io.to(kickedSid).emit('kicked');
      io.sockets.sockets.get(kickedSid)?.leave(room.code);
    }
    const still = roomsMgr.getRoom(room.code);
    if (still) broadcastLobby(still);
  });

  // The host starts a rematch: after the match ends, clear back to the lobby and reuse the lobby/start flow
  socket.on('rematch', (cb) => {
    const room = roomsMgr.getRoom(socket.data.roomCode);
    if (!room) return cb?.({ error: 'room.notInRoom' });
    if (user.id !== room.hostId) return cb?.({ error: 'room.hostOnlyRematch' });
    if (!room.state || room.state.phase !== 'ended') return cb?.({ error: 'room.notEnded' });
    roomsMgr.resetToLobby(room);
    cb?.({ ok: true });
    broadcastLobby(room);   // everyone (including the promoted spectators) goes back to the lobby
  });

  socket.on('game_action', ({ action }, cb) => {
    const room = roomsMgr.getRoom(socket.data.roomCode);
    if (!room) return cb?.({ error: 'room.notInRoom' });
    // Spectators can only watch: no voting, acting, starting, or any other action is allowed
    if (room.spectators.some((s) => s.id === user.id)) {
      return cb?.({ error: 'room.spectatorCannotAct' });
    }

    if (action.type === 'start' && !room.state) {
      roomsMgr.startGame(room);
    }
    if (!room.state) return cb?.({ error: 'room.notStarted' });

    const { error, events } = room.game.applyAction(room.state, action, user.id);
    if (error) return cb?.({ error });
    cb?.({ ok: true });
    broadcastState(room, events || []);
    ensureTimer(room);
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = roomsMgr.getRoom(code);
    if (!room) return;

    // Only the currently bound socket triggers a leave. On a reconnect the new socket has already
    // taken over the binding, so the old socket's disconnect must not kick the person out.
    if (socketIdOf(room, user.id) !== socket.id) return;
    memberSockets.get(code)?.delete(user.id);

    // A spectator has no seat to preserve, so just drop them (no grace period)
    if (room.spectators.some((s) => s.id === user.id)) {
      roomsMgr.leaveRoom(code, user.id);
      const still = roomsMgr.getRoom(code);
      if (still) (still.state ? broadcastState(still) : broadcastLobby(still));
      return;
    }

    // Match in progress: first mark them as disconnected and give a reconnect grace period; if they come back
    // within it they can sit back down in their original seat.
    // If the match has not started (no state) there is no seat to preserve, so they just leave.
    if (room.state && room.state.phase !== 'ended') {
      const events = room.game.removePlayer
        ? room.game.removePlayer(room.state, user.id) || []
        : [];
      broadcastState(room, events);
      scheduleDrop(room.code, user.id);
      // Not a single connection is left in the room (players, eliminated players and spectators have all gone):
      // stop the clock and suspend the countdown.
      // The criterion must be the connection count, not "whether anyone can still act" —— eliminated players are
      // still connected and watching, and in that case the clock must keep running, or the match would be frozen
      // forever on a motionless screen.
      if (roomIsEmpty(room)) pauseRoomClock(room);
      return;
    }

    const events = roomsMgr.leaveRoom(code, user.id) || [];
    const still = roomsMgr.getRoom(code);
    if (still) (still.state ? broadcastState(still, events) : broadcastLobby(still));
  });
});

// Lobby payload (members + host configuration + configuration metadata), shared by sync and the broadcast
function lobbyPayload(room) {
  return {
    code: room.code,
    gameId: room.gameId,
    hostId: room.hostId,
    members: room.members,
    minPlayers: room.game.minPlayers,
    maxPlayers: room.game.maxPlayers,
    config: room.config,
    configSchema: room.game.configSchema || null,
    spectators: room.spectators,
    spectatorGodView: room.spectatorGodView,
  };
}
function broadcastLobby(room) {
  io.to(room.code).emit('lobby', lobbyPayload(room));
}

db.ensureSchema()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`🎮 Game platform server running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Database initialization failed:', err.message);
    process.exit(1);
  });
