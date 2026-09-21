import { useEffect, useReducer, useRef, useState } from 'react';
import RoleReveal from './RoleReveal';
import { ui } from './ui';
import { useT } from './i18n.jsx';

// Werewolf game view (during a match).
// props: state (role-specific view), act(action=>void), me{id,name}, socket (ref, used to subscribe to chat events)
// state.phase: reveal | night | witch | hunter | speech | day | pk | ended
//   speech = players speak in turn (only the one with state.iAmSpeaking may talk); day = voting; pk = tie-breaker round
//
// Information-hiding convention for animations: any "choice that has not happened yet" lives only in
// local state and is never reported to the server -- this covers the hunter's aiming (the `aiming`
// state in HunterShot) and the witch's poison target (the `poisoned` state in WitchActions).
// Public animations only ever use accomplished facts (lastNightVictim / lastVotedOut / the hunter_shot
// entry in the log), and when several players die in one night every victim gets the same animation:
// the death list carries no cause of death, so telling the deaths apart would reveal whether the
// witch used her poison.
// Emoji are language-independent, so they stay in a module constant; names and descriptions are looked
// up in the message catalog.
const ROLE_EMOJI = {
  wolf: '🐺', seer: '🔮', witch: '🧪', hunter: '🔫', villager: '👤',
};
// roleInfo(t, 'wolf') → { emoji, name, desc }; an unknown role falls back to villager,
// consistent with the convention that the server only ever sends these five roles.
const roleInfo = (t, role) => {
  const key = ROLE_EMOJI[role] ? role : 'villager';
  return { emoji: ROLE_EMOJI[key], name: t(`role.${key}`), desc: t(`role.${key}.desc`) };
};

// Countdown: reads state.deadline (a ms timestamp), forces a re-render every 500ms, and computes the
// remaining seconds from the deadline on the fly.
// The seconds are deliberately not kept in state -- that avoids calling setState synchronously inside an
// effect. Within the last 10s it turns red and pulses, to create a sense of urgency.
function Countdown({ deadline }) {
  const [, forceTick] = useReducer((n) => n + 1, 0);
  const active = deadline != null;
  useEffect(() => {
    if (!active) return;                     // don't spin an idle timer when there is no deadline
    const t = setInterval(forceTick, 500);
    return () => clearInterval(t);
  }, [active]);
  if (!active) return null;
  const left = remain(deadline);
  const danger = left <= 10;
  return (
    <span style={{
      ...ui.badge,
      fontSize: 15, fontWeight: 800, padding: '6px 14px',
      background: danger ? 'var(--danger)' : 'var(--surface-2)',
      color: danger ? '#fff' : 'var(--text)',
      animation: danger ? 'pulse 1s ease-in-out infinite' : 'none',
    }}>
      ⏱ {left}s
    </span>
  );
}
const remain = (deadline) => deadline == null ? 0 : Math.max(0, Math.ceil((deadline - Date.now()) / 1000));

