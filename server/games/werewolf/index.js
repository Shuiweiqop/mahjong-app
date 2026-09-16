// Werewolf -- server-authoritative game module.
// Roles: wolf / seer / witch / hunter / villager (gods come into play based on player count, see godCountFor).
//
// Implements the platform's shared game interface:
//   createInitialState(players, config)
//   applyAction(state, action, playerId) -> { state, events, error }
//   serializeStateFor(state, playerId)   -> per-role view (wolves see teammates, seer sees checks, witch sees the kill target)
//   isGameOver(state)                    -> { over, winner } | false
//
// Phase state machine:
//   lobby → reveal → night → [witch] → [hunter] → speech → day → [pk] → [hunter] → night → …
//                                                                                    ↘ ended
//   witch  is inserted only when a living witch exists (she must see the kill target before deciding whether to use the healing potion)
//   hunter is inserted only when the hunter is eliminated and can still shoot; afterwards it returns to the phase named by resumeTo
//   speech takes turns, only one person may talk at a time; only after everyone has spoken does it move to the day vote
//   pk     is inserted on a daytime tie when the host has enabled tiePk
//
// All phase durations are configured by the host (see DEFAULTS / TIME_OPTIONS), never hardcoded.
// When time runs out the server tick always advances things as a fallback, so nobody's disconnect or idling can deadlock the game.
// Pure logic, touches neither socket nor db, which makes it easy to test (see rules.test.js).

const ROLE = { WOLF: 'wolf', SEER: 'seer', WITCH: 'witch', HUNTER: 'hunter', VILLAGER: 'villager' };

// Role → faction. Side-wipe victories are decided by faction (wolves win by wiping out the "villager side" or the "god side").
// A new role only needs its faction registered here, checkWin needs no change (this avoids enumerating concrete roles in several places).
const FACTION = { wolf: 'wolf', god: 'god', villager: 'villager' };
const ROLE_FACTION = {
  [ROLE.WOLF]: FACTION.wolf,
  [ROLE.SEER]: FACTION.god,
  [ROLE.WITCH]: FACTION.god,
  [ROLE.HUNTER]: FACTION.god,
  [ROLE.VILLAGER]: FACTION.villager,
};
const factionOf = (role) => ROLE_FACTION[role];

// Order in which gods enter play: the more players, the more gods. Small games stay brisk (seer only),
// medium games add the witch, large games add the hunter as well. Once there are >= 2 gods the god-side-wipe rule automatically comes back (see checkWin).
const GOD_ORDER = [ROLE.SEER, ROLE.WITCH, ROLE.HUNTER];
function godCountFor(n) {
  if (n >= 10) return 3;
  if (n >= 7) return 2;
  return 1;
}

// Default duration (in seconds) of each phase. When time runs out the server timer (tick) advances things as a fallback, so nobody's disconnect or idling can deadlock the game.
// All of them can be adjusted by the host in the lobby -- the pacing different groups want varies a lot (offline players
// are used to long speeches, online players have shorter patience), so any hardcoded value is bound to annoy half of them. Actual values always come from s.cfg,
// these are only the defaults and the fallback for "not configured".
const DEFAULTS = {
  tiePk: true,
  revealSeconds: 30,   // Role reveal: waits for everyone to click "enter game"; this grace timeout only exists so one person not clicking cannot stall the game
  nightSeconds: 40,    // Night: wolves pick a kill target + seer checks
  speechSeconds: 45,   // Time limit for a single player's speech; when done they click "pass", or it automatically moves to the next player on timeout
  daySeconds: 60,      // Voting phase: votes can be changed at any time, resolved when time runs out
  pkSeconds: 30,       // Tie PK: the tied players enter the PK, the other living players vote again in one more round
  witchSeconds: 25,    // Witch potions: a separate segment after the wolf kill is resolved (she must see the kill target first)
  hunterSeconds: 20,   // Hunter's shot: an immediate reaction after being eliminated, so the time is short
};

// The allowed values for each item (the frontend renders them as a row of buttons, and they double as the server's whitelist).
// The client can forge any config it likes, so the values have to be validated here and cannot rely on frontend restrictions alone.
const TIME_OPTIONS = {
  revealSeconds: [15, 30, 45, 60],
  nightSeconds: [30, 40, 60, 90],
  speechSeconds: [20, 30, 45, 60, 90],
  daySeconds: [30, 45, 60, 90, 120],
  pkSeconds: [20, 30, 45, 60],
  witchSeconds: [15, 25, 40, 60],
  hunterSeconds: [15, 20, 30, 45],
};

const DAY_HURRY_SECONDS = 5; // Once everyone has voted during the day, shorten the countdown to this -- it leaves a window for changing votes instead of resolving immediately
const CHAT_MAX = 300;        // Maximum length of a single message, to prevent spam

// Normalize the config passed in by the host: any value not in the whitelist falls back to the default, so that a forged config cannot
// set a phase to 0 seconds (skipped instantly) or 99999 seconds (the whole game stuck).
function normalizeConfig(cfg = {}) {
  const out = { tiePk: cfg.tiePk !== false };
  for (const [key, options] of Object.entries(TIME_OPTIONS)) {
    out[key] = options.includes(cfg[key]) ? cfg[key] : DEFAULTS[key];
  }
  return out;
}

const now = () => Date.now();

