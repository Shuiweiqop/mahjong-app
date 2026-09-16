// Draw & Guess -- server-authoritative game module.
//
// Implements the platform's shared game interface:
//   createInitialState(players)
//   applyAction(state, action, playerId) -> { state, events, error }
//   serializeStateFor(state, playerId)   -> the view visible to that player (the drawer sees the word, guessers do not)
//   isGameOver(state)                    -> { over, ranking } | false
//
// All state lives in memory (held by the rooms manager one layer up). Pure
// logic, no socket/db access, which keeps it easy to test.

const { pickWords, buildWordPool } = require('./words');

const REVEAL_SECONDS = 5;       // Duration of the reveal / intermission
const PICK_SECONDS = 15;        // How long the drawer has to pick a word

// Defaults and permitted values for the host-configurable settings
const DEFAULTS = { drawSeconds: 80, roundsPerPlayer: 2, categories: [], customWords: [], wordLang: 'zh' };
// Which word bank a room draws from. This is deliberately a ROOM setting rather than
// each player's UI language: everyone in a round has to be guessing the same word, so
// it cannot follow a per-viewer preference.
const WORD_LANG_OPTIONS = ['zh', 'en'];
const DRAW_SECONDS_OPTIONS = [45, 60, 80, 120];
const ROUNDS_OPTIONS = [1, 2, 3];

// Per-round stroke cap. strokes is only cleared when the round changes, so
// within a round it only ever grows; the canvas uses normalized coordinates and
// 20,000 segments is enough to fill a whole round (measured: about 10,000
// segments for 60 seconds of normal drawing). Once the cap is hit, new strokes
// are dropped rather than rejected with an error -- the drawer should not be
// interrupted for drawing a lot; "the canvas is full" is a degradation they can
// understand.
const MAX_STROKES = 20000;
// Cap on the number of segments in a single stroke message, which blocks a malicious message from blowing up memory in one go (measured: 200,000 segments = a 22MB view).
const MAX_STROKES_PER_MSG = 500;
const GUESS_MAX = 100;          // Maximum length of a single guess/message (the werewolf module uses CHAT_MAX=300)

const now = () => Date.now();

// Normalise a word before comparing a guess against it. Chinese answers match
// exactly either way, but English ones would not: "Cat" must count for "cat",
// and "hot air balloon" must not hinge on getting every space right.
// Case is folded, and every run of whitespace collapses to a single space.
// Only ever used for the comparison -- the player's original text is what gets
// broadcast, so a near-miss still reads the way they typed it.
const normalizeGuess = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Keep only the fields the canvas actually needs and clamp the coordinates back
// into 0..1 -- a client can forge an arbitrary object, and storing it verbatim
// in the state would broadcast the junk to everyone and have it redrawn
// persistently.
function sanitizeStroke(s) {
  if (!s || typeof s !== 'object') return null;
  const pt = (p) => Array.isArray(p) && p.length >= 2
    && Number.isFinite(+p[0]) && Number.isFinite(+p[1])
    ? [Math.min(1, Math.max(0, +p[0])), Math.min(1, Math.max(0, +p[1]))]
    : null;
  const from = pt(s.from), to = pt(s.to);
  if (!from || !to) return null;
  const size = Number.isFinite(+s.size) ? Math.min(64, Math.max(1, +s.size)) : 4;
  const color = typeof s.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(s.color) ? s.color : '#000000';
  return { from, to, color, size };
}

// Normalize the configuration passed in by the host, guarding against invalid values
function normalizeConfig(cfg = {}) {
  const drawSeconds = DRAW_SECONDS_OPTIONS.includes(cfg.drawSeconds) ? cfg.drawSeconds : DEFAULTS.drawSeconds;
  const roundsPerPlayer = ROUNDS_OPTIONS.includes(cfg.roundsPerPlayer) ? cfg.roundsPerPlayer : DEFAULTS.roundsPerPlayer;
  const categories = Array.isArray(cfg.categories) ? cfg.categories : [];
  const customWords = Array.isArray(cfg.customWords)
    ? cfg.customWords.map((w) => String(w).trim()).filter(Boolean).slice(0, 100)
    : [];
  const wordLang = WORD_LANG_OPTIONS.includes(cfg.wordLang) ? cfg.wordLang : DEFAULTS.wordLang;
  return { drawSeconds, roundsPerPlayer, categories, customWords, wordLang };
}

