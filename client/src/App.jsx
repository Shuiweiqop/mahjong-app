import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { API_BASE } from './config';
import AuthScreen from './AuthScreen.jsx';
import Lobby from './Lobby.jsx';
import GameRoom from './GameRoom.jsx';
import CalculatorScreen from './CalculatorScreen.jsx';
import { serverError, useT } from './i18n.jsx';

// Development helper: when the URL carries ?guest=<name>, the guest identity is
// derived from that name directly, without reading or writing the shared
// localStorage. Several tabs in one browser (?guest=A / ?guest=B / ...) are then
// distinct guests, which makes it easy to simulate multiple players on one machine
// without opening incognito windows. It stays stable across a refresh, so it works
// for reconnect testing too.
// This only applies in development (import.meta.env.DEV); production builds return
// null, because otherwise anyone could impersonate a dev-* guest through the URL.
function getUrlGuest() {
  if (!import.meta.env.DEV) return null;
  const name = new URLSearchParams(window.location.search).get('guest');
  return name ? name.trim() : null;
}

// A stable, persisted guest id: after a dropped connection or a refresh this is
// still the same player, so they get their original seat back.
// With ?guest= the id is derived from the name instead, keeping each tab independent.
function getGuestId(nameOverride) {
  if (nameOverride) return `dev-${nameOverride}`;
  let id = localStorage.getItem('guestId');
  if (!id) {
    id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem('guestId', id);
  }
  return id;
}

export default function App() {
  const t = useT();
  const urlRoom = new URLSearchParams(window.location.search).get('room');
  const urlGuest = getUrlGuest();

  const savedUser = localStorage.getItem('user');
  const savedToken = localStorage.getItem('token');
  const savedParsed = savedUser ? JSON.parse(savedUser) : null;

  // ?guest=<name> wins: enter directly as that guest, skipping the sign-in screen and
  // ignoring the shared localStorage
  const [me, setMe] = useState(urlGuest ? { name: urlGuest, guest: true } : savedParsed);
  const [auth, setAuth] = useState(
    urlGuest ? { guestName: urlGuest, guestId: getGuestId(urlGuest) }
      // Restore the session: a token for signed-in users, the persisted guestId plus
      // nickname for guests
      : savedToken ? { token: savedToken }
      : savedParsed?.guest ? { guestName: savedParsed.name, guestId: getGuestId() }
      : null
  );
  const [connected, setConnected] = useState(false);
  const [screen, setScreen] = useState('lobby'); // lobby | room
  const [room, setRoom] = useState(null);        // { code, playerId }
  const socketRef = useRef(null);

  // Open the socket connection once we have a user
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
    // A guest identity has to survive a reconnect; otherwise dropping and reconnecting
    // turns into a brand-new player and the original seat is lost.
    // guestId lives in localStorage, decoupled from socket.id.
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
      if (res?.error) return alert(serverError(t, res.error));
      setRoom({ code: res.roomCode, playerId: res.playerId }); setScreen('room');
    });
  };
  const joinRoom = (code) => {
    socketRef.current?.emit('join_room', { roomCode: code }, (res) => {
      if (res?.error) return alert(serverError(t, res.error));
      setRoom({ code: res.roomCode, playerId: res.playerId }); setScreen('room');
    });
  };
  const leaveRoom = () => {
    // Close the old connection -- that is how the server knows to remove us from the
    // room -- then reconnect a clean socket back at the lobby
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