// Decide the number of wolves from the player count
function wolfCount(n) {
  if (n >= 10) return 3;
  if (n >= 7) return 2;
  return 1;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Create the initial state ──
function createInitialState(players, config = {}) {
  const ids = players.map((p) => p.id);
  const nWolf = wolfCount(ids.length);
  const nGod = Math.min(godCountFor(ids.length), Math.max(0, ids.length - nWolf - 1));
  const shuffled = shuffle(ids);
  const roles = {};
  shuffled.forEach((id, i) => {
    if (i < nWolf) roles[id] = ROLE.WOLF;
    else if (i < nWolf + nGod) roles[id] = GOD_ORDER[i - nWolf];
    else roles[id] = ROLE.VILLAGER;
  });
  return {
    phase: 'lobby',                       // lobby | reveal | night | day | pk | ended
    cfg: normalizeConfig(config),   // Host config (phase durations + tie PK)
    players: players.map((p) => ({ id: p.id, name: p.name })),
    roles,                                // { playerId: role } (internal, never sent out as a whole)
    alive: Object.fromEntries(ids.map((id) => [id, true])),
    absent: {},                           // Disconnected/departed players { playerId: true }; still counted as alive but excluded from the advancement checks
    round: 0,
    nightActions: {},                     // Tonight: { wolfTargetVotes:{voterId:targetId}, seerCheck:{seerId,targetId} }
    seerResults: {},                      // { seerId: { [targetId]: 'wolf'|'good' } } accumulated check results
    // Witch: one use of each of the two potions for the whole game. The house rule is "self-heal allowed on the first night, not after", so we need to remember which night a potion was used.
    potions: { heal: true, poison: true },
    // Hunter: the chance to shoot. Being poisoned to death means no shot (standard rule), so we have to distinguish causes of death, see killPlayer.
    hunterCanShoot: true,
    pendingHunter: null,                  // Id of the hunter waiting to shoot; null outside the hunter phase
    votes: {},                            // Daytime vote: { voterId: targetId|null } (votes can be changed)
    speechOrder: null,                    // Speaking queue [playerId]; null outside the speech phase
    speechIndex: 0,                       // Which entry of the queue is speaking right now
    pkCandidates: null,                   // Candidates in the PK runoff [id,id]; null outside the PK phase
    ready: {},                            // Role reveal: players who have clicked "enter game" { playerId: true }
    deadline: null,                       // Deadline timestamp (ms) of the current phase; tick advances things as a fallback when it passes
    pausedRemainMs: null,                 // Remaining duration suspended when everyone is disconnected; used to reset the deadline after a reconnect
    log: [],                              // Public event log
    lastNightVictim: null,
    lastVotedOut: null,
    winner: null,                         // 'wolf' | 'good'
    hostId: players[0]?.id || null,
  };
}

const aliveIds = (s) => s.players.map((p) => p.id).filter((id) => s.alive[id]);
const aliveWolves = (s) => aliveIds(s).filter((id) => s.roles[id] === ROLE.WOLF);
// Present = alive and not disconnected. Used only for the "who are we still waiting on" advancement checks;
// win conditions always use aliveIds -- a disconnect is not an elimination, otherwise quitting the game would simply hand the win to the other side.
const presentIds = (s) => aliveIds(s).filter((id) => !s.absent[id]);
// Whether a faction existed at the start of the game, and whether it has been wiped out entirely (0 alive). A side wipe only counts for factions that existed at the start,
// which avoids declaring an instant wolf win in a small game where one side has 0 members.
const factionExists = (s, f) => Object.values(s.roles).some((r) => factionOf(r) === f);
const factionWiped = (s, f) =>
  factionExists(s, f) && !aliveIds(s).some((id) => factionOf(s.roles[id]) === f);

// How many gods a side must have at minimum before "wipe out the god side" is a meaningful win condition.
// With only 1 god (the current setup has just the seer) the god-side wipe degenerates into "kill one specific person on the first night and win":
// measured with wolves killing blind, 20% of 6-player games and 17% of 8-player games end before the first day even begins,
// with nobody else having said a word or cast a vote. Once the witch/hunter are added later (FACTION.god having more than 2 members),
// the god-side wipe automatically takes effect again with no further change needed here.
const MIN_GODS_FOR_WIPE_RULE = 2;

// Check the win conditions; if there is a result, set the phase to ended.
//   Good wins -- all wolves are eliminated.
//   Wolves win -- the villager side is wiped out; or the god side is wiped out (only when there are enough gods); or the number of wolves >= the number of good players (the wolves can
//                 force-vote anybody out, so the outcome is settled and playing on would just be going through the motions).
// Factions are derived from ROLE_FACTION, so adding a new role needs no change here.
function checkWin(s) {
  if (aliveWolves(s).length === 0) { s.winner = 'good'; s.phase = 'ended'; return true; }

  const wolves = aliveWolves(s).length;
  const good = aliveIds(s).length - wolves;
  const godCount = Object.values(s.roles).filter((r) => factionOf(r) === FACTION.god).length;

  if (
    wolves >= good ||
    factionWiped(s, FACTION.villager) ||
    (godCount >= MIN_GODS_FOR_WIPE_RULE && factionWiped(s, FACTION.god))
  ) {
    s.winner = 'wolf'; s.phase = 'ended'; return true;
  }
  return false;
}

// Enter the role reveal (untimed, waits for every living player to click "enter game"; carries a grace timeout so one person not clicking cannot stall it)
// Set the deadline of the current phase. Every entry into a new phase goes through here, and it clears any suspended remaining duration along the way --
// otherwise a "phase change during a suspension" would leave a stale pausedRemainMs behind, which would set the new phase's clock wrong on reconnect.
function setDeadline(s, seconds) {
  s.deadline = now() + seconds * 1000;
  s.pausedRemainMs = null;
}

function enterReveal(s) {
  s.phase = 'reveal';
  s.ready = {};
  setDeadline(s, s.cfg.revealSeconds);
}

// Enter the night
function enterNight(s) {
  s.round += 1;
  s.phase = 'night';
  s.nightActions = { wolfTargetVotes: {}, seerCheck: null, witch: null, victim: null };
  setDeadline(s, s.cfg.nightSeconds);
  s.log.push({ type: 'phase', phase: 'night', round: s.round });
}

// The witch has to "see the kill target" before she can decide whether to save them, so the night must be split into two segments:
// first resolve the wolf kill to settle the victim, then give the witch a separate stretch of time to use her potions. When there is no witch this segment is skipped entirely.
function enterWitchTurn(s) {
  s.phase = 'witch';
  setDeadline(s, s.cfg.witchSeconds);
}

// The single entry point for death. Every path that eliminates someone goes through here, and the benefit is that the hunter trigger is written only once --
// missing any one path would produce the bizarre bug of "the hunter doesn't shoot when killed in a particular way".
// cause: 'wolf' | 'vote' | 'poison' | 'shot' | 'leave'
// Returns whether the hunter's shot was triggered (the caller uses this to decide whether to stop and wait for him).
function killPlayer(s, id, cause) {
  if (!id || !s.alive[id]) return false;
  s.alive[id] = false;
  // A hunter poisoned to death cannot shoot (standard rule: the poison leaves him no time to react). Every other cause of death allows it.
  if (s.roles[id] === ROLE.HUNTER && s.hunterCanShoot && cause !== 'poison') {
    s.pendingHunter = id;
    return true;
  }
  return false;
}

// Enter the hunter's shooting phase. This is the only phase that interrupts the normal day/night cycle; afterwards resumeAfterHunter
// returns to wherever the game was supposed to go.
function enterHunterTurn(s) {
  s.phase = 'hunter';
  setDeadline(s, s.cfg.hunterSeconds);
  s.log.push({ type: 'hunter_turn', playerId: s.pendingHunter });
}

// Enter the daytime speeches: players take turns by seat, only one person may talk at a time, everyone else can only watch.
//
// This is a core mechanic of Werewolf, not a nice-to-have -- fake claims, counter-claims and talking a wolf into the ground all rest on "taking turns to speak".
// If simultaneous spamming were allowed, a wolf could just spam furiously to bury the seer's report, and it would become a contest of who types fastest.
//
// The order starts from "the player after the last person who died" (the offline convention: the player after the dead one speaks first), and the dead are not in the queue.
// Once everyone has spoken → move to the vote.
function enterSpeech(s) {
  const order = aliveIds(s);
  if (!order.length) { enterDay(s); return; }

  // Starting point: the player after the last eliminated one in the original seating; with no dead player (the first day) start from 0
  const seats = s.players.map((p) => p.id);
  const lastDead = Array.isArray(s.lastNightVictim) ? s.lastNightVictim[0] : s.lastNightVictim;
  let start = 0;
  if (lastDead) {
    const seat = seats.indexOf(lastDead);
    if (seat >= 0) {
      for (let i = 1; i <= seats.length; i++) {
        const idx = order.indexOf(seats[(seat + i) % seats.length]);
        if (idx >= 0) { start = idx; break; }
      }
    }
  }

  s.phase = 'speech';
  s.speechOrder = [...order.slice(start), ...order.slice(0, start)];
  s.speechIndex = 0;
  setDeadline(s, s.cfg.speechSeconds);
  s.log.push({ type: 'phase', phase: 'speech', round: s.round, order: s.speechOrder });
}

// Move on to the next speaker; once everyone has spoken, go to the vote.
// Disconnected/eliminated players are skipped automatically -- otherwise the whole table would sit through a full 45 seconds for somebody who cannot talk.
function nextSpeaker(s) {
  for (let i = s.speechIndex + 1; i < s.speechOrder.length; i++) {
    const id = s.speechOrder[i];
    if (s.alive[id] && !s.absent[id]) {
      s.speechIndex = i;
      setDeadline(s, s.cfg.speechSeconds);
      return;
    }
  }
  enterDay(s);
}

const currentSpeaker = (s) =>
  s.phase === 'speech' ? ((s.speechOrder || [])[s.speechIndex] ?? null) : null;

// Enter the voting phase: the speeches are over, this phase is only for voting.
// Players can change their vote at any time within the time limit; it resolves when time runs out (tick) or once everyone has voted.
function enterDay(s) {
  s.phase = 'day';
  s.votes = {};
  s.speechOrder = null;
  s.speechIndex = 0;
  setDeadline(s, s.cfg.daySeconds);
  s.log.push({ type: 'phase', phase: 'day', round: s.round });
}

// First segment of the night: settle the wolves' kill target (nobody has actually died yet -- the witch may save them).
// If there is a living witch, enter the witch phase and let her decide; otherwise resolve right away.
function resolveNight(s) {
  const votes = s.nightActions.wolfTargetVotes || {};
  const tally = {};
  Object.values(votes).forEach((t) => { tally[t] = (tally[t] || 0) + 1; });
  let victim = null, max = 0;
  for (const [t, c] of Object.entries(tally)) { if (c > max) { max = c; victim = t; } }

  s.nightActions.victim = victim && s.alive[victim] ? victim : null;

  const witch = s.players.find((p) => s.roles[p.id] === ROLE.WITCH && s.alive[p.id]);
  const hasPotion = s.potions.heal || s.potions.poison;
  if (witch && hasPotion && !s.absent[witch.id]) { enterWitchTurn(s); return; }
  finishNight(s);
}

// Second segment of the night: resolve the wolf kill and the witch's potion use together.
// Saving someone merely cancels the wolf kill, it is not a "resurrection", so the order is to check heal first and only then apply the deaths.
function finishNight(s) {
  const w = s.nightActions.witch || {};
  const victim = s.nightActions.victim;
  const deaths = [];

  if (victim && !w.heal) deaths.push({ id: victim, cause: 'wolf' });
  if (w.poison) deaths.push({ id: w.poison, cause: 'poison' });

  let hunterTriggered = false;
  for (const d of deaths) {
    if (killPlayer(s, d.id, d.cause)) hunterTriggered = true;
  }

  s.lastNightVictim = deaths.length ? deaths.map((d) => d.id) : null;
  s.log.push({ type: 'night_result', victim: s.lastNightVictim });
  s.nightActions.victim = null;

  if (checkWin(s)) return;
  // When the hunter is the one killed, let him shoot first and only then move on to the daytime speeches
  if (hunterTriggered) { s.resumeTo = 'day'; enterHunterTurn(s); return; }
  enterSpeech(s);
}

// Count the votes: returns whoever got the most votes. max is the highest vote count, leaders is everyone tied at that highest count (possibly 1 or several).
// Abstentions (null) do not count. When nobody voted, leaders is empty.
function tallyVotes(votes) {
  const tally = {};
  Object.values(votes).forEach((t) => { if (t) tally[t] = (tally[t] || 0) + 1; });
  let max = 0;
  for (const c of Object.values(tally)) if (c > max) max = c;
  const leaders = Object.keys(tally).filter((t) => tally[t] === max);
  return { tally, max, leaders };
}

// Exile a player, write the log, check the win conditions, and move on to the next night. out being null means nobody is eliminated.
function exileAndAdvance(s, out) {
  const hunterTriggered = out && s.alive[out] ? killPlayer(s, out, 'vote') : false;
  s.lastVotedOut = out && !s.alive[out] ? out : null;
  s.log.push({ type: 'vote_result', out: s.lastVotedOut });
  if (checkWin(s)) return;
  // A hunter who is voted out gets to shoot and take somebody with him before the night begins
  if (hunterTriggered) { s.resumeTo = 'night'; enterHunterTurn(s); return; }
  enterNight(s);
}

// The hunter's shot is over (taken, declined or timed out) → return to the phase the game was supposed to go to.
function resumeAfterHunter(s) {
  const to = s.resumeTo === 'night' ? 'night' : 'day';
  s.pendingHunter = null;
  s.resumeTo = null;
  if (checkWin(s)) return;
  // When returning to the day it has to be the "speech" phase rather than the vote directly -- the gunshot itself is important information,
  // and everyone needs the speeches to digest it.
  if (to === 'night') enterNight(s); else enterSpeech(s);
}

// Resolve the daytime vote:
//   a single highest vote count → exile;
//   a tie → if tiePk is enabled and this is the first round of voting (not the PK phase) → go to the PK runoff; otherwise nobody is eliminated.
function resolveVote(s) {
  const { max, leaders } = tallyVotes(s.votes);
  if (leaders.length === 1 && max > 0) { exileAndAdvance(s, leaders[0]); return; }
  // A tie or nobody voted. A first-round tie with PK enabled and >= 2 tied players → go to the PK
  if (s.cfg.tiePk && leaders.length >= 2) { enterPk(s, leaders); return; }
  exileAndAdvance(s, null); // No votes / a tie with PK disabled → nobody is eliminated
}

// Enter the PK runoff: the tied players become the candidates, and the remaining living players vote again in one more round (candidates do not vote).
function enterPk(s, candidates) {
  s.phase = 'pk';
  s.pkCandidates = candidates;
  s.votes = {};
  setDeadline(s, s.cfg.pkSeconds);
  s.log.push({ type: 'phase', phase: 'pk', round: s.round, candidates });
}

// Resolve the PK vote: a single highest vote count gets exiled; another tie → nobody is eliminated (no endless PK).
function resolvePk(s) {
  const { max, leaders } = tallyVotes(s.votes);
  s.pkCandidates = null;
  exileAndAdvance(s, leaders.length === 1 && max > 0 ? leaders[0] : null);
}

// ── Apply an action ──
// { type:'start' }                the host starts the game
// { type:'wolf_kill', target }    wolves vote to kill somebody (night)
// { type:'seer_check', target }   the seer checks somebody (night)
// { type:'vote', target }         daytime vote (target may be null to abstain)
function applyAction(s, action, playerId) {
  const events = [];
  const isAlive = s.alive[playerId];

  // Spectators (and any id not in this game) cannot act. tick is driven by the server, with playerId being null.
  // The speech case matters most here: a spectator is not in the alive table, so they would be treated as a dead player and routed into the dead channel,
  // meaning a spectator with the god view turned on could broadcast every role they can see straight to all the dead players.
  if (action.type !== 'tick' && !(playerId in s.alive)) {
    return { error: 'game.notAPlayer' };
  }

  switch (action.type) {
    case 'start': {
      if (playerId !== s.hostId) return { error: 'room.hostOnlyStart' };
      if (s.phase !== 'lobby') return { error: 'room.alreadyStarted' };
      if (s.players.length < 4) return { error: 'wolf.needFour' };
      enterReveal(s);   // Go to the role reveal first and wait for everyone to click "enter game" before the night begins (the clock only starts at night)
      return { state: s, events };
    }

    // Role reveal: a player clicking "enter game" means they have finished looking at their role. Once every living player is ready (or the grace timeout fires) → go to the night.
    case 'ready': {
      if (s.phase !== 'reveal') return { state: s, events }; // Idempotent: ignored outside the reveal phase
      s.ready[playerId] = true;
      if (presentIds(s).every((id) => s.ready[id])) enterNight(s);
      return { state: s, events };
    }

    case 'wolf_kill': {
      if (s.phase !== 'night') return { error: 'wolf.notNight' };
      if (!isAlive || s.roles[playerId] !== ROLE.WOLF) return { error: 'wolf.onlyLiveWolf' };
      if (!s.alive[action.target]) return { error: 'game.badTarget' };
      s.nightActions.wolfTargetVotes[playerId] = action.target;
      // Every living wolf has voted + the seer has finished checking (if there is a living seer) → resolve the night
      maybeResolveNight(s);
      return { state: s, events };
    }

    case 'seer_check': {
      if (s.phase !== 'night') return { error: 'wolf.notNight' };
      if (!isAlive || s.roles[playerId] !== ROLE.SEER) return { error: 'wolf.onlySeer' };
      // Only one check per night. seerResults accumulates across nights, so unlike the wolves' wolfTargetVotes it is not
      // overwritten per player id -- without this gate the seer could check the entire table in a single night and read out every wolf at dawn.
      if (s.nightActions.seerCheck) return { error: 'wolf.alreadyChecked' };
      if (!s.alive[action.target]) return { error: 'game.badTarget' };
      if (action.target === playerId) return { error: 'wolf.noCheckSelf' };
      const result = s.roles[action.target] === ROLE.WOLF ? 'wolf' : 'good';
      s.seerResults[playerId] = s.seerResults[playerId] || {};
      s.seerResults[playerId][action.target] = result;
      s.nightActions.seerCheck = { seerId: playerId, targetId: action.target };
      maybeResolveNight(s);
      return { state: s, events };
    }

    // The witch uses a potion. { heal: true } saves the kill target / { poison: targetId } poisons somebody / neither = skip.
    // Only one potion per night (standard rule), and a potion that has been used up cannot be used again.
    case 'witch': {
      if (s.phase !== 'witch') return { error: 'wolf.notWitchPhase' };
      if (!isAlive || s.roles[playerId] !== ROLE.WITCH) return { error: 'wolf.onlyLiveWitch' };
      if (s.nightActions.witch) return { error: 'wolf.alreadyActed' };

      const { heal, poison } = action;
      if (heal && poison) return { error: 'wolf.onePotionPerNight' };

      if (heal) {
        if (!s.potions.heal) return { error: 'wolf.healUsed' };
        if (!s.nightActions.victim) return { error: 'wolf.noVictimTonight' };
        // Self-healing is allowed on the first night but not afterwards -- otherwise the witch would be nearly invincible
        if (s.nightActions.victim === playerId && s.round > 1) return { error: 'wolf.noSelfHeal' };
        s.potions.heal = false;
        s.nightActions.witch = { heal: true };
      } else if (poison) {
        if (!s.potions.poison) return { error: 'wolf.poisonUsed' };
        if (!s.alive[poison]) return { error: 'game.badTarget' };
        if (poison === playerId) return { error: 'wolf.noPoisonSelf' };
        s.potions.poison = false;
        s.nightActions.witch = { poison };
      } else {
        s.nightActions.witch = {};   // An explicit skip
      }
      finishNight(s);
      return { state: s, events };
    }

    // End your own speech ("pass"). Only the current speaker can pass, which stops somebody else from skipping them.
    case 'pass_speech': {
      if (s.phase !== 'speech') return { error: 'wolf.notSpeechPhase' };
      if (playerId !== currentSpeaker(s)) return { error: 'wolf.notSpeakingNow' };
      nextSpeaker(s);
      return { state: s, events };
    }

    // The hunter's shot: the moment he is eliminated he takes a living player with him. target being null means he declines.
    case 'hunter_shoot': {
      if (s.phase !== 'hunter') return { error: 'wolf.notHunterPhase' };
      if (playerId !== s.pendingHunter) return { error: 'wolf.notYourShot' };
      s.hunterCanShoot = false;
      const target = action.target;
      if (target) {
        if (!s.alive[target]) return { error: 'game.badTarget' };
        killPlayer(s, target, 'shot');   // If the person shot by the hunter is himself a hunter, the shot is already spent so it will not trigger again
        s.log.push({ type: 'hunter_shot', playerId, target });
      } else {
        s.log.push({ type: 'hunter_shot', playerId, target: null });
      }
      resumeAfterHunter(s);
      return { state: s, events };
    }

    // Daytime vote (discussion and voting share the phase): votes can be changed at any time within the time limit, target being null is an abstention.
    // It only resolves when the countdown ends (see tick), never early -- this keeps the promise that "votes can be changed within the time limit" always true.
    case 'vote': {
      if (s.phase !== 'day') return { error: 'wolf.notDayVote' };
      if (!isAlive) return { error: 'wolf.deadCannotVote' };
      if (action.target && !s.alive[action.target]) return { error: 'game.badTarget' };
      s.votes[playerId] = action.target || null;
      hurryDayIfAllVoted(s);   // Everyone has voted → shorten the countdown to DAY_HURRY_SECONDS (votes can still be changed)
      return { state: s, events };
    }

    // PK runoff vote: only living non-candidates can vote, and they can only vote for one of the candidates (or abstain).
    case 'pk_vote': {
      if (s.phase !== 'pk') return { error: 'wolf.notPkPhase' };
      if (!isAlive) return { error: 'wolf.deadCannotVote' };
      if (s.pkCandidates.includes(playerId)) return { error: 'wolf.pkCandidateCannotVote' };
      if (action.target && !s.pkCandidates.includes(action.target)) return { error: 'wolf.pkCandidatesOnly' };
      s.votes[playerId] = action.target || null;
      hurryDayIfAllVoted(s);   // Everyone (the living non-candidates) has voted → shorten the countdown
      return { state: s, events };
    }

    // Chat (used for discussion). During the day/PK phases: living players post to the public channel (the dead/spectators can see it too);
    // dead players: they can post during any non-ended phase, but only into the "dead channel" (visible only to the dead + spectators, to prevent spoilers).
    // Living players cannot speak publicly at night (eyes closed in the dark). Channel routing happens in the transport layer (server.js) based on the channel field.
    case 'chat': {
      if (s.phase === 'ended' || s.phase === 'lobby') return { error: 'wolf.cannotSpeak' };
      const text = String(action.text || '').trim().slice(0, CHAT_MAX);
      if (!text) return { state: s, events };
      if (isAlive) {
        // The speech phase: only the current speaker may talk. This is the crux of the whole mechanic --
        // without this check a wolf could spam during someone else's speech and bury their report.
        if (s.phase === 'speech') {
          if (playerId !== currentSpeaker(s)) return { error: 'wolf.notYourSpeech' };
        } else if (s.phase !== 'day' && s.phase !== 'pk') {
          return { error: 'wolf.cannotSpeakPublic' };
        }
        events.push({ type: 'chat', channel: 'alive', playerId, text });
      } else {
        events.push({ type: 'chat', channel: 'dead', playerId, text });
      }
      return { state: s, events };
    }

    // Driven by the server timer: when the current phase's time is up, advance it as a fallback (so a disconnect or idling cannot deadlock the game)
    case 'tick': {
      if (s.phase === 'ended' || !s.deadline || now() < s.deadline) return { state: s, events };
      if (s.phase === 'reveal') {
        // Grace timeout: even with people who still have not clicked "enter game", force the move to the night so it cannot get stuck on the reveal
        enterNight(s);
      } else if (s.phase === 'night') {
        // Wolves who did not act → no kill (no random target is filled in, it is a peaceful night); a seer who did not check → skipped
        resolveNight(s);
      } else if (s.phase === 'witch') {
        // The witch did not use a potion within the time limit → treated as a skip, resolve with the original kill target
        s.nightActions.witch = s.nightActions.witch || {};
        finishNight(s);
      } else if (s.phase === 'hunter') {
        // The hunter did not shoot → treated as declining
        s.hunterCanShoot = false;
        resumeAfterHunter(s);
      } else if (s.phase === 'speech') {
        // Speech timed out → automatically move on to the next player (offline works the same way, when time is up it is somebody else's turn)
        nextSpeaker(s);
      } else if (s.phase === 'day') {
        // Resolve when time is up: anyone who did not vote counts as abstaining, and a tie either goes to the PK or eliminates nobody depending on the config
        resolveVote(s);
      } else if (s.phase === 'pk') {
        // Resolve the PK when time is up: another tie eliminates nobody
        resolvePk(s);
      }
      return { state: s, events };
    }

    default:
      return { error: 'game.unknownAction' };
  }
}

// Which present living players "are supposed to vote" in this phase. Day = everybody; PK = the non-candidates (candidates do not vote in their own round).
function expectedVoters(s) {
  const voters = presentIds(s);
  if (s.phase === 'pk') return voters.filter((id) => !s.pkCandidates.includes(id));
  return voters;
}

// Everyone has voted → move the deadline to DAY_HURRY_SECONDS from now (only shortening it, never extending it).
// "Everyone" = every present living player who is supposed to vote in this phase has a vote recorded (an abstention of null counts as having voted); disconnected players do not block it,
// which keeps this consistent with maybeResolveNight using presentIds. Votes can still be changed after the shortening, and tick resolves it when time is up.
function hurryDayIfAllVoted(s) {
  if ((s.phase !== 'day' && s.phase !== 'pk') || s.deadline == null) return;
  const voters = expectedVoters(s);
  if (voters.length === 0) return;                        // Nobody can vote, so do nothing
  if (!voters.every((id) => id in s.votes)) return;       // Somebody still has not voted
  const hurryUntil = now() + DAY_HURRY_SECONDS * 1000;
  if (hurryUntil < s.deadline) s.deadline = hurryUntil;   // Only move it earlier, never back
}

// Whether the night can be resolved: every living wolf has voted + (there is no living seer, or the seer has checked)
// Only "present" wolves/seers are waited on; disconnected players do not block an early resolution (tick is still the fallback when time is up).
function maybeResolveNight(s) {
  const wolves = presentIds(s).filter((id) => s.roles[id] === ROLE.WOLF);
  const wolvesDone = wolves.every((id) => id in s.nightActions.wolfTargetVotes);
  const seers = presentIds(s).filter((id) => s.roles[id] === ROLE.SEER);
  const seerDone = seers.length === 0 || s.nightActions.seerCheck != null;
  // When every wolf is disconnected, wolves is empty and every is trivially true -- we must not resolve a no-kill night right here, leave it to tick when time is up,
  // otherwise the night would be resolved instantly the moment they disconnect.
  if (wolves.length === 0) return;
  if (wolvesDone && seerDone) resolveNight(s);
}

// ── Disconnect/reconnect ──
// A disconnect only marks the player as "not present", it never eliminates them: quitting the game should not hand the win to the other side.
// All it affects is "who are we still waiting on"; the win conditions are still computed from alive.
function removePlayer(s, playerId) {
  if (!s || !(playerId in s.alive)) return;
  s.absent[playerId] = true;
  if (s.phase === 'ended') return;

  // Note: this does not touch the deadline. "Whether the clock should stop" depends on whether anyone is still watching (only the transport layer knows that:
  // eliminated players and spectators are still connected), while this module can only see "whether anyone can still act" -- the two are not equivalent.
  // Stopping the clock is done by the layer above explicitly calling pauseClock/resumeClock, see server.js.

  // There is nobody left who can act, so there is no need to check for advancement any more (every on an empty array is trivially true and would wrongly advance the phase)
  if (presentIds(s).length === 0) return;

  // The player who disconnected may have been the very last one everyone was waiting on -- re-check whether the current phase can advance
  if (s.phase === 'reveal' && presentIds(s).every((id) => s.ready[id])) {
    enterNight(s);
  } else if (s.phase === 'night') {
    maybeResolveNight(s);
  } else if (s.phase === 'speech' && playerId === currentSpeaker(s)) {
    // The person currently speaking disconnected → move straight on to the next one, instead of making the whole table wait out his full 45 seconds
    nextSpeaker(s);
  } else if (s.phase === 'witch' && s.roles[playerId] === ROLE.WITCH) {
    // Everyone is waiting on the witch and she has disconnected → treat it as a skip, so nobody has to sit around until the timeout
    s.nightActions.witch = s.nightActions.witch || {};
    finishNight(s);
  } else if (s.phase === 'hunter' && playerId === s.pendingHunter) {
    s.hunterCanShoot = false;
    resumeAfterHunter(s);
  } else if (s.phase === 'day' || s.phase === 'pk') {
    hurryDayIfAllVoted(s);   // If the person who left happened to be the only one left who had not voted, shorten the countdown
  }
}

// Still not back once the grace period expires → actually eliminate them, and re-run the win conditions.
// Just marking them absent is not enough: checkWin uses aliveIds, so once the only wolf leaves permanently the good side could never win,
// and the only recourse would be to vote that ghost out during the day.
function eliminatePlayer(s, playerId) {
  if (!s || s.phase === 'ended' || !s.alive[playerId]) return [];
  s.alive[playerId] = false;
  delete s.absent[playerId];
  s.log.push({ type: 'left', playerId });
  if (checkWin(s)) return [{ type: 'game_over' }];
  // The player who left may have been the very last one everyone was waiting on -- re-check whether the current phase can advance
  if (s.phase === 'reveal' && presentIds(s).length && presentIds(s).every((id) => s.ready[id])) {
    enterNight(s);
  } else if (s.phase === 'night') {
    maybeResolveNight(s);
  } else if (s.phase === 'speech' && playerId === currentSpeaker(s)) {
    // The person currently speaking disconnected → move straight on to the next one, instead of making the whole table wait out his full 45 seconds
    nextSpeaker(s);
  } else if (s.phase === 'witch' && s.roles[playerId] === ROLE.WITCH) {
    s.nightActions.witch = s.nightActions.witch || {};
    finishNight(s);
  } else if (s.phase === 'hunter' && playerId === s.pendingHunter) {
    s.hunterCanShoot = false;
    resumeAfterHunter(s);
  } else if (s.phase === 'pk') {
    // If the eliminated player was a PK candidate: drop him; with fewer than 2 left the PK is meaningless, so resolve it immediately
    s.pkCandidates = s.pkCandidates.filter((id) => id !== playerId);
    if (s.pkCandidates.length < 2) resolvePk(s);
    else hurryDayIfAllVoted(s);
  } else if (s.phase === 'day') {
    hurryDayIfAllVoted(s);
  }
  return [];
}

// ── Stopping/resuming the clock (called by the layer above when "there is not a single connection left in the room / somebody has reconnected") ──
// The deadline is an absolute timestamp, so it keeps "running" while the clock is stopped; without suspending it, the first tick after a reconnect
// would find it expired and the current phase would be skipped instantly.
function pauseClock(s) {
  if (!s || s.phase === 'ended' || s.deadline == null) return;
  s.pausedRemainMs = Math.max(0, s.deadline - now());
  s.deadline = null;
}

function resumeClock(s) {
  if (!s || s.phase === 'ended' || s.pausedRemainMs == null) return;
  s.deadline = now() + s.pausedRemainMs;
  s.pausedRemainMs = null;
}

// Reconnect: restore the present state (seat, role and alive status are all still there)
function restorePlayer(s, playerId) {
  if (!s || !(playerId in s.alive)) return;
  delete s.absent[playerId];
  // The countdown is not resumed here: whether the clock is stopped is decided by the layer above based on "whether the room still has any connections" (see resumeClock)
}

// ── Per-role serialized view (information hiding) ──
function serializeStateFor(s, playerId) {
  const myRole = s.roles[playerId];
  const view = {
    phase: s.phase,
    round: s.round,
    players: s.players.map((p) => ({
      id: p.id, name: p.name, alive: s.alive[p.id], absent: !!s.absent[p.id],
    })),
    myRole,
    myId: playerId,
    alive: s.alive[playerId],
    log: s.log,
    lastNightVictim: s.lastNightVictim,
    lastVotedOut: s.lastVotedOut,
    hostId: s.hostId,
    deadline: s.deadline,               // Deadline timestamp of the current phase, which the frontend uses to show the countdown
    cfg: s.cfg,                         // Host config (so the frontend can show hints like "a tie will go to a PK")
  };
  // Wolves: can see their fellow wolves (excluding themselves; an empty array in a one-wolf game)
  if (myRole === ROLE.WOLF) {
    view.wolfTeammates = s.players
      .filter((p) => s.roles[p.id] === ROLE.WOLF && p.id !== playerId)
      .map((p) => p.id);
  }
  // Seer: can see their own check results
  if (myRole === ROLE.SEER) {
    view.seerResults = s.seerResults[playerId] || {};
  }
  // Witch: can see how many of her potions are left, and (only during her own segment) tonight's kill target.
  // The kill target is sent to the witch alone -- sending it to anybody else would directly reveal who dies tonight.
  if (myRole === ROLE.WITCH) {
    view.potions = s.potions;
    if (s.phase === 'witch') {
      view.witchVictim = s.nightActions.victim;
      view.iActed = !!s.nightActions.witch;
      // Self-healing is allowed on the first night but not afterwards -- the frontend uses this to disable the healing potion button
      view.canSelfHeal = s.round <= 1;
    }
  }
  // Hunter: knows whether he can still shoot (once the gun has gone off, it is spent)
  if (myRole === ROLE.HUNTER) view.hunterCanShoot = s.hunterCanShoot;
  // The hunter's shooting phase: the whole room knows "it is the hunter's turn" (public information, he is already eliminated),
  // but only the hunter himself gets the flag that lets him shoot
  if (s.phase === 'hunter') {
    view.pendingHunter = s.pendingHunter;
    view.iAmShooting = playerId === s.pendingHunter;
  }
  // Role reveal: whether this player is ready + the readiness progress (waiting for the others to click "enter game")
  if (s.phase === 'reveal') {
    view.iReady = !!s.ready[playerId];
    view.readyCount = aliveIds(s).filter((id) => s.ready[id]).length;
    view.readyTotal = aliveIds(s).length;
  }
  // Night: tell this player whether they have already acted (a wolf has voted for a kill / the seer has checked), so the frontend can show a waiting state
  if (s.phase === 'night') {
    if (myRole === ROLE.WOLF) view.iActed = playerId in (s.nightActions.wolfTargetVotes || {});
    else if (myRole === ROLE.SEER) view.iActed = s.nightActions.seerCheck != null;
  }
  // Speech phase: who is talking and who has yet to talk are both public information (offline everybody can see whose turn it is)
  if (s.phase === 'speech') {
    view.speechOrder = s.speechOrder;
    view.currentSpeaker = currentSpeaker(s);
    view.iAmSpeaking = playerId === view.currentSpeaker;
    view.spokenCount = s.speechIndex;
    view.speechTotal = (s.speechOrder || []).length;
  }
  // Day/PK (voting): the current vote spread is public (who voted for whom); also flag this player's current vote and whether they have voted
  if (s.phase === 'day' || s.phase === 'pk') {
    view.votes = s.votes;
    view.iVoted = playerId in s.votes;
    view.myVote = playerId in s.votes ? s.votes[playerId] : undefined;
    // Everyone who is supposed to vote in this phase has voted → the frontend shows "about to resolve", which explains why the countdown suddenly got shorter
    const voters = expectedVoters(s);
    view.dayAllVoted = voters.length > 0 && voters.every((id) => id in s.votes);
    if (s.phase === 'pk') {
      view.pkCandidates = s.pkCandidates;               // The frontend uses this to restrict who can be voted for and to show the PK hint
      view.iAmPkCandidate = s.pkCandidates.includes(playerId);
    }
  }
  // Ended: reveal every role
  if (s.phase === 'ended') {
    view.winner = s.winner;
    view.roles = s.roles;
  }
  return view;
}

function isGameOver(s) {
  if (s.phase !== 'ended') return false;
  return { over: true, winner: s.winner, roles: s.roles };
}

module.exports = {
  id: 'werewolf',
  displayName: '狼人杀',
  minPlayers: 4,
  maxPlayers: 12,
  createInitialState,
  applyAction,
  serializeStateFor,
  isGameOver,
  removePlayer,
  restorePlayer,
  eliminatePlayer,
  pauseClock,
  resumeClock,
  ROLE,
  // Host config metadata (for the lobby settings panel).
  // type:'toggle' → a switch; type:'options' → a row of selectable value buttons. Both are rendered by the generic panel,
  // so adding a new config item only means changing this, with no frontend change needed.
  configSchema: {
    tiePk: { type: 'toggle', default: DEFAULTS.tiePk,
             label: '平票进入 PK 加赛', hint: '白天平票时,平票者发言后其余玩家重投一轮' },
    speechSeconds: { type: 'options', options: TIME_OPTIONS.speechSeconds, default: DEFAULTS.speechSeconds,
                     unit: 's', label: '每人发言时长', hint: '轮流发言,说完可点"过"提前结束' },
    daySeconds: { type: 'options', options: TIME_OPTIONS.daySeconds, default: DEFAULTS.daySeconds,
                  unit: 's', label: '投票时长', hint: '发言结束后的投票阶段,期间可改票' },
    nightSeconds: { type: 'options', options: TIME_OPTIONS.nightSeconds, default: DEFAULTS.nightSeconds,
                    unit: 's', label: '夜晚时长', hint: '狼人选刀 + 预言家查验' },
    witchSeconds: { type: 'options', options: TIME_OPTIONS.witchSeconds, default: DEFAULTS.witchSeconds,
                    unit: 's', label: '女巫用药时长', hint: '7 人及以上才有女巫' },
    hunterSeconds: { type: 'options', options: TIME_OPTIONS.hunterSeconds, default: DEFAULTS.hunterSeconds,
                     unit: 's', label: '猎人开枪时长', hint: '10 人及以上才有猎人' },
    pkSeconds: { type: 'options', options: TIME_OPTIONS.pkSeconds, default: DEFAULTS.pkSeconds,
                 unit: 's', label: 'PK 投票时长', hint: '仅在开启平票 PK 时用到' },
    revealSeconds: { type: 'options', options: TIME_OPTIONS.revealSeconds, default: DEFAULTS.revealSeconds,
                     unit: 's', label: '身份揭晓时长', hint: '所有人点"进入游戏"即提前开始' },
  },
};