// -- Create the initial state ------------------------------------------------
// players: [{ id, name }];  config: the host's settings (optional)
function createInitialState(players, config) {
  const cfg = normalizeConfig(config);
  const pool = buildWordPool({
    categories: cfg.categories, customWords: cfg.customWords, lang: cfg.wordLang,
  });
  return {
    phase: 'lobby',                 // lobby | pick | draw | reveal | ended
    players: players.map((p) => ({ id: p.id, name: p.name })),
    scores: Object.fromEntries(players.map((p) => [p.id, 0])),
    order: players.map((p) => p.id),// Rotation order of the drawer
    turnIndex: -1,                  // Current position within order
    roundsTotal: players.length * cfg.roundsPerPlayer,
    roundsDone: 0,
    drawerId: null,
    wordChoices: [],                // Candidates offered during the drawer's word-picking phase
    word: null,                     // The current word (internal / drawer-visible only)
    usedWords: [],
    guessedThisRound: {},           // { playerId: pointsAwarded }
    absent: {},                     // Disconnected players { playerId: true }; skipped in the rotation and not counted towards "everyone guessed"
    pausedRemainMs: null,           // Remaining time parked while the room has no connections (see pauseClock)
    strokes: [],                    // Strokes drawn so far this round (used to catch up players who join mid-round)
    strokeRev: 0,                   // Canvas revision: +1 on every clear / round change, which is how the frontend knows whether a full redraw is needed
    deadline: null,                 // Deadline timestamp of the current phase (ms)
    hostId: players[0]?.id || null,
    cfg,                            // Keep the configuration around for later use
    wordPool: pool,                 // The word pool for this game
  };
}

// -- Internal: move on to the next round (word-picking phase) -----------------
function startNextTurn(state) {
  const events = [];
  if (state.roundsDone >= state.roundsTotal) {
    state.phase = 'ended';
    state.drawerId = null;
    state.deadline = null;
    events.push({ type: 'game_over' });
    return events;
  }

  if (state.order.length === 0) {           // Fallback for everyone having disconnected
    state.phase = 'ended';
    state.drawerId = null;
    state.deadline = null;
    events.push({ type: 'game_over' });
    return events;
  }
  state.turnIndex = (state.turnIndex + 1) % state.order.length;
  state.drawerId = state.order[state.turnIndex];
  state.phase = 'pick';
  state.word = null;
  state.strokes = [];
  state.strokeRev = (state.strokeRev || 0) + 1;   // Round change: the canvas is void, the frontend needs to clear the screen
  state.guessedThisRound = {};
  state.wordChoices = pickWords(3, state.usedWords, state.wordPool).map((w) => w.word);
  state.deadline = now() + PICK_SECONDS * 1000;
  events.push({ type: 'round_changed', drawerId: state.drawerId });
  return events;
}

// -- Internal: end this round (the reveal) ------------------------------------
function endRound(state, reason) {
  state.roundsDone += 1;
  state.phase = 'reveal';
  state.deadline = now() + REVEAL_SECONDS * 1000;
  return [{ type: 'reveal', word: state.word, reason, scores: { ...state.scores } }];
}

