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
    spectators: [],    // 中途进来的观战者(不参与对局,不占 maxPlayers)
    state: null,       // 开始前为 null
    config: {},        // 房主在大厅设置的游戏配置
    // 观战者是否可见全部身份(上帝视角)。默认关闭:开着的话同局玩家开个小号
    // 进来观战就能看穿全场。由房主在大厅显式打开。
    spectatorGodView: false,
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

  // 重连:该 id 本来就在这局里 → 坐回原座位(不占新名额,不受满员限制)
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

  // 对局已开始且此人不属于这局 → 作为观战者加入(不进 state.players,没有角色,
  // 不占 maxPlayers 名额)。观战者不能行动,视图由 spectatorViewFor 单独生成。
  // 注意:createInitialState 建出来的 state 初始 phase 就是 'lobby'(要等 start 动作才推进),
  // 所以"是否已开局"要看 state 是否存在,不能看 phase。
  if (room.state) {
    if (!room.spectators.find((s) => s.id === member.id)) {
      room.spectators.push({ id: member.id, name: member.name });
    }
    return { room, spectator: true };
  }

  if (room.members.length >= room.game.maxPlayers) return { error: '房间已满' };
  if (!room.members.find((m) => m.id === member.id)) {
    room.members.push({ id: member.id, name: member.name });
  }
  return { room };
}

// 离开房间;若空则销毁。
// 返回受影响的游戏事件(如画手掉线导致换轮),调用方据此广播。
function leaveRoom(code, memberId) {
  const room = getRoom(code);
  if (!room) return [];

  // 观战者离开:不影响对局,直接摘掉
  if (room.spectators.some((s) => s.id === memberId)) {
    room.spectators = room.spectators.filter((s) => s.id !== memberId);
    if (room.members.length === 0 && room.spectators.length === 0) {
      clearTimer(room);
      rooms.delete(room.code);
    }
    return [];
  }

  room.members = room.members.filter((m) => m.id !== memberId);

  // 同步对局状态:成员列表和 state 是两份数据,不同步就会留下"幽灵玩家"
  //(仍被算作存活/仍在轮转里),导致流程卡在等一个永远不会行动的人。
  // 走到 leaveRoom 说明是真的离开(宽限期已过或主动退出),用 eliminatePlayer
  // 判其出局并重跑胜负 —— 只标 absent 的话唯一的狼退出后好人永远赢不了。
  let events = [];
  if (room.state) {
    const drop = room.game.eliminatePlayer || room.game.removePlayer;
    if (drop) events = drop(room.state, memberId) || [];
  }

  // 玩家全走光但还有观战者:房间不能销毁,否则观战者卡在一个已不存在的房间里
  //(sync 什么都拿不到)。等观战者也走完再回收(见上面的观战者分支)。
  if (room.members.length === 0 && room.spectators.length === 0) {
    clearTimer(room);
    rooms.delete(room.code);
    return [];
  }
  // 房主离开 → 转移房主(state.hostId 也要跟着变,否则局内房主动作会认错人)
  if (room.members.length === 0) return events;   // 只剩观战者,无房主可转移
  if (room.hostId === memberId) {
    room.hostId = room.members[0].id;
    if (room.state) room.state.hostId = room.hostId;
  }
  return events;
}

// 观战者视图。
// 基线:用一个"不存在的玩家 id"调游戏模块的 serializeStateFor —— 该 id 没有角色,
// 拿到的天然就是纯公开信息(不会泄露任何人的身份),不需要各游戏另写一套逻辑。
// 房主开启上帝视角后,再附加 roles;对局结束时本来就公开身份,不受开关影响。
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
  spectatorViewFor,
};
