// 多人游戏平台 —— 服务器入口。
// Express(REST:auth + 游戏列表) + Socket.io(实时对局,服务端权威)。
// 数据库:有 DATABASE_URL 用 Postgres(Supabase),否则内存降级(见 db.js)。

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
// CORS:线上用 CLIENT_ORIGIN(逗号分隔)白名单;未设置则放开(本地开发)
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

// ── Socket 认证:允许登录用户(带 token)或访客(带 guest 身份) ──
io.use((socket, next) => {
  const { token, guestName, guestId } = socket.handshake.auth || {};
  if (token) {
    try {
      const u = jwt.verify(token, JWT_SECRET);
      socket.user = { id: `u:${u.id}`, name: u.name };
      return next();
    } catch {
      /* 落到访客 */
    }
  }
  if (guestName) {
    // 优先用客户端持久化的 guestId:重连后 id 不变,可坐回原座位。
    // 老客户端没传 guestId 时退回 socket.id(重连即换身份,行为同旧版)。
    const stable = typeof guestId === 'string' && /^[\w-]{1,64}$/.test(guestId);
    socket.user = { id: `g:${stable ? guestId : socket.id}`, name: guestName };
    return next();
  }
  next(new Error('需要登录或提供访客名'));
});

// ── 广播房间状态(每个玩家收到各自视图,信息隔离) ──
// 玩家视图 = 游戏模块的分角色视图 + 房间级的观战信息(让玩家知道有谁在旁观)。
// sync 与 broadcastState 共用,避免两处各拼一次导致字段漂移。
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
  // 观战者:统一的公开视图(房主开了上帝视角才附带身份)
  if (room.spectators.length) {
    const specView = roomsMgr.spectatorViewFor(room);
    for (const s of room.spectators) {
      io.to(socketIdOf(room, s.id)).emit('game_state', specView);
    }
  }
  // 广播非隔离的增量事件(笔画/聊天/猜中通知等)给全房间
  for (const ev of extraEvents) {
    if (ev.type === 'stroke') {
      // 一批笔画只发给非画手(画手本地已画)
      socketsExcept(room, room.state.drawerId).forEach((sid) =>
        io.to(sid).emit('stroke', ev.strokes)
      );
    } else if (ev.type === 'clear') {
      io.to(room.code).emit('clear');
    } else if (ev.type === 'chat') {
      io.to(room.code).emit('chat', { playerId: ev.playerId, text: ev.text });
    } else if (ev.type === 'guessed') {
      io.to(room.code).emit('guessed', { playerId: ev.playerId, points: ev.points });
    } else if (ev.type === 'reveal') {
      io.to(room.code).emit('reveal', { word: ev.word, reason: ev.reason });
    } else if (ev.type === 'game_over') {
      io.to(room.code).emit('game_over');
      // 存战绩(登录用户才计入 user_id;内存模式下 db 层直接跳过)
      const over = room.game.isGameOver(room.state);
      if (over && over.ranking) db.saveGameResult(room.gameId, room.code, over.ranking);
    }
  }
}

// socket id 映射:member.id -> 该成员的 socket id
const memberSockets = new Map(); // roomCode -> Map(memberId -> socketId)
function socketIdOf(room, memberId) {
  return memberSockets.get(room.code)?.get(memberId);
}
function socketsExcept(room, exceptMemberId) {
  const map = memberSockets.get(room.code);
  if (!map) return [];
  return [...map.entries()].filter(([mid]) => mid !== exceptMemberId).map(([, sid]) => sid);
}
function bindSocket(room, memberId, socketId) {
  if (!memberSockets.has(room.code)) memberSockets.set(room.code, new Map());
  memberSockets.get(room.code).set(memberId, socketId);
}

// ── 断线重连宽限 ──
// 掉线后不立刻把人从房间移除,留一段时间让他重连回原座位;
// 超时未回才真正离开(此时才释放名额、必要时转移房主)。
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
    // 期间已重连则不再移除
    if (socketIdOf(room, memberId)) return;
    const events = roomsMgr.leaveRoom(roomCode, memberId) || [];
    const still = roomsMgr.getRoom(roomCode);
    if (!still) return;                       // 房间已空 → 已销毁
    // 宽限期结束仍无人在线:对局不可能再继续,销毁房间释放资源
    if ((memberSockets.get(roomCode)?.size || 0) === 0) {
      roomsMgr.clearTimer(still);
      memberSockets.delete(roomCode);
      roomsMgr.rooms.delete(roomCode);
      return;
    }
    still.state ? broadcastState(still, events) : broadcastLobby(still);
  }, RECONNECT_GRACE_MS));
}