// -- Apply one action (validated server-authoritatively) ----------------------
// action: { type, ... }
//   { type:'start' }                        the host starts the game
//   { type:'pick', word }                   the drawer settles on a word
//   { type:'stroke', stroke }               the drawer draws a stroke
//   { type:'clear' }                        the drawer clears the canvas
//   { type:'guess', text }                  a guesser submits a guess
//   { type:'tick' }                         driven by the server-side timer (checks whether the deadline has passed)
function applyAction(state, action, playerId) {
  const events = [];

  // Spectators (and any id not in this game) cannot act. tick is server-driven,
  // with playerId null.
  // Without this guard a spectator could "guess": a correct guess would land in
  // scores and guessedThisRound, and guessedThisRound is exactly what
  // serializeStateFor uses to decide whether to send the word -- so one guess
  // would hand the spectator the answer, and they could also end the round early
  // by making up the "everyone guessed" quota.
  if (action.type !== 'tick' && !state.players.some((p) => p.id === playerId)) {
    return { error: 'game.notAPlayer' };
  }

  switch (action.type) {
    case 'start': {
      if (playerId !== state.hostId) return { error: 'room.hostOnlyStart' };
      if (state.phase !== 'lobby') return { error: 'room.alreadyStarted' };
      if (state.players.length < 2) return { error: 'room.needTwoPlayers' };
      events.push(...startNextTurn(state));
      return { state, events };
    }

    case 'pick': {
      if (state.phase !== 'pick') return { error: 'draw.notPickPhase' };
      if (playerId !== state.drawerId) return { error: 'draw.onlyDrawerPicks' };
      if (!state.wordChoices.includes(action.word)) return { error: 'draw.invalidWord' };
      state.word = action.word;
      state.usedWords.push(action.word);
      state.wordChoices = [];
      state.phase = 'draw';
      state.deadline = now() + state.cfg.drawSeconds * 1000;
      events.push({ type: 'draw_started', deadline: state.deadline });
      return { state, events };
    }

    case 'stroke': {
      if (state.phase !== 'draw') return { error: 'draw.cannotDraw' };
      if (playerId !== state.drawerId) return { error: 'draw.onlyDrawerDraws' };
      // Accepts a batch of strokes (lower latency) or a single one (for compatibility)
      const raw = action.strokes || (action.stroke ? [action.stroke] : []);
      if (!Array.isArray(raw)) return { error: 'draw.badStroke' };
      // Validate + cap: anything past the per-round limit is simply dropped (no error, see the MAX_STROKES comment)
      const room = Math.max(0, MAX_STROKES - state.strokes.length);
      const strokes = raw
        .slice(0, MAX_STROKES_PER_MSG)
        .map(sanitizeStroke)
        .filter(Boolean)
        .slice(0, room);
      if (!strokes.length) return { state, events };   // All dropped: stay silent, do not interrupt the drawer
      for (const s of strokes) state.strokes.push(s);
      // Broadcast only this batch (the delta), not everything -- the full set is only re-sent through serializeStateFor for players joining mid-round
      events.push({ type: 'stroke', strokes, forOthers: true });
      return { state, events };
    }

    case 'clear': {
      if (state.phase !== 'draw') return { error: 'draw.cannotClear' };
      if (playerId !== state.drawerId) return { error: 'draw.onlyDrawerClears' };
      state.strokes = [];
      state.strokeRev = (state.strokeRev || 0) + 1;
      events.push({ type: 'clear' });
      return { state, events };
    }

    case 'guess': {
      if (state.phase !== 'draw') return { error: 'draw.cannotGuess' };
      if (playerId === state.drawerId) return { error: 'draw.drawerCannotGuess' };
      if (state.guessedThisRound[playerId]) return { error: 'draw.alreadyGuessed' };

      // Truncate rather than reject: an incorrect guess is broadcast as chat, and
      // without a cap that would hand everyone a broadcast channel of arbitrary
      // length (measured: 100,000 characters forwarded verbatim). The same
      // applies in the werewolf module, see CHAT_MAX.
      const guess = String(action.text || '').trim().slice(0, GUESS_MAX);
      const correct = normalizeGuess(guess) === normalizeGuess(state.word);

      if (correct) {
        // Scoring: the more time is left the more points; the drawer also scores per player who guessed correctly
        const remaining = Math.max(0, (state.deadline - now()) / 1000);
        const pts = 100 + Math.round((remaining / state.cfg.drawSeconds) * 100);
        state.scores[playerId] = (state.scores[playerId] || 0) + pts;
        state.guessedThisRound[playerId] = pts;
        state.scores[state.drawerId] = (state.scores[state.drawerId] || 0) + 25;
        events.push({ type: 'guessed', playerId, points: pts });

        // Every present non-drawer has guessed -> end the round early. Players who have
        // dropped are not counted, otherwise the tally could never be completed.
        const guessers = state.players.filter(
          (p) => p.id !== state.drawerId && !state.absent[p.id]
        );
        const allGuessed = guessers.length > 0 && guessers.every((p) => state.guessedThisRound[p.id]);
        if (allGuessed) events.push(...endRound(state, 'all_guessed'));
        return { state, events };
      } else {
        // Wrong guess -> broadcast it as ordinary chat, which does not reveal the answer
        events.push({ type: 'chat', playerId, text: guess });
        return { state, events };
      }
    }

    case 'tick': {
      // Server-side timer: check whether the current phase has run out and advance
      if (!state.deadline || now() < state.deadline) return { state, events };
      if (!state.drawerId) return { state, events };   // rotation is empty (suspended while everyone is disconnected), nothing to advance
      if (state.phase === 'pick') {
        // The drawer did not choose -> pick the first candidate for them
        if (state.wordChoices.length) {
          return applyAction(state, { type: 'pick', word: state.wordChoices[0] }, state.drawerId);
        }
      } else if (state.phase === 'draw') {
        events.push(...endRound(state, 'timeout'));
      } else if (state.phase === 'reveal') {
        events.push(...startNextTurn(state));
      }
      return { state, events };
    }

    default:
      return { error: 'game.unknownAction' };
  }
}