export default function WerewolfGame({ state, act, me, socket }) {
  const t = useT();
  const players = state.players || [];
  const nameOf = (id) => players.find((p) => p.id === id)?.name || t('common.player');
  const role = roleInfo(t, state.myRole);
  // A spectator is not a player in this match: neither alive nor eliminated, so we never show
  // player-state hints such as "you are out"
  const isSpectator = !!state.spectator;
  const iAmAlive = isSpectator ? null : state.alive;
  const alivePlayers = players.filter((p) => p.alive);
  // Under god view (enabled by the host), spectators can see everyone's role
  const godRoles = isSpectator && state.roles ? state.roles : null;

  // ── Chat / speaking ── (hooks must come before any conditional return)
  // Subscribe to chat events: messages on the dead channel (channel='dead') are only delivered to dead
  // players and spectators (the server already routes by channel).
  const [messages, setMessages] = useState([]);
  // Death animation: played once at the moment day breaks and the speech phase starts, and never repeated.
  // Keyed by round -- no state broadcast within the same round should replay the animation.
  const [slashRound, setSlashRound] = useState(null);
  const victims = Array.isArray(state.lastNightVictim)
    ? state.lastNightVictim
    : state.lastNightVictim ? [state.lastNightVictim] : [];
  // Play the night-result animation once at daybreak. Someone died → the slash; nobody died → the blade
  // is blocked.
  // Note that a "peaceful night" and "the witch healed someone" must look absolutely identical on the
  // client -- and indeed the server only ever sends lastNightVictim=null in both cases. If the two could
  // be told apart, that would reveal whether the witch used her healing potion.
  const showNightResult = state.phase === 'speech' && slashRound !== state.round;
  const showSlash = showNightResult && victims.length > 0;
  const showBlocked = showNightResult && victims.length === 0 && state.round > 0;

  // Gunshot animation: read the last shot out of the public log. The log is already visible to the whole
  // room, so the server needs no extra field just for the animation -- who was taken out is an
  // accomplished fact anyway.
  const log = state.log || [];
  const lastShot = [...log].reverse().find((e) => e.type === 'hunter_shot' && e.target);
  const shotKey = lastShot ? `${lastShot.playerId}->${lastShot.target}` : null;
  const [shownShot, setShownShot] = useState(null);
  const showGunshot = shotKey && shownShot !== shotKey;

  // Exile animation: played once when the daytime vote has been settled and the next night begins. The
  // elimination result is public to the whole room, so there is no hidden information here.
  const [exiledRound, setExiledRound] = useState(null);
  const showExile = state.lastVotedOut && state.phase === 'night' && exiledRound !== state.round;
  const chatEndRef = useRef(null);
  const membersRef = useRef(players);
  useEffect(() => { membersRef.current = players; });
  // The chat listener is only re-attached when the socket changes, so its closure would freeze whatever
  // `t` was current at that moment; read the current one through a ref instead
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; }, [t]);
  useEffect(() => {
    const s = socket?.current;
    if (!s) return;
    const nm = (id) => membersRef.current.find((p) => p.id === id)?.name || tRef.current('common.player');
    const onChat = ({ playerId, text, channel }) =>
      setMessages((m) => [...m.slice(-60), { id: Math.random(), name: nm(playerId), text, channel }]);
    s.on('chat', onChat);
    return () => s.off('chat', onChat);
  }, [socket]);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  // Role reveal prologue: only shown during the server's reveal phase (the night clock has not started yet).
  // Clicking "enter game" sends ready; once every living player is ready (or the grace period expires) the
  // server advances to night and the prologue disappears on its own.
  if (state.phase === 'reveal' && state.myRole) {
    return (
      <RoleReveal
        role={state.myRole}
        ready={state.iReady}
        readyCount={state.readyCount}
        readyTotal={state.readyTotal}
        onDone={() => act({ type: 'ready' })}
      />
    );
  }

  // Game over
  if (state.phase === 'ended') {
    return (
      <div>
        <div style={{ ...ui.card, textAlign: 'center' }}>
          <h2 style={{ marginBottom: 8 }}>
            {state.winner === 'wolf' ? t('wolf.winWolf') : t('wolf.winVillage')}
          </h2>
        </div>
        <div style={ui.card}>
          <label style={ui.label}>{t('wolf.rolesRevealed')}</label>
          {players.map((p) => {
            const r = state.roles?.[p.id];
            const info = r ? roleInfo(t, r) : null;
            return (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
                <span>{p.name}{p.id === me.id ? t('common.you') : ''}</span>
                <span>{info ? `${info.emoji} ${info.name}` : ''}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  const phaseKey = ['night', 'speech', 'day', 'pk', 'witch', 'hunter'].includes(state.phase)
    ? `wolf.phase.${state.phase}` : null;
  const phaseLabel = phaseKey ? t(phaseKey) : state.phase;

  return (
    <div>
      {/* Status bar */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={ui.badge}>{t('wolf.day', { n: state.round })}</span>
        <span style={ui.badge}>{phaseLabel}</span>
        <Countdown deadline={state.deadline} />
        {isSpectator ? (
          <span style={ui.badge}>
            {t('wolf.spectator', { god: state.spectatorGodView ? t('room.godView') : '' })}
          </span>
        ) : (
          <span style={{ ...ui.badge, background: iAmAlive ? 'var(--surface-2)' : 'var(--danger)' }}>
            {t('wolf.youAre', {
              emoji: role.emoji, role: role.name, dead: iAmAlive ? '' : t('wolf.dead'),
            })}
          </span>
        )}
      </div>

      <div className="game-layout" style={{ '--side': '220px' }}>
        {/* Left: main area (role actions / discussion / voting); on narrow screens it degrades to a
            single column and the sidebar drops below */}
        <div style={ui.card}>
          {/* My role card (spectators have no role, so they get the spectating blurb instead) */}
          <div style={{ marginBottom: 14, padding: 12, borderRadius: 10, background: 'var(--surface-2)' }}>
            {isSpectator ? (
              <>
                <div style={{ fontWeight: 800, marginBottom: 4 }}>{t('wolf.spectatingTitle')}</div>
                <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                  {state.spectatorGodView ? t('wolf.spectatingGod') : t('wolf.spectatingNormal')}
                </div>
              </>
            ) : (
              <>
            <div style={{ fontWeight: 800, marginBottom: 4 }}>{role.emoji} {role.name}</div>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>{role.desc}</div>
            {state.myRole === 'wolf' && state.wolfTeammates && (
              <div style={{ fontSize: 13, marginTop: 6, color: 'var(--danger)' }}>
                {state.wolfTeammates.length > 0
                  ? t('wolf.teammates', { names: state.wolfTeammates.map(nameOf).join(t('common.listSep')) })
                  : t('wolf.loneWolf')}
              </div>
            )}
            {state.myRole === 'seer' && state.seerResults && Object.keys(state.seerResults).length > 0 && (
              <div style={{ fontSize: 13, marginTop: 6 }}>
                {t('wolf.seerLog', {
                  results: Object.entries(state.seerResults).map(([id, r]) =>
                    `${nameOf(id)}=${r === 'wolf' ? t('wolf.isWolf') : t('wolf.isGood')}`
                  ).join(t('common.listSep')),
                })}
              </div>
            )}
            {state.myRole === 'witch' && state.potions && (
              <div style={{ fontSize: 13, marginTop: 6 }}>
                {t('wolf.potions', {
                  heal: state.potions.heal ? '✅' : '❌',
                  poison: state.potions.poison ? '✅' : '❌',
                })}
              </div>
            )}
            {state.myRole === 'hunter' && (
              <div style={{ fontSize: 13, marginTop: 6 }}>
                {state.hunterCanShoot ? t('wolf.gunLoaded') : t('wolf.gunUsed')}
              </div>
            )}
              </>
            )}
          </div>

          {/* Death animation: played once at the moment day breaks. Everyone should see it (spectators
              and dead players included) -- this is the public night result, not role-specific
              information. */}
          {showSlash && (
            <div style={{ marginBottom: 12 }}>
              {victims.map((id) => (
                <SlashReveal key={id} name={nameOf(id)}
                  // Only show the role under the spectator god view. Do NOT write this as
                  // state.roles?.[id] -- if the server ever starts sending roles during a match (say,
                  // for some new feature), that form would immediately start exposing dead players'
                  // roles to the whole room, and nothing would raise an error about it.
                  // What gets displayed must be decided by "am I entitled to see this", not by
                  // "does the field happen to be present".
                  role={godRoles?.[id]}
                  t={t}
                  onDone={() => setSlashRound(state.round)} />
              ))}
              <p style={{ textAlign: 'center', color: 'var(--danger)', fontWeight: 700 }}>
                {t('wolf.killed', { names: victims.map(nameOf).join(t('common.listSep')) })}
              </p>
            </div>
          )}

          {/* Peaceful night: the blade is blocked. The wording deliberately says only "nobody went down"
              and does not distinguish between the wolves not killing anyone and the victim being healed
              -- distinguishing the two would reveal whether the witch used her healing potion. */}
          {showBlocked && (
            <div style={{ marginBottom: 12 }}>
              <BlockedReveal t={t} onDone={() => setSlashRound(state.round)} />
              <p style={{ textAlign: 'center', color: 'var(--accent)', fontWeight: 700 }}>
                {t('wolf.peacefulNight')}
              </p>
            </div>
          )}

          {/* Exile: a pile of votes crushes the card. Public information for the whole room. */}
          {showExile && (
            <div style={{ marginBottom: 12 }}>
              <ExileReveal name={nameOf(state.lastVotedOut)}
                onDone={() => setExiledRound(state.round)} />
              <p style={{ textAlign: 'center', color: 'var(--danger)', fontWeight: 700 }}>
                {t('wolf.exiled', { name: nameOf(state.lastVotedOut) })}
              </p>
            </div>
          )}

          {/* Gunshot: played once after the shot has been fired. It depicts an accomplished fact and is
              visible to the whole room. */}
          {showGunshot && (
            <div style={{ marginBottom: 12 }}>
              <GunshotReveal name={nameOf(lastShot.target)}
                onDone={() => setShownShot(shotKey)} />
              <p style={{ textAlign: 'center', color: 'var(--danger)', fontWeight: 700 }}>
                {t('wolf.shotTook', {
                  shooter: nameOf(lastShot.playerId), target: nameOf(lastShot.target),
                })}
              </p>
            </div>
          )}

          {/* Action area. The hunter's shot must be checked before the "already eliminated" branch --
              he is shooting precisely because he died. */}
          {isSpectator ? (
            <p style={{ color: 'var(--muted)', textAlign: 'center' }}>{t('wolf.noActionSpectator')}</p>
          ) : state.phase === 'hunter' ? (
            <HunterShot state={state} act={act} nameOf={nameOf} alivePlayers={alivePlayers} t={t} />
          ) : !iAmAlive ? (
            <p style={{ color: 'var(--muted)', textAlign: 'center' }}>{t('wolf.deadWatching')}</p>
          ) : state.phase === 'speech' ? (
            <SpeechTurn state={state} act={act} nameOf={nameOf} t={t} />
          ) : state.phase === 'witch' ? (
            <WitchActions state={state} act={act} nameOf={nameOf} alivePlayers={alivePlayers} t={t} />
          ) : state.phase === 'night' ? (
            <NightActions state={state} act={act} me={me} alivePlayers={alivePlayers} t={t} />
          ) : state.phase === 'day' ? (
            <DayVote state={state} act={act} me={me} alivePlayers={alivePlayers} nameOf={nameOf} t={t} />
          ) : state.phase === 'pk' ? (
            <PkVote state={state} act={act} nameOf={nameOf} t={t} />
          ) : null}

          {/* Discussion area: living players may speak publicly during the day and PK phases; dead
              players and spectators use the dead channel. Living players are muted at night. */}
          <ChatPanel
            state={state} act={act} messages={messages} chatEndRef={chatEndRef}
            isSpectator={isSpectator} iAmAlive={iAmAlive} t={t}
          />
        </div>

        {/* Right: player list */}
        <div style={{ ...ui.card, marginBottom: 0, padding: 12 }}>
          <label style={ui.label}>{t('wolf.aliveCount', { n: alivePlayers.length })}</label>
          {players.map((p) => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '4px 0',
              color: p.alive ? 'var(--text)' : 'var(--muted)', textDecoration: p.alive ? 'none' : 'line-through' }}>
              <span>{p.alive ? '🙂' : '💀'} {p.name}{p.id === me.id ? t('common.you') : ''}</span>
              {godRoles?.[p.id] && (
                <span style={{ color: 'var(--accent)', fontSize: 13 }}>
                  {roleInfo(t, godRoles[p.id]).emoji} {roleInfo(t, godRoles[p.id]).name}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Several players can die in one night (the wolves' kill plus the witch's poison), which is why
// lastNightVictim is an array.
// In an earlier version it was a single id; passing the array straight to nameOf would yield the generic
// "player" label and you could not tell who actually died.
function victimNames(victim, nameOf, t) {
  const ids = Array.isArray(victim) ? victim : victim ? [victim] : [];
  if (!ids.length) return null;
  return t('wolf.victimsLastNight', { names: ids.map(nameOf).join(t('common.listSep')) });
}

// Death animation: a dagger slashes diagonally across the card, which is cut in two halves that slide
// apart.
// Pure CSS plus clip-path -- the top and bottom halves are the same card rendered twice, each clipped to
// one half, then sliding away in opposite directions. No animation library needed.
//
// Respects prefers-reduced-motion: users who have turned motion off see the result directly, with no
// cutting animation.
function SlashReveal({ name, role, onDone, t }) {
  const [stage, setStage] = useState('idle');   // idle → slash → split → done
  useEffect(() => {
    const t1 = setTimeout(() => setStage('slash'), 200);
    const t2 = setTimeout(() => setStage('split'), 700);
    const t3 = setTimeout(() => { setStage('done'); onDone?.(); }, 2200);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [onDone]);

  if (stage === 'done') return null;
  // `role` only has a value under the spectator god view; without it we simply omit the role line
  // (see the explanation at the call site)
  const info = role ? roleInfo(t, role) : null;

  // The card face (rendered once for each half)
  const face = (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      width: '100%', height: '100%', gap: 6,
      background: 'var(--surface-2)', border: '2px solid var(--border)', borderRadius: 12,
    }}>
      <div style={{ fontSize: 38 }}>{info?.emoji ?? '🙂'}</div>
      <div style={{ fontWeight: 800, fontSize: 17 }}>{name}</div>
      {info && <div style={{ fontSize: 13, color: 'var(--muted)' }}>{info.name}</div>}
    </div>
  );

  const split = stage === 'split';
  const half = (which) => ({
    position: 'absolute', inset: 0,
    // Clip along the diagonal: the top half keeps the upper left, the bottom half the lower right
    clipPath: which === 'top'
      ? 'polygon(0 0, 100% 0, 100% 38%, 0 74%)'
      : 'polygon(0 74%, 100% 38%, 100% 100%, 0 100%)',
    transform: split
      ? (which === 'top' ? 'translate(-14px,-18px) rotate(-5deg)' : 'translate(14px,20px) rotate(5deg)')
      : 'none',
    opacity: split ? 0 : 1,
    transition: 'transform 1.1s cubic-bezier(0.2,0.7,0.3,1), opacity 1.1s ease-in',
  });

  return (
    <div className="slash-wrap" style={{
      position: 'relative', width: 190, height: 150, margin: '0 auto 12px',
    }}>
      <div style={half('top')}>{face}</div>
      <div style={half('bottom')}>{face}</div>
      {/* Blade glint: a thin white flash sweeping along the diagonal */}
      {stage !== 'idle' && (
        <div className="slash-blade" style={{
          position: 'absolute', inset: -20, pointerEvents: 'none',
          background: 'linear-gradient(108deg, transparent 44%, #fff 49%, #ffd9d9 50%, transparent 56%)',
        }} />
      )}
    </div>
  );
}

// Peaceful night: the blade comes down diagonally, hits a shield, and is deflected and shattered.
//
// This animation must look exactly the same whether the wolves killed nobody or the witch healed the
// victim -- the server already only sends lastNightVictim=null in both cases, and if the client could
// tell them apart it would be telling everyone whether the witch used a potion tonight, which would
// reduce the healing potion's value to nothing.
function BlockedReveal({ onDone, t }) {
  const [stage, setStage] = useState('idle');   // idle → clash → done
  useEffect(() => {
    const t1 = setTimeout(() => setStage('clash'), 200);
    const t2 = setTimeout(() => { setStage('done'); onDone?.(); }, 1900);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [onDone]);

  if (stage === 'done') return null;
  const clash = stage === 'clash';

  return (
    <div style={{ position: 'relative', width: 190, height: 150, margin: '0 auto 12px' }}>
      <div className={clash ? 'block-shield' : undefined} style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
        background: 'var(--surface-2)', border: '2px solid var(--accent)', borderRadius: 12,
      }}>
        <div style={{ fontSize: 38 }}>🛡️</div>
        <div style={{ fontWeight: 800, fontSize: 16 }}>{t('wolf.noOneDown')}</div>
      </div>
      {/* The blade comes down diagonally and is blocked halfway (the sweep stops at the midpoint) */}
      {clash && (
        <div className="block-blade" style={{
          position: 'absolute', inset: -20, pointerEvents: 'none',
          background: 'linear-gradient(108deg, transparent 44%, #fff 49%, #d9e6ff 50%, transparent 56%)',
        }} />
      )}
      {/* The spark thrown off by the impact */}
      {clash && <div className="block-spark" style={{
        position: 'absolute', left: '50%', top: '50%', width: 10, height: 10,
        marginLeft: -5, marginTop: -5, borderRadius: '50%',
        background: 'radial-gradient(circle, #fff 0%, #ffd76a 45%, transparent 70%)',
        pointerEvents: 'none',
      }} />}
    </div>
  );
}

// Voted out: a stack of ballots slams down from above and crushes the card.
// The elimination result is public to the whole room anyway (lastVotedOut is sent to everyone), so there
// is no hidden information here.
function ExileReveal({ name, onDone }) {
  const [stage, setStage] = useState('idle');   // idle → drop → crush → done
  useEffect(() => {
    const t1 = setTimeout(() => setStage('drop'), 150);
    const t2 = setTimeout(() => setStage('crush'), 700);
    const t3 = setTimeout(() => { setStage('done'); onDone?.(); }, 2100);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [onDone]);

  if (stage === 'done') return null;
  const crushed = stage === 'crush';

  return (
    <div style={{ position: 'relative', width: 190, height: 150, margin: '0 auto 12px' }}>
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 0,
        height: crushed ? 46 : 150,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
        background: 'var(--surface-2)', border: '2px solid var(--border)', borderRadius: 12,
        transform: crushed ? 'scaleX(1.08)' : 'none',
        opacity: crushed ? 0.35 : 1,
        overflow: 'hidden',
        transition: 'height 0.5s cubic-bezier(0.6,0,0.8,0.4), transform 0.5s, opacity 1s ease-in 0.4s',
      }}>
        <div style={{ fontSize: 34 }}>🗳️</div>
        <div style={{ fontWeight: 800, fontSize: 16 }}>{name}</div>
      </div>
      {/* The ballot stack: slamming down from above */}
      {stage !== 'idle' && (
        <div className="exile-votes" style={{
          position: 'absolute', left: '50%', top: 0, marginLeft: -34,
          fontSize: 30, letterSpacing: -8, pointerEvents: 'none',
        }}>🗳️🗳️🗳️</div>
      )}
    </div>
  );
}

// The poison takes effect: green seeps outward from the center and the card slowly withers.
//
// Played for the witch herself only. In the public announcement at daybreak, a poisoned player and a
// knifed player get the very same slash animation -- lastNightVictim is an array that carries no cause
// of death, so the villagers genuinely cannot tell who was knifed and who was poisoned.
// Giving the poisoned player their own green treatment would make public both whether the witch used her
// poison and whom she poisoned, which would render the poison useless.
function PoisonReveal({ name, onDone, t }) {
  const [stage, setStage] = useState('idle');
  useEffect(() => {
    const t1 = setTimeout(() => setStage('seep'), 120);
    const t2 = setTimeout(() => { setStage('done'); onDone?.(); }, 2000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [onDone]);

  if (stage === 'done') return null;

  return (
    <div style={{ position: 'relative', width: 190, height: 150, margin: '0 auto 12px', overflow: 'hidden', borderRadius: 12 }}>
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
        background: 'var(--surface-2)', border: '2px solid #4caf7d', borderRadius: 12,
        filter: stage === 'seep' ? 'saturate(0.5) brightness(0.85)' : 'none',
        transition: 'filter 1.4s ease-in',
      }}>
        <div style={{ fontSize: 38 }}>☠️</div>
        <div style={{ fontWeight: 800, fontSize: 17 }}>{name}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t('wolf.poisonTook')}</div>
      </div>
      {stage === 'seep' && (
        <div className="poison-seep" style={{
          position: 'absolute', left: '50%', top: '55%', width: 12, height: 12,
          marginLeft: -6, marginTop: -6, borderRadius: '50%', pointerEvents: 'none',
          background: 'radial-gradient(circle, rgba(76,175,125,0.85) 0%, rgba(76,175,125,0.45) 55%, transparent 72%)',
        }} />
      )}
    </div>
  );
}

// Gunshot: a muzzle flash, then the target card is hit, shudders and falls.
//
// Only played once the shot has already been fired -- it depicts an accomplished fact (who was taken out
// is public information).
// The aiming process is never animated: doing so would reveal where the muzzle is pointing before the
// trigger is even pulled.
function GunshotReveal({ name, onDone }) {
  const [stage, setStage] = useState('idle');   // idle → fire → fall → done
  useEffect(() => {
    const t1 = setTimeout(() => setStage('fire'), 150);
    const t2 = setTimeout(() => setStage('fall'), 550);
    const t3 = setTimeout(() => { setStage('done'); onDone?.(); }, 2000);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [onDone]);

  if (stage === 'done') return null;
  const fell = stage === 'fall';

  return (
    <div style={{ position: 'relative', width: 190, height: 150, margin: '0 auto 12px' }}>
      <div className={stage === 'fire' ? 'gun-hit' : undefined} style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
        background: 'var(--surface-2)', border: '2px solid var(--danger)', borderRadius: 12,
        transform: fell ? 'translateY(34px) rotate(9deg)' : 'none',
        opacity: fell ? 0 : 1,
        transition: 'transform 1.1s cubic-bezier(0.4,0,0.6,1), opacity 1.1s ease-in',
      }}>
        <div style={{ fontSize: 38 }}>🎯</div>
        <div style={{ fontWeight: 800, fontSize: 17 }}>{name}</div>
      </div>
      {/* Muzzle flash: a burst of white light exploding from the center */}
      {stage === 'fire' && (
        <div className="gun-flash" style={{
          position: 'absolute', left: '50%', top: '50%', width: 16, height: 16,
          marginLeft: -8, marginTop: -8, borderRadius: '50%', pointerEvents: 'none',
          background: 'radial-gradient(circle, #fff 0%, #ffe08a 40%, #ff8a3d 65%, transparent 75%)',
        }} />
      )}
    </div>
  );
}

// Speaking in turn. Only one player may speak at a time and everyone else can only watch -- this stops
// the wolves from flooding the chat to bury the seer's report. When it is your turn you speak through the
// chat box below and click "pass" when you are done.
function SpeechTurn({ state, act, nameOf, t }) {
  const order = state.speechOrder || [];
  const cur = state.currentSpeaker;

  return (
    <div>
      <p style={{ marginBottom: 10, fontWeight: 700, textAlign: 'center' }}>
        {state.iAmSpeaking ? t('speech.yourTurn') : t('speech.othersTurn', { name: nameOf(cur) })}
      </p>
      <div style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center', marginBottom: 10 }}>
        {t('speech.position', { n: (state.spokenCount ?? 0) + 1, total: state.speechTotal })}
      </div>

      {/* Overview of the speaking order: those who have already spoken fade out, the current one is
          highlighted */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center', marginBottom: 10 }}>
        {order.map((id, i) => (
          <span key={id} style={{
            ...ui.badge, fontSize: 12,
            opacity: i < (state.spokenCount ?? 0) ? 0.4 : 1,
            background: id === cur ? 'var(--accent)' : 'var(--surface-2)',
            color: id === cur ? '#fff' : 'var(--text)',
          }}>{nameOf(id)}</span>
        ))}
      </div>

      {state.iAmSpeaking ? (
        <>
          <p style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center', marginBottom: 8 }}>
            {t('speech.useChat')}
          </p>
          <button style={{ ...ui.btnAccent, width: '100%' }}
            onClick={() => act({ type: 'pass_speech' })}>{t('speech.pass')}</button>
        </>
      ) : (
        <WaitHint text={t('speech.waiting')} />
      )}
    </div>
  );
}

// The witch uses her potions. The server gives her a separate phase after the wolves' kill has been
// settled, because she has to see the victim before she can decide.
// The victim (state.witchVictim) is only ever sent to the witch herself.
function WitchActions({ state, act, nameOf, alivePlayers, t }) {
  const [mode, setMode] = useState(null);   // null | 'poison' (currently choosing a poison target)
  // The player just poisoned, used only to play the seeping feedback once for the witch herself. Purely
  // local -- the cause of death is never sent outward: lastNightVictim is an array with no cause of
  // death, so the villagers cannot tell who was knifed and who was poisoned, and giving the poisoned
  // player their own green treatment would make exactly that distinction public.
  const [poisoned, setPoisoned] = useState(null);
  const victim = state.witchVictim;
  const potions = state.potions || {};
  // She may heal herself on the first night; after that she cannot use the healing potion when she is
  // the victim herself
  const selfBlocked = victim === state.myId && !state.canSelfHeal;
  const canHeal = potions.heal && victim && !selfBlocked;

  if (state.myRole !== 'witch') {
    return <p style={{ color: 'var(--muted)', textAlign: 'center' }}>{t('witch.closeEyes')}</p>;
  }
  if (state.iActed) {
    // Only the witch herself ever sees this green seep -- she already knows whom she poisoned
    return (
      <div>
        {poisoned && <PoisonReveal name={nameOf(poisoned)} t={t} onDone={() => setPoisoned(null)} />}
        <WaitHint text={t('witch.acted')} />
      </div>
    );
  }

  if (mode === 'poison') {
    return (
      <div>
        <p style={{ marginBottom: 10, fontWeight: 700, textAlign: 'center' }}>{t('witch.pickPoison')}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {alivePlayers.filter((p) => p.id !== state.myId).map((p) => (
            <button key={p.id} style={{ ...ui.btnGhost, color: 'var(--danger)' }}
              onClick={() => { setPoisoned(p.id); act({ type: 'witch', poison: p.id }); }}>
              {t('witch.poisonPlayer', { name: p.name })}
            </button>
          ))}
        </div>
        <button style={{ ...ui.btnGhost, marginTop: 8, width: '100%' }} onClick={() => setMode(null)}>
          {t('witch.backFromPoison')}
        </button>
      </div>
    );
  }

  return (
    <div>
      <p style={{ marginBottom: 10, fontWeight: 700, textAlign: 'center' }}>
        {victim ? t('witch.tonightVictim', { name: nameOf(victim) }) : t('witch.peaceful')}
      </p>
      <div style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center', marginBottom: 10 }}>
        {t('witch.potionStatus', {
          heal: potions.heal ? '✅' : t('witch.used'),
          poison: potions.poison ? '✅' : t('witch.used'),
        })}
        {selfBlocked && t('witch.noSelfHeal')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {canHeal && (
          <button style={{ ...ui.btnGhost, color: 'var(--accent)' }}
            onClick={() => act({ type: 'witch', heal: true })}>
            {t('witch.useHeal', { name: nameOf(victim) })}
          </button>
        )}
        {potions.poison && (
          <button style={{ ...ui.btnGhost, color: 'var(--danger)' }}
            onClick={() => setMode('poison')}>{t('witch.usePoison')}</button>
        )}
        <button style={ui.btnGhost} onClick={() => act({ type: 'witch' })}>{t('witch.skip')}</button>
      </div>
    </div>
  );
}

// The hunter fires. Note that this component must also render for a hunter who is already eliminated --
// he is shooting precisely because he died.
//
// The crux of the information hiding is the aiming step: the hunter's target selection exists only in his
// own browser (the `aiming` state below is local and never goes through the server), and all anyone else
// ever sees is the line "the hunter is choosing". Never send the in-progress aim to the server for some
// kind of "aiming effect" -- that would show the whole room where the muzzle is pointing before he pulls
// the trigger, and the player being aimed at could jump in to defend himself first.
function HunterShot({ state, act, nameOf, alivePlayers, t }) {
  // Local aiming state: used only for the confirmation step, never reported. null = nothing chosen yet
  const [aiming, setAiming] = useState(null);

  if (!state.iAmShooting) {
    return (
      <div style={{ textAlign: 'center' }}>
        <div className="hunter-wait" style={{ fontSize: 40, marginBottom: 6 }}>🔫</div>
        <p style={{ color: 'var(--muted)' }}>
          {t('hunter.waiting', { name: nameOf(state.pendingHunter) })}
        </p>
      </div>
    );
  }

  // A target has been picked → ask for confirmation. Firing cannot be undone, and a misclick is far too
  // costly.
  if (aiming) {
    return (
      <div style={{ textAlign: 'center' }}>
        <p style={{ marginBottom: 10, fontWeight: 700 }}>{t('hunter.confirm')}</p>
        <div className="hunter-aim" style={{
          fontSize: 38, margin: '0 auto 10px', width: 76, height: 76, lineHeight: '76px',
          borderRadius: '50%', border: '2px solid var(--danger)',
        }}>🎯</div>
        <p style={{ marginBottom: 12, color: 'var(--danger)', fontWeight: 700 }}>
          {t('hunter.takeDown', { name: nameOf(aiming) })}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button style={{ ...ui.btnAccent, background: 'var(--danger)' }}
            onClick={() => act({ type: 'hunter_shoot', target: aiming })}>{t('hunter.confirmShoot')}</button>
          <button style={ui.btnGhost} onClick={() => setAiming(null)}>{t('hunter.reselect')}</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <p style={{ marginBottom: 10, fontWeight: 700, textAlign: 'center' }}>{t('hunter.youAreOut')}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {alivePlayers.map((p) => (
          <button key={p.id} style={{ ...ui.btnGhost, color: 'var(--danger)' }}
            onClick={() => setAiming(p.id)}>{t('hunter.aim', { name: p.name })}</button>
        ))}
        <button style={ui.btnGhost} onClick={() => act({ type: 'hunter_shoot', target: null })}>
          {t('hunter.holdFire')}
        </button>
      </div>
    </div>
  );
}

// Night actions: the wolves choose a kill, the seer checks a player. After acting a waiting state is
// shown (the choice can still be changed, until everyone has acted or the timer runs out and day breaks).
function NightActions({ state, act, me, alivePlayers, t }) {
  const targets = alivePlayers.filter((p) => p.id !== me.id);
  const acted = state.iActed;

  if (state.myRole === 'wolf') {
    return (
      <div>
        <p style={{ marginBottom: 10, fontWeight: 700, textAlign: 'center' }}>{t('night.wolfPick')}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {targets.map((p) => (
            <button key={p.id} style={{ ...ui.btnGhost, color: 'var(--danger)' }}
              onClick={() => act({ type: 'wolf_kill', target: p.id })}>{t('night.kill', { name: p.name })}</button>
          ))}
        </div>
        {acted && <WaitHint text={t('night.wolfActed')} />}
      </div>
    );
  }
  if (state.myRole === 'seer') {
    // Unlike the wolves: the seer gets one check per night and cannot change it. Once she has checked,
    // the buttons are disabled -- otherwise players keep clicking and only get the server's "you have
    // already checked tonight" alert.
    return (
      <div>
        <p style={{ marginBottom: 10, fontWeight: 700, textAlign: 'center' }}>
          {acted ? t('night.seerDone') : t('night.seerPick')}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {targets.map((p) => (
            <button key={p.id} disabled={acted}
              style={{ ...ui.btnGhost, ...(acted ? { opacity: 0.45, cursor: 'not-allowed' } : null) }}
              onClick={() => act({ type: 'seer_check', target: p.id })}>{t('night.check', { name: p.name })}</button>
          ))}
        </div>
        {acted && <WaitHint text={t('night.seerActed')} />}
      </div>
    );
  }
  return <p style={{ color: 'var(--muted)', textAlign: 'center' }}>{t('night.sleep')}</p>;
}

// Daytime: discussion and voting (the same phase). The list is clickable and the vote can be changed at
// any time; the current vote is highlighted; when the countdown expires the server settles the result.
function DayVote({ state, act, me, alivePlayers, nameOf, t }) {
  const myVote = state.myVote;               // the current vote: a player id, null (abstain), or undefined (not voted)
  const voted = state.iVoted;
  const candidates = alivePlayers.filter((p) => p.id !== me.id);
  return (
    <div>
      <p style={{ marginBottom: 6, textAlign: 'center' }}>
        {victimNames(state.lastNightVictim, nameOf, t) || t('wolf.nobodyDied')}
      </p>
      <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 12, textAlign: 'center' }}>
        {t('vote.instructions')}
        {state.cfg?.tiePk ? t('vote.tiePk') : t('vote.tieNone')}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {candidates.map((p) => {
          const picked = myVote === p.id;
          return (
            <button key={p.id}
              style={{ ...ui.btnGhost, ...(picked ? { borderColor: 'var(--accent)', color: 'var(--accent)', fontWeight: 800 } : {}) }}
              onClick={() => act({ type: 'vote', target: p.id })}>
              {picked ? '✓ ' : ''}{t('vote.votePlayer', { name: p.name })}
            </button>
          );
        })}
        <button
          style={{ ...ui.btnGhost, color: 'var(--muted)', ...(voted && myVote == null ? { borderColor: 'var(--accent)' } : {}) }}
          onClick={() => act({ type: 'vote', target: null })}>
          {voted && myVote == null ? '✓ ' : ''}{t('vote.abstain')}
        </button>
      </div>
      {!voted && <WaitHint text={t('vote.notVoted')} />}
      {state.dayAllVoted && (
        <p style={{ color: 'var(--accent)', fontSize: 13, marginTop: 10, textAlign: 'center' }}>
          {t('vote.allVoted')}
        </p>
      )}
    </div>
  );
}

// PK tie-breaker: the tied players become the candidates. Candidates do not vote in this round (they
// await the verdict); every other living player must pick one of the candidates (or abstain).
function PkVote({ state, act, nameOf, t }) {
  const cands = state.pkCandidates || [];
  const iAmCand = state.iAmPkCandidate;
  const myVote = state.myVote;
  const voted = state.iVoted;
  return (
    <div>
      <p style={{ marginBottom: 6, textAlign: 'center', fontWeight: 800, color: 'var(--danger)' }}>
        {t('pk.title', { names: cands.map(nameOf).join(' vs ') })}
      </p>
      <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 12, textAlign: 'center' }}>
        {iAmCand ? t('pk.iAmCandidate') : t('pk.chooseOne')}
      </p>
      {iAmCand ? (
        <WaitHint text={t('pk.waitingVerdict')} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {cands.map((id) => {
            const picked = myVote === id;
            return (
              <button key={id}
                style={{ ...ui.btnGhost, ...(picked ? { borderColor: 'var(--accent)', color: 'var(--accent)', fontWeight: 800 } : {}) }}
                onClick={() => act({ type: 'pk_vote', target: id })}>
                {picked ? '✓ ' : ''}{t('vote.votePlayer', { name: nameOf(id) })}
              </button>
            );
          })}
          <button
            style={{ ...ui.btnGhost, color: 'var(--muted)', ...(voted && myVote == null ? { borderColor: 'var(--accent)' } : {}) }}
            onClick={() => act({ type: 'pk_vote', target: null })}>
            {voted && myVote == null ? '✓ ' : ''}{t('vote.abstain')}
          </button>
        </div>
      )}
      {state.dayAllVoted && (
        <p style={{ color: 'var(--accent)', fontSize: 13, marginTop: 10, textAlign: 'center' }}>
          {t('pk.allVoted')}
        </p>
      )}
    </div>
  );
}

// Discussion area. Living players may speak publicly during the day and PK phases (they are muted at
// night); dead players and spectators use the dead channel (visible only to the dead and spectators).
// These speaking rules mirror the server's -- the server is the authority, and all we do here is hide the
// input box from people who are not allowed to speak.
function ChatPanel({ state, act, messages, chatEndRef, isSpectator, iAmAlive, t }) {
  const [text, setText] = useState('');
  const dead = !isSpectator && iAmAlive === false;
  // During the speech phase only the player whose turn it is may talk; during the voting phases (day/pk)
  // everyone discusses freely.
  const canSpeakPublic = iAmAlive && (
    state.phase === 'day' || state.phase === 'pk' ||
    (state.phase === 'speech' && state.iAmSpeaking)
  );
  // Spectators cannot speak at all (the server rejects it); dead players can post on the dead channel;
  // living players follow the rule above.
  const canSend = !isSpectator && (dead || canSpeakPublic);
  const send = () => {
    const t = text.trim();
    if (!t) return;
    act({ type: 'chat', text: t });
    setText('');
  };
  return (
    <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <label style={ui.label}>
        {t('chat.title')}{dead ? t('chat.deadChannel') : ''}
      </label>
      <div style={{ maxHeight: 180, overflowY: 'auto', display: 'flex', flexDirection: 'column',
                    gap: 4, fontSize: 14, marginBottom: 8 }}>
        {messages.length === 0 && (
          <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>{t('chat.empty')}</p>
        )}
        {messages.map((m) => (
          <div key={m.id} style={{ color: m.channel === 'dead' ? 'var(--muted)' : 'var(--text)' }}>
            {m.channel === 'dead' && '💀 '}
            <b>{m.name}</b>:{m.text}
          </div>
        ))}
        <div ref={chatEndRef} />
      </div>
      {canSend ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            style={{ ...ui.input, marginBottom: 0, flex: 1 }}
            value={text} maxLength={300}
            placeholder={dead ? t('chat.deadPlaceholder') : t('chat.placeholder')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          />
          <button style={ui.btnAccent} onClick={send}>{t('common.send')}</button>
        </div>
      ) : (
        <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>
          {isSpectator ? t('chat.spectator')
            : state.phase === 'night' ? t('chat.nightMuted')
            : state.phase === 'speech' ? t('chat.waitTurn')
            : t('chat.cannotSpeak')}
        </p>
      )}
    </div>
  );
}

function WaitHint({ text }) {
  return <p style={{ color: 'var(--muted)', fontSize: 13, textAlign: 'center', marginTop: 12 }}>{text}</p>;
}
