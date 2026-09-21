import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import LobbySettings from './LobbySettings';
import DrawGuessGame from './DrawGuessGame';
import WerewolfGame from './WerewolfGame';
import KittensGame from './KittensGame';
import { ui } from './ui';
import { serverError, useT } from './i18n.jsx';
import LangToggle from './LangToggle.jsx';

// Room router: owns the generic lobby (room code / members / settings / start) and the
// room-level socket events (lobby / game_state / kicked), and dispatches the in-game UI
// to each game component by gameId.
// Adding a game = write an <XxxGame> component and register one line in GAME_VIEWS below.
// props: socket(ref), roomCode, me{id,name}, onLeave
const GAME_VIEWS = {
  drawguess: DrawGuessGame,
  werewolf: WerewolfGame,
  kittens: KittensGame,
};

export default function GameRoom({ socket, roomCode, me, onLeave }) {
  const t = useT();
  const [lobby, setLobby] = useState(null);   // lobby info, before the game starts
  const [state, setState] = useState(null);   // per-role view of the game state
  const [gameId, setGameId] = useState(null); // which game this room is playing
  const membersRef = useRef([]);
  // The listeners are registered once (the effect below has [] deps), so closing over t
  // directly would pin the language as it was at registration -- switching language later
  // would still show alerts in the old one. A ref gives us the current t.
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; }, [t]);

  // Room-level socket events, common to every game: lobby / game_state / kicked
  useEffect(() => {
    const s = socket.current;
    if (!s) return;
    const onLobby = (l) => { membersRef.current = l.members || []; if (l.gameId) setGameId(l.gameId); setLobby(l); setState(null); };
    const onState = (st) => { if (st.players) membersRef.current = st.players; setState(st); setLobby(null); };
    const onKicked = () => { alert(tRef.current('room.kicked')); onLeave(); };
    s.on('lobby', onLobby);
    s.on('game_state', onState);
    s.on('kicked', onKicked);
    s.emit('sync'); // Pull current state once listeners are up, so we cannot miss the first broadcast (a race)
    return () => { s.off('lobby', onLobby); s.off('game_state', onState); s.off('kicked', onKicked); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const members = state?.players || lobby?.members || [];
  const hostId = lobby?.hostId || state?.hostId;
  const minPlayers = lobby?.minPlayers ?? 2;
  const isHost = hostId === me.id;
  const joinUrl = `${window.location.origin}?room=${roomCode}`;

  const act = (action) => socket.current?.emit('game_action', { action }, (res) => {
    if (res?.error) alert(serverError(t, res.error));
  });

  // ── Lobby / waiting: show the lobby whenever no game is in progress (state missing, or still in the lobby phase) ──
  if (!state || state.phase === 'lobby') {
    return (
      <div style={ui.wrap}>
        <TopBar roomCode={roomCode} onLeave={onLeave} t={t} />
        <div style={ui.card}>
          <div style={{ textAlign: 'center', marginBottom: 12 }}>
            <div style={{ background: '#fff', display: 'inline-block', padding: 10, borderRadius: 12 }}>
              <QRCodeSVG value={joinUrl} size={140} />
            </div>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 10 }}>
              {t('room.scanToJoin')} <b style={{ color: 'var(--accent)' }}>{roomCode}</b>
            </p>
          </div>
        </div>
        <div style={ui.card}>
          <label style={ui.label}>{t('room.playersCount', { n: members.length, max: lobby?.maxPlayers ?? 8 })}</label>
          {members.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 13 }}>{t('common.connecting')}</p>}
          {members.map((p) => (
            <div key={p.id} style={{ padding: '8px 0', display: 'flex', gap: 8, alignItems: 'center' }}>
              <span>{p.id === hostId ? '👑' : '🙂'}</span>
              <span>{p.name}{p.id === me.id ? t('common.you') : ''}</span>
              {isHost && p.id !== me.id && (
                <button
                  onClick={() => socket.current?.emit('kick_player', { playerId: p.id })}
                  style={{ marginLeft: 'auto', background: 'transparent', color: 'var(--danger)',
                    border: '1px solid var(--border)', borderRadius: 8, padding: '2px 10px',
                    cursor: 'pointer', fontSize: 12 }}>{t('room.kick')}</button>
              )}
            </div>
          ))}
        </div>

        <LobbySettings lobby={lobby} isHost={isHost}
          onChange={(config) => socket.current?.emit('set_config', { config })} />

        {isHost ? (
          <button style={{ ...ui.btnAccent, width: '100%' }} disabled={members.length < minPlayers}
            onClick={() => act({ type: 'start' })}>
            {members.length < minPlayers ? t('room.needPlayers', { n: minPlayers }) : t('room.start')}
          </button>
        ) : (
          <p style={{ textAlign: 'center', color: 'var(--muted)' }}>{t('room.waitHost')}</p>
        )}
      </div>
    );
  }

  // ── In game: dispatch to the matching game component by gameId ──
  const GameView = GAME_VIEWS[gameId];
  const spectators = state.spectators || [];
  return (
    <div style={ui.wrap}>
      <TopBar roomCode={roomCode} onLeave={onLeave} t={t} />
      {state.spectator && (
        <div style={{ ...ui.card, padding: '10px 14px', marginBottom: 12, textAlign: 'center' }}>
          <span style={{ fontSize: 14 }}>
            {t('room.spectating')}
            {state.spectatorGodView && <b style={{ color: 'var(--accent)' }}>{t('room.godView')}</b>}
          </span>
        </div>
      )}
      {!state.spectator && spectators.length > 0 && (
        <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 8, textAlign: 'center' }}>
          {t('room.spectatorCount', {
            n: spectators.length,
            god: state.spectatorGodView ? t('room.godViewSuffix') : '',
          })}
        </div>
      )}
      {isHost && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center',
                        color: 'var(--muted)', fontSize: 13, marginBottom: 10 }}>
          <input type="checkbox" checked={!!state.spectatorGodView}
            onChange={(e) => socket.current?.emit('set_spectator_godview',
              { enabled: e.target.checked }, (r) => r?.error && alert(serverError(t, r.error)))} />
          {t('room.allowGodView')}
        </label>
      )}
      {GameView
        ? <GameView state={state} act={act} me={me} socket={socket} onLeave={onLeave} />
        : <p style={{ color: 'var(--muted)', textAlign: 'center' }}>{t('room.unknownGame', { id: gameId })}</p>}
      {/* Game over: the host can run it back with the same players (returning to the lobby);
          everyone else waits for them. Not shown to spectators. */}
      {state.phase === 'ended' && !state.spectator && (
        isHost ? (
          <button style={{ ...ui.btnAccent, width: '100%', marginTop: 12 }}
            onClick={() => socket.current?.emit('rematch', (r) => r?.error && alert(serverError(t, r.error)))}>
            {t('room.rematch')}
          </button>
        ) : (
          <p style={{ color: 'var(--muted)', fontSize: 13, textAlign: 'center', marginTop: 12 }}>
            {t('room.waitRematch')}
          </p>
        )
      )}
    </div>
  );
}

function TopBar({ roomCode, onLeave, t }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
      <button style={ui.btnGhost} onClick={onLeave}>{t('room.leave')}</button>
      <LangToggle style={{ marginLeft: 'auto' }} />
      <span style={ui.badge}>{t('room.badge', { code: roomCode })}</span>
    </div>
  );
}