// ── Disconnect / reconnect ─────────────────────────────────
// A disconnected player leaves the drawer rotation and stops counting towards
// "everyone has guessed". Their score is kept, so reconnecting resumes where they left off.
function removePlayer(state, playerId) {
  if (!state || state.phase === 'ended') return [];
  if (!state.order.includes(playerId) && !state.absent[playerId]) return [];
  state.absent[playerId] = true;

  const idx = state.order.indexOf(playerId);
  if (idx !== -1) {
    state.order.splice(idx, 1);
    // Preserve the meaning of turnIndex as "the current drawer": when the removed slot is
    // before the current one (or is the current one), shift back, otherwise the next +1
    // would skip a player or repeat the current one.
    if (idx <= state.turnIndex) state.turnIndex -= 1;
  }

  // Nobody left in the rotation. Do not end the game here: everyone briefly dropping
  // (switching networks, say) should still be able to reconnect and carry on.
  // Only the current round is suspended (there is no drawer to pick); actually ending the
  // game is left to the layer above, after its grace period expires.
  // Note that startNextTurn would take a modulo of an empty order and get NaN, so this
  // early return is required.
  // deadline is deliberately untouched: stopping the clock is decided one layer up, based
  // on whether the room still has any connections (see pauseClock).
  if (state.order.length === 0) {
    state.drawerId = null;
    return [];
  }

  // The current drawer dropped -> void this round and move straight to the next one,
  // rather than spinning until the timer runs out
  if (playerId === state.drawerId && (state.phase === 'pick' || state.phase === 'draw')) {
    return startNextTurn(state);
  }

  // The player who dropped may have been the last guesser everyone was waiting on, so
  // re-check whether the round can end early
  if (state.phase === 'draw') {
    const guessers = state.players.filter(
      (p) => p.id !== state.drawerId && !state.absent[p.id]
    );
    if (guessers.length > 0 && guessers.every((p) => state.guessedThisRound[p.id])) {
      return endRound(state, 'all_guessed');
    }
  }
  return [];
}

// Reconnect: mark them present again and append them to the end of the rotation (their
// score was kept throughout)
function restorePlayer(state, playerId) {
  if (!state || !state.absent[playerId]) return [];
  delete state.absent[playerId];
  if (state.phase === 'ended') return [];
  if (!state.order.includes(playerId)) state.order.push(playerId);
  // The round was suspended because the rotation had emptied (no drawer). Someone is
  // back, so start a fresh round.
  if (!state.drawerId && state.phase !== 'lobby') {
    state.turnIndex = -1;
    state.pausedRemainMs = null;   // a fresh round sets a new deadline, so the parked value is void
    return startNextTurn(state);
  }
  return [];
}

// Still gone when the grace period expires -> remove them permanently and shrink the
// total round count to match who is left.
// roundsTotal is fixed from the player count at the start, so without shrinking it a
// 4-player game losing one player would still make the remaining 3 play all 8 rounds.
function eliminatePlayer(state, playerId) {
  if (!state || state.phase === 'ended') return [];
  const events = removePlayer(state, playerId) || [];
  delete state.absent[playerId];
  state.players = state.players.filter((p) => p.id !== playerId);

  // Recompute the total from the current player count. Rounds already played are not
  // taken back, so the result never drops below roundsDone.
  const target = state.players.length * state.cfg.roundsPerPlayer;
  state.roundsTotal = Math.max(state.roundsDone, target);
  if (state.roundsDone >= state.roundsTotal && state.phase !== 'ended') {
    state.phase = 'ended';
    state.drawerId = null;
    state.deadline = null;
    return [...events, { type: 'game_over' }];
  }
  return events;
}

// ── Stop / resume the clock (called from the layer above when the room drops to zero
//    connections, or when someone reconnects) ──
// Same reasoning as in werewolf: deadline is an absolute timestamp, so it keeps running
// through a period when the clock is meant to be stopped.
function pauseClock(state) {
  if (!state || state.phase === 'ended' || state.deadline == null) return;
  state.pausedRemainMs = Math.max(0, state.deadline - now());
  state.deadline = null;
}

function resumeClock(state) {
  if (!state || state.phase === 'ended' || state.pausedRemainMs == null) return;
  state.deadline = now() + state.pausedRemainMs;
  state.pausedRemainMs = null;
}

