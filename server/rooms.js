// 房间管理器(内存版)—— 平台通用的"大厅 + 房间 + 对局状态"层。
// 现阶段不落数据库;以后接 Supabase 时只需在状态变更处加持久化。
//
// 一个房间 = { code, gameId, hostId, members[], game(模块), state(对局状态), timer }

const crypto = require('crypto');
const { getGame } = require('./games/registry');

const rooms = new Map(); // code -> room

function generateRoomCode() {
  // 6 位大写字母数字,去掉易混字符
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[crypto.randomInt(chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// 创建房间。creator: { id, name }
function createRoom(gameId, creator) {
  const game = getGame(gameId);
  if (!game) return { error: '未知游戏' };
  const code = generateRoomCode();
  const room = {
    code,
    gameId,
    game,
    hostId: creator.id,
    members: [{ id: creator.id, name: creator.name }],
    state: null,       // 开始前为 null
    config: {},        // 房主在大厅设置的游戏配置
    timer: null,
  };
  rooms.set(code, room);
  return { room };
}

function getRoom(code) {
  return rooms.get((code || '').toUpperCase()) || null;
}

// 加入房间
function joinRoom(code, member) {
  const room = getRoom(code);
  if (!room) return { error: '房间不存在' };
  if (room.state && room.state.phase !== 'lobby') {
    // 已开始:允许作为观战/等待下一局?现阶段先允许加入成员列表(旁观)
  }
  if (room.members.length >= room.game.maxPlayers) return { error: '房间已满' };
  if (!room.members.find((m) => m.id === member.id)) {
    room.members.push({ id: member.id, name: member.name });
  }
  return { room };
}

// 离开房间;若空则销毁
function leaveRoom(code, memberId) {
  const room = getRoom(code);
  if (!room) return;
  room.members = room.members.filter((m) => m.id !== memberId);
  if (room.members.length === 0) {
    clearTimer(room);
    rooms.delete(room.code);
    return;
  }
  // 房主离开 → 转移房主
  if (room.hostId === memberId) room.hostId = room.members[0].id;
}

// 开始对局(用当前成员 + 房主配置创建初始状态)
function startGame(room) {
  room.state = room.game.createInitialState(room.members, room.config);
  room.state.hostId = room.hostId;
  return room.state;
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
  clearTimer,
  generateRoomCode,
};
