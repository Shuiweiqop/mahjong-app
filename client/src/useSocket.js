import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { API_BASE } from './config';

// A single socket connection, authenticated with either a login token or a guest name.
export function useSocket(auth) {
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const sock = io(API_BASE, { auth });
    socketRef.current = sock;
    sock.on('connect', () => setConnected(true));
    sock.on('disconnect', () => setConnected(false));
    return () => { sock.close(); socketRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { socket: socketRef, connected };
}