// Who needs the whole canvas? Only those who cannot receive increments:
//   - players who dropped or joined mid-round (absent, or not in this game's order at
//     all -- which is the path spectators take)
//   - a canvas that was just cleared or rolled over to a new round (strokes is empty, so
//     sending an empty array to make the client wipe its screen costs nothing)
// Players who are present keep receiving increments through the 'stroke' event and do
// not need the full set on every broadcast.
// Do not mutate state here: serializeStateFor runs once per player on every broadcast,
// so recording "already synced" inside it would make the result of a single broadcast
// depend on the order members happen to be iterated in.
function strokesFor(state, playerId) {
  if (!state.strokes.length) return [];
  const inGame = state.order.includes(playerId) && !state.absent[playerId];
  return inGame ? undefined : state.strokes;
}

// ── Serialize the view (information hiding: the drawer sees the word, guessers do not) ──
function serializeStateFor(state, playerId) {
  const isDrawer = playerId === state.drawerId;
  const view = {
    phase: state.phase,
    players: state.players.map((p) => ({ ...p, absent: !!state.absent[p.id] })),
    scores: state.scores,
    drawerId: state.drawerId,
    roundsDone: state.roundsDone,
    roundsTotal: state.roundsTotal,
    deadline: state.deadline,
    hostId: state.hostId,
    // Strokes stay out of the routine view. Increments are already broadcast separately
    // through the 'stroke' event, so carrying the full set here too would mean resending
    // the entire canvas to everyone every time someone guesses (chat also goes through
    // broadcastState). Measured: after a normally busy round, a single player's view is
    // 1.2MB, so one broadcast in an 8-player room approaches 10MB.
    // The full set is only sent when a catch-up redraw is genuinely needed (see strokesFor below).
    strokes: strokesFor(state, playerId),
    strokeRev: state.strokeRev,             // canvas revision; the client uses it to decide whether a full redraw is needed
    guessed: Object.keys(state.guessedThisRound),
    isDrawer,
  };
  if (state.phase === 'pick' && isDrawer) view.wordChoices = state.wordChoices;
  if (state.phase === 'draw') {
    // The drawer sees the whole word; guessers see only its shape. Anyone who has
    // already guessed correctly sees the word too.
    if (isDrawer || state.guessedThisRound[playerId]) view.word = state.word;
    else {
      // Send the length of each word separately rather than one total. A Chinese
      // answer is a single run either way, but "hot air balloon" as a flat count of
      // 15 would render as one unbroken row of blanks that silently includes the
      // spaces -- both ugly and misleading about the shape of the answer.
      // wordLength is kept alongside it so an older client still renders something.
      const w = state.word || '';
      view.wordLengths = w ? w.split(/\s+/).filter(Boolean).map((part) => part.length) : [];
      view.wordLength = w.length;
    }
  }
  if (state.phase === 'reveal' || state.phase === 'ended') view.word = state.word;
  if (state.phase === 'ended') {
    view.ranking = [...state.players]
      .map((p) => ({ ...p, score: state.scores[p.id] || 0 }))
      .sort((a, b) => b.score - a.score);
  }
  return view;
}

function isGameOver(state) {
  if (state.phase !== 'ended') return false;
  const ranking = [...state.players]
    .map((p) => ({ ...p, score: state.scores[p.id] || 0 }))
    .sort((a, b) => b.score - a.score);
  return { over: true, ranking };
}

const { CATEGORIES } = require('./words');

module.exports = {
  id: 'drawguess',
  displayName: '你画我猜',
  minPlayers: 2,
  maxPlayers: 8,
  createInitialState,
  applyAction,
  serializeStateFor,
  isGameOver,
  removePlayer,
  restorePlayer,
  eliminatePlayer,
  pauseClock,
  resumeClock,
  // Host-configurable settings metadata, consumed by the client's settings panel
  configSchema: {
    // Draw & Guess uses the bespoke lobby layout (see LobbySettings.jsx), so this needs
    // no type: the client renders it explicitly and translates the option labels, since
    // the values are language codes rather than display text.
    wordLang: { options: WORD_LANG_OPTIONS, default: DEFAULTS.wordLang },
    drawSeconds: { options: DRAW_SECONDS_OPTIONS, default: DEFAULTS.drawSeconds },
    roundsPerPlayer: { options: ROUNDS_OPTIONS, default: DEFAULTS.roundsPerPlayer },
    categories: CATEGORIES,
  },
  REVEAL_SECONDS,
  PICK_SECONDS,
};