// ── 计时器:每秒 tick 一次,推进选词/作画/揭晓阶段 ──
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

  // 前端进入房间界面、注册好监听器后主动拉一次当前状态,避免错过加入时的首个广播(竞态)
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
    cancelDrop(room.code, user.id);   // 重连成功 → 取消待执行的移除
    cb?.({ roomCode: room.code, hostId: room.hostId, playerId: user.id, spectator: !!spectator });
    if (room.state) {
      broadcastState(room, rejoinEvents || []);
      // 全员掉线时 tick 被暂停,这里恢复(对局未结束才需要)
      if (room.state.phase !== 'ended') ensureTimer(room);
    } else broadcastLobby(room);
  });

  // 房主在大厅更新游戏配置
  socket.on('set_config', ({ config }, cb) => {
    const room = roomsMgr.getRoom(socket.data.roomCode);
    if (!room) return cb?.({ error: '不在房间中' });
    if (user.id !== room.hostId) return cb?.({ error: '只有房主能设置' });
    if (room.state) return cb?.({ error: '游戏已开始' });
    room.config = { ...room.config, ...config };
    cb?.({ ok: true });
    broadcastLobby(room); // 广播给所有人,同步设置显示
  });

  // 房主切换"观战者上帝视角"(可在大厅或对局中随时改)
  socket.on('set_spectator_godview', ({ enabled }, cb) => {
    const room = roomsMgr.getRoom(socket.data.roomCode);
    if (!room) return cb?.({ error: '不在房间中' });
    if (user.id !== room.hostId) return cb?.({ error: '只有房主能设置' });
    room.spectatorGodView = !!enabled;
    cb?.({ ok: true });
    if (room.state) broadcastState(room); else broadcastLobby(room);
  });

  // 房主踢人(仅大厅阶段)
  socket.on('kick_player', ({ playerId }, cb) => {
    const room = roomsMgr.getRoom(socket.data.roomCode);
    if (!room) return cb?.({ error: '不在房间中' });
    if (user.id !== room.hostId) return cb?.({ error: '只有房主能踢人' });
    if (room.state) return cb?.({ error: '游戏进行中不能踢人' });
    if (playerId === room.hostId) return cb?.({ error: '不能踢自己' });

    const kickedSid = socketIdOf(room, playerId);
    memberSockets.get(room.code)?.delete(playerId);
    cancelDrop(room.code, playerId);
    roomsMgr.leaveRoom(room.code, playerId);   // 仅大厅阶段,无对局事件
    cb?.({ ok: true });

    // 通知被踢者并让其离开 socket 房间
    if (kickedSid) {
      io.to(kickedSid).emit('kicked');
      io.sockets.sockets.get(kickedSid)?.leave(room.code);
    }
    const still = roomsMgr.getRoom(room.code);
    if (still) broadcastLobby(still);
  });

  socket.on('game_action', ({ action }, cb) => {
    const room = roomsMgr.getRoom(socket.data.roomCode);
    if (!room) return cb?.({ error: '不在房间中' });
    // 观战者只能看:不允许投票/行动/开始等任何动作
    if (room.spectators.some((s) => s.id === user.id)) {
      return cb?.({ error: '观战中,无法参与对局' });
    }

    if (action.type === 'start' && !room.state) {
      roomsMgr.startGame(room);
    }
    if (!room.state) return cb?.({ error: '游戏未开始' });

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

    // 只有当前绑定的 socket 才触发离开。重连时新 socket 已抢先绑定,
    // 此时旧 socket 的 disconnect 不应把人踢掉。
    if (socketIdOf(room, user.id) !== socket.id) return;
    memberSockets.get(code)?.delete(user.id);

    // 观战者没有座位要保留,直接摘掉(不走宽限期)
    if (room.spectators.some((s) => s.id === user.id)) {
      roomsMgr.leaveRoom(code, user.id);
      const still = roomsMgr.getRoom(code);
      if (still) (still.state ? broadcastState(still) : broadcastLobby(still));
      return;
    }

    // 对局进行中:先标记掉线并给一段重连宽限期,时间内回来可坐回原座位。
    // 未开局(无 state)则没有要保留的座位,直接离开。
    if (room.state && room.state.phase !== 'ended') {
      const events = room.game.removePlayer
        ? room.game.removePlayer(room.state, user.id) || []
        : [];
      broadcastState(room, events);
      scheduleDrop(room.code, user.id);
      // 全员掉线:没人收广播了,先停掉每秒 tick(有人重连时 game_action/ensureTimer 会重启),
      // 否则空房间会空转整个宽限期。
      if ((memberSockets.get(code)?.size || 0) === 0) roomsMgr.clearTimer(room);
      return;
    }

    const events = roomsMgr.leaveRoom(code, user.id) || [];
    const still = roomsMgr.getRoom(code);
    if (still) (still.state ? broadcastState(still, events) : broadcastLobby(still));
  });
});

// 大厅 payload(成员 + 房主配置 + 配置元数据),sync 与广播共用
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
      console.log(`🎮 游戏平台服务器运行于 http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('数据库初始化失败:', err.message);
    process.exit(1);
  });
