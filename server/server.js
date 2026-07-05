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
  const { token, guestName } = socket.handshake.auth || {};
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
    socket.user = { id: `g:${socket.id}`, name: guestName };
    return next();
  }
  next(new Error('需要登录或提供访客名'));
});

// ── 广播房间状态(每个玩家收到各自视图,信息隔离) ──
function broadcastState(room, extraEvents = []) {
  for (const m of room.members) {
    const view = room.game.serializeStateFor(room.state, m.id);
    io.to(socketIdOf(room, m.id)).emit('game_state', view);
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
      socket.emit('game_state', room.game.serializeStateFor(room.state, user.id));
    } else {
      socket.emit('lobby', {
        code: room.code, gameId: room.gameId, hostId: room.hostId,
        members: room.members, minPlayers: room.game.minPlayers, maxPlayers: room.game.maxPlayers,
      });
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
    const { room, error } = roomsMgr.joinRoom(roomCode, user);
    if (error) return cb?.({ error });
    socket.join(room.code);
    bindSocket(room, user.id, socket.id);
    socket.data.roomCode = room.code;
    cb?.({ roomCode: room.code, hostId: room.hostId, playerId: user.id });
    if (room.state) broadcastState(room);
    else broadcastLobby(room);
  });

  socket.on('game_action', ({ action }, cb) => {
    const room = roomsMgr.getRoom(socket.data.roomCode);
    if (!room) return cb?.({ error: '不在房间中' });

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
    if (room) {
      memberSockets.get(code)?.delete(user.id);
      roomsMgr.leaveRoom(code, user.id);
      const still = roomsMgr.getRoom(code);
      if (still) (still.state ? broadcastState(still) : broadcastLobby(still));
    }
  });
});

// 大厅态(未开始):广播成员列表
function broadcastLobby(room) {
  io.to(room.code).emit('lobby', {
    code: room.code,
    gameId: room.gameId,
    hostId: room.hostId,
    members: room.members,
    minPlayers: room.game.minPlayers,
    maxPlayers: room.game.maxPlayers,
  });
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
