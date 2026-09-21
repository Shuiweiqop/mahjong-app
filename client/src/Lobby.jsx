import { useEffect, useState } from 'react';
import { API_BASE } from './config';
import { ui } from './ui';
import { gameName, useT } from './i18n.jsx';
import LangToggle from './LangToggle.jsx';

// Lobby: pick a game and create a room, or join one with a room code.
// props: me, connected, onCreate(gameId), onJoin(code), initialRoom, onLogout, onCalc
export default function Lobby({ me, connected, onCreate, onJoin, initialRoom, onLogout, onCalc }) {
  const t = useT();
  const [games, setGames] = useState([]);
  const [code, setCode] = useState(initialRoom || '');

  useEffect(() => {
    fetch(`${API_BASE}/api/games`).then((r) => r.json()).then(setGames).catch(() => {});
  }, []);

  // If the URL carries ?room=, prefill it so the user can join straight away
  useEffect(() => { if (initialRoom) setCode(initialRoom); }, [initialRoom]);

  return (
    <div style={ui.narrow}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 18, color: 'var(--primary-light)' }}>🎨 Playground</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {me.name} {connected ? t('lobby.connected') : t('lobby.connecting')}
          </div>
        </div>
        <LangToggle style={{ marginLeft: 'auto' }} />
        <button style={ui.btnGhost} onClick={onLogout}>{t('lobby.logout')}</button>
      </div>

      <label style={ui.label}>{t('lobby.chooseGame')}</label>
      {games.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 13 }}>{t('lobby.loadingGames')}</p>}
      {games.map((g) => (
        <div key={g.id} style={{ ...ui.card, padding: 0, overflow: 'hidden' }}>
          {/* Cover art (client/public/games/<id>.webp); hidden if it fails to load, which leaves the card intact */}
          <img src={`/games/${g.id}.webp`} alt={gameName(t, g.id, g.displayName)}
            style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', objectPosition: 'center', display: 'block' }}
            onError={(e) => { e.currentTarget.style.display = 'none'; }} />
          <div style={{ display: 'flex', alignItems: 'center', padding: 14 }}>
            <div>
              <div style={{ fontWeight: 800, fontSize: 16 }}>{gameName(t, g.id, g.displayName)}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                {t('lobby.playerRange', { min: g.minPlayers, max: g.maxPlayers })}
              </div>
            </div>
            <button style={{ ...ui.btnAccent, marginLeft: 'auto' }} disabled={!connected}
              onClick={() => onCreate(g.id)}>{t('lobby.createRoom')}</button>
          </div>
        </div>
      ))}

      <div style={ui.card}>
        <label style={ui.label}>{t('lobby.joinByCode')}</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={{ ...ui.input, marginBottom: 0, letterSpacing: 4, textTransform: 'uppercase' }}
            value={code} maxLength={6} placeholder="ABC123"
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === 'Enter' && code.length >= 4 && onJoin(code)} />
          <button style={ui.btn} disabled={!connected || code.length < 4} onClick={() => onJoin(code)}>{t('lobby.join')}</button>
        </div>
      </div>

      {/* Understated entry point for the tool: a small floating mahjong icon in the
          bottom-right corner. It is an algorithm demo, not a headline game. */}
      {onCalc && (
        <button onClick={onCalc} title={t('lobby.calcTitle')}
          style={{
            position: 'fixed', right: 20, bottom: 20, width: 48, height: 48,
            borderRadius: '50%', border: '1px solid var(--border)',
            background: 'var(--surface-2)', color: 'var(--text)', fontSize: 22,
            cursor: 'pointer', display: 'grid', placeItems: 'center',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)', opacity: 0.75, transition: 'opacity 0.2s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.75'; }}>
          🀄
        </button>
      )}
    </div>
  );
}
