import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { API_BASE } from './config';
import AuthScreen from './AuthScreen.jsx';
import Lobby from './Lobby.jsx';
import GameRoom from './GameRoom.jsx';
import CalculatorScreen from './CalculatorScreen.jsx';

// 稳定的访客 id(持久化):断线重连/刷新后仍是同一个玩家,能坐回原座位。
function getGuestId() {
  let id = localStorage.getItem('guestId');
  if (!id) {
    id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem('guestId', id);
  }
  return id;
}

export default function App() {
  const urlRoom = new URLSearchParams(window.location.search).get('room');

  const savedUser = localStorage.getItem('user');
  const savedToken = localStorage.getItem('token');
  const savedParsed = savedUser ? JSON.parse(savedUser) : null;
  const [me, setMe] = useState(savedParsed);
  // 恢复会话:登录用户用 token;访客用持久化的 guestId + 昵称
  const [auth, setAuth] = useState(
    savedToken ? { token: savedToken }
      : savedParsed?.guest ? { guestName: savedParsed.name, guestId: getGuestId() }
      : null
  );
  const [connected, setConnected] = useState(false);
  const [screen, setScreen] = useState('lobby'); // lobby | room
  const [room, setRoom] = useState(null);        // { code, playerId }
  const socketRef = useRef(null);

  // me 存在时建立 socket 连接
  useEffect(() => {
    if (!me || !auth) return;
    connect();
    return () => { socketRef.current?.close(); socketRef.current = null; setConnected(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, auth]);

  const connect = () => {
    const sock = io(API_BASE, { auth });
    socketRef.current = sock;
    sock.on('connect', () => setConnected(true));
    sock.on('disconnect', () => setConnected(false));
    return sock;
  };

  const handleLogin = (user, token) => { setMe(user); setAuth({ token }); };
  const handleGuest = (name) => {
    // 访客身份要跨重连稳定,否则断线重连会变成一个全新玩家、丢失原座位。
    // guestId 存 localStorage,与 socket.id 解耦。
    const guest = { name, guest: true };
    localStorage.setItem('user', JSON.stringify(guest));
    setMe(guest); setAuth({ guestName: name, guestId: getGuestId() });
  };
  const handleLogout = () => {
    localStorage.removeItem('token'); localStorage.removeItem('user');
    socketRef.current?.close();
    setMe(null); setAuth(null); setScreen('lobby'); setRoom(null);
  };

  const createRoom = (gameId) => {
    socketRef.current?.emit('create_room', { gameId }, (res) => {
      if (res?.error) return alert(res.error);
      setRoom({ code: res.roomCode, playerId: res.playerId }); setScreen('room');
    });
  };
  const joinRoom = (code) => {
    socketRef.current?.emit('join_room', { roomCode: code }, (res) => {
      if (res?.error) return alert(res.error);
      setRoom({ code: res.roomCode, playerId: res.playerId }); setScreen('room');
    });
  };
  const leaveRoom = () => {
    // 断开旧连接(服务端据此把我移出房间)并重连一个干净 socket 回大厅
    socketRef.current?.close();
    connect();
    setScreen('lobby'); setRoom(null);
  };

  if (!me) return <AuthScreen onLogin={handleLogin} onGuest={handleGuest} />;

  if (screen === 'calc') {
    return <CalculatorScreen onBack={() => setScreen('lobby')} />;
  }
  if (screen === 'room' && room) {
    return (
      <GameRoom
        key={room.code}
        socket={socketRef}
        roomCode={room.code}
        me={{ id: room.playerId, name: me.name }}
        onLeave={leaveRoom}
      />
    );
  }
  return (
    <Lobby me={me} connected={connected} onCreate={createRoom} onJoin={joinRoom}
      initialRoom={urlRoom} onLogout={handleLogout} onCalc={() => setScreen('calc')} />
  );
}
