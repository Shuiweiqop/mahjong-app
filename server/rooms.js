// Room manager (in-memory) —— the platform's general-purpose "lobby + room + match state" layer.
// Nothing is written to a database at this stage; when Supabase is wired up later, persistence
// only needs to be added at the points where state changes.
//
// One room = { code, gameId, hostId, members[], game (the module), state (match state), timer }

const crypto = require('crypto');
const { getGame } = require('./games/registry');

const rooms = new Map(); // code -> room

function generateRoomCode() {
  // 6 uppercase alphanumeric characters, with the easily confused ones removed
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[crypto.randomInt(chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// Create a room. creator: { id, name }
function createRoom(gameId, creator) {
  const game = getGame(gameId);
  if (!game) return { error: 'room.unknownGame' };
  const code = generateRoomCode();
  const room = {
    code,
    gameId,
    game,
    hostId: creator.id,
    members: [{ id: creator.id, name: creator.name }],
    spectators: [],    // spectators who arrived mid-match (they do not take part and do not count toward maxPlayers)
    state: null,       // null before the match starts
    config: {},        // the game configuration the host set in the lobby
    // Whether spectators can see everyone's identity (god view). Off by default: if it were on, a player in the
    // match could join as a spectator on an alt account and see straight through the whole game.
    // The host has to turn it on explicitly in the lobby.
    spectatorGodView: false,
    timer: null,
  };
  rooms.set(code, room);
  return { room };
}

function getRoom(code) {
  return rooms.get((code || '').toUpperCase()) || null;
}

// Join a room
function joinRoom(code, member) {
  const room = getRoom(code);
  if (!room) return { error: 'room.notFound' };

  // Reconnect: this id was already in this match → sit back down in the original seat (it does not take a new slot and is not subject to the full-room limit)
  const inGame = room.state && room.state.players?.some((p) => p.id === member.id);
  if (inGame) {
    if (!room.members.find((m) => m.id === member.id)) {
      room.members.push({ id: member.id, name: member.name });
    }
    const events = room.game.restorePlayer
      ? room.game.restorePlayer(room.state, member.id) || []
      : [];
    return { room, rejoined: true, events };
  }

  // The match has already started and this person is not part of it → join as a spectator (they do not enter
  // state.players, have no role, and do not take a maxPlayers slot). Spectators cannot act, and their view is
  // generated separately by spectatorViewFor.
  // Note: the state built by createInitialState starts in phase 'lobby' (it only advances on the start action),
  // so "has the match started" must be decided by whether state exists, not by phase.
  if (room.state) {
    if (!room.spectators.find((s) => s.id === member.id)) {
      room.spectators.push({ id: member.id, name: member.name });
    }
    return { room, spectator: true };
  }

  if (room.members.length >= room.game.maxPlayers) return { error: 'room.full' };
  if (!room.members.find((m) => m.id === member.id)) {
    room.members.push({ id: member.id, name: member.name });
  }
  return { room };
}

// Leave a room; destroy it if it becomes empty.
// Returns the affected game events (such as the drawer dropping causing a round change), which the caller broadcasts.
function leaveRoom(code, memberId) {
  const room = getRoom(code);
  if (!room) return [];

  // A spectator leaving: this does not affect the match, so just drop them
  if (room.spectators.some((s) => s.id === memberId)) {
    room.spectators = room.spectators.filter((s) => s.id !== memberId);
    if (room.members.length === 0 && room.spectators.length === 0) {
      clearTimer(room);
      rooms.delete(room.code);
    }
    return [];
  }

  room.members = room.members.filter((m) => m.id !== memberId);

  // Keep the match state in sync: the member list and the state are two separate pieces of data, and failing to
  // sync them leaves a "ghost player" behind (still counted as alive / still in the turn rotation), which makes
  // the flow hang waiting for someone who will never act.
  // Reaching leaveRoom means the departure is real (the grace period has expired, or they quit deliberately), so
  // use eliminatePlayer to rule them out and re-evaluate the win condition —— merely marking them absent would
  // mean the villagers can never win once the only werewolf quits.
  let events = [];
  if (room.state) {
    const drop = room.game.eliminatePlayer || room.game.removePlayer;
    if (drop) events = drop(room.state, memberId) || [];
  }

  // All the players have left but spectators remain: the room must not be destroyed, or the spectators would be
  // stuck in a room that no longer exists (sync would return nothing at all). Reclaim it once the spectators have
  // left too (see the spectator branch above).
  if (room.members.length === 0 && room.spectators.length === 0) {
    clearTimer(room);
    rooms.delete(room.code);
    return [];
  }
  // The host left → transfer the host role (state.hostId has to change along with it, or in-match host actions would target the wrong person)
  if (room.members.length === 0) return events;   // only spectators remain, so there is no one to transfer the host role to
  if (room.hostId === memberId) {
    room.hostId = room.members[0].id;
    if (room.state) room.state.hostId = room.hostId;
  }
  return events;
}

// The spectator view.
// Baseline: call the game module's serializeStateFor with a "player id that does not exist" —— that id has no
// role, so what comes back is naturally pure public information (it cannot leak anyone's identity), and no game
// has to write a separate set of logic for it.
// Once the host enables god view, roles are attached on top; when the match ends identities are public anyway, so
// that is unaffected by the toggle.
const SPECTATOR_ID = '__spectator__';
function spectatorViewFor(room) {
  const view = room.game.serializeStateFor(room.state, SPECTATOR_ID);
  view.spectator = true;
  view.myId = null;
  view.myRole = null;
  view.spectators = room.spectators;
  view.spectatorGodView = room.spectatorGodView;
  if (room.spectatorGodView && room.state.roles) view.roles = room.state.roles;
  return view;
}

// Start the match (build the initial state from the current members + the host's configuration)
function startGame(room) {
  room.state = room.game.createInitialState(room.members, room.config);
  room.state.hostId = room.hostId;
  return room.state;
}

// Rematch: clear back to the lobby and reuse the existing lobby/start flow.
// The previous match's spectators (who arrived mid-match) are promoted to full members —— in the new match they
// can genuinely take part; if that would exceed maxPlayers the list is truncated (first come, first served).
// config is preserved, to make "play again with the same settings" smooth.
function resetToLobby(room) {
  clearTimer(room);
  for (const sp of room.spectators) {
    if (room.members.length >= room.game.maxPlayers) break;
    if (!room.members.find((m) => m.id === sp.id)) room.members.push(sp);
  }
  room.spectators = [];
  room.state = null;
  return room;
}

function clearTimer(room) {
  if (room.timer) { clearInterval(room.timer); room.timer = null; }
}

module.exports = {
  rooms,
  createRoom,
  getRoom,
  joinRoom,
  leaveRoom,
  startGame,
  resetToLobby,
  clearTimer,
  generateRoomCode,
  spectatorViewFor,
};
