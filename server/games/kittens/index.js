// Exploding Kittens -- server-authoritative game module.
//
// Implements the platform's shared game interface:
//   createInitialState(players, config)
//   applyAction(state, action, playerId) -> { state, events, error }
//   serializeStateFor(state, playerId)   -> everyone sees only their own hand
//   isGameOver(state)                    -> { over, ranking } | false
//
// Phase state machine:
//   lobby -> playing <-> nope -> [favor] -> [defusing] -> ended
//   playing  the player whose turn it is may play a card or draw; drawing a bomb
//            while holding a defuse -> defusing
//   nope     an action card has just been played, wait and see whether anyone
//            nopes it. A nope itself also goes through this window (so it can be
//            noped back)
//   favor    the player being asked picks a card to hand over (only they can act,
//            and the asker cannot see their hand)
//   defusing only the player concerned can act: they choose where the bomb goes
//            back into the deck
//
// The heart of the information hiding: state.deck (the deck order) and
// state.hands (everyone's hands) are never sent out in full. A player sees only
// their own hand plus the card *counts* of the others. The three cards revealed
// by See the Future go only to the player who played it.
// Every phase duration is configured by the host rather than hard-coded. Pure
// logic, no socket/db access (see rules.test.js).

const { CARD, CAT_CARDS, ACTION_CARDS, CARD_INFO, buildDeck } = require('./cards');

const DEFAULTS = {
  nopeSeconds: 6,      // Nope response window: how long to wait after an action card for someone to nope it
  turnSeconds: 60,     // Thinking time for a single turn
  defuseSeconds: 20,   // Time to choose where the bomb goes back after a defuse
  favorSeconds: 20,    // Time to pick a card to hand over when asked for a favor
};
const TIME_OPTIONS = {
  nopeSeconds: [3, 5, 6, 10],
  turnSeconds: [30, 45, 60, 90],
  defuseSeconds: [10, 20, 30],
  favorSeconds: [10, 20, 30],
};

const now = () => Date.now();

function normalizeConfig(cfg = {}) {
  const out = {};
  for (const [key, options] of Object.entries(TIME_OPTIONS)) {
    out[key] = options.includes(cfg[key]) ? cfg[key] : DEFAULTS[key];
  }
  return out;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// -- Create the initial state --
// Dealing rules: 1 defuse + 7 ordinary cards each; the leftover cards get
// (playerCount - 1) bombs and the spare defuses mixed in. There is one bomb
// fewer than there are players -- that is what guarantees exactly one player is
// left standing at the end.
function createInitialState(players, config = {}) {
  const ids = players.map((p) => p.id);
  const pool = shuffle(buildDeck(ids.length));

  const hands = {};
  for (const id of ids) {
    hands[id] = [CARD.DEFUSE, ...pool.splice(0, 7)];
  }
  // The remaining cards + bombs + leftover defuses, shuffled together into the deck
  const deck = [...pool];
  for (let i = 0; i < ids.length - 1; i++) deck.push(CARD.BOMB);
  const extraDefuse = Math.max(0, 6 - ids.length);
  for (let i = 0; i < extraDefuse; i++) deck.push(CARD.DEFUSE);

  return {
    phase: 'lobby',                   // lobby | playing | nope | defusing | ended
    cfg: normalizeConfig(config),
    players: players.map((p) => ({ id: p.id, name: p.name })),
    hands,                            // { playerId: [card] } -- never sent out in full
    deck: shuffle(deck),              // The deck (the top is the end of the array) -- never sent out
    discard: [],                      // Discard pile (public)
    alive: Object.fromEntries(ids.map((id) => [id, true])),
    absent: {},
    order: ids,                       // Seating order
    turnIndex: 0,
    turnsLeft: 1,                     // How many more turns the current player owes (attacks stack)
    pending: null,                     // Action card awaiting resolution { by, card, payload, nopes }
    defusing: null,                    // { playerId } currently choosing where to put the bomb back
    favor: null,                       // { from, to } the asked player is picking a card for the asker
    future: {},                        // { playerId: [card,card,card] } See the Future result, visible only to that player
    lastAction: null,                  // Public announcement of the most recent action
    ranking: [],                       // Elimination order (reversed, this is the final placing)
    deadline: null,
    pausedRemainMs: null,
    log: [],
    hostId: players[0]?.id || null,
  };
}

const aliveIds = (s) => s.order.filter((id) => s.alive[id]);
const presentIds = (s) => aliveIds(s).filter((id) => !s.absent[id]);
const currentPlayer = (s) => s.order[s.turnIndex] ?? null;

function setDeadline(s, seconds) {
  s.deadline = now() + seconds * 1000;
  s.pausedRemainMs = null;
}

// Move to the next living player. The extra turns caused by an attack are
// expressed through turnsLeft: while turns remain the seat does not change, the
// clock is simply restarted.
function nextTurn(s, extraTurns = 0) {
  if (extraTurns > 0) {
    // Attack: the current player is done, the next one has to take extraTurns turns
    advanceSeat(s);
    s.turnsLeft = extraTurns;
  } else {
    s.turnsLeft -= 1;
    if (s.turnsLeft <= 0) {
      advanceSeat(s);
      s.turnsLeft = 1;
    }
  }
  s.phase = 'playing';
  setDeadline(s, s.cfg.turnSeconds);
}

function advanceSeat(s) {
  const living = aliveIds(s);
  if (!living.length) return;
  for (let i = 1; i <= s.order.length; i++) {
    const idx = (s.turnIndex + i) % s.order.length;
    if (s.alive[s.order[idx]]) { s.turnIndex = idx; return; }
  }
}

// Knock a player out. Exploding Kittens is an elimination game, so placings are
// derived by reversing the order in which players went out.
function eliminate(s, id, reason) {
  if (!s.alive[id]) return;
  s.alive[id] = false;
  s.ranking.unshift(id);          // The later you go out, the higher you place
  s.discard.push(...(s.hands[id] || []));
  s.hands[id] = [];
  s.log.push({ type: 'eliminated', playerId: id, reason });
}

function checkWin(s) {
  const living = aliveIds(s);
  if (living.length <= 1) {
    if (living.length === 1) s.ranking.unshift(living[0]);
    s.phase = 'ended';
    s.deadline = null;
    return true;
  }
  return false;
}

// Remove the given cards from a hand; returns the new hand, or null if the hand
// does not hold them all (in which case nothing is changed)
function takeFromHand(hand, cards) {
  const copy = [...hand];
  for (const c of cards) {
    const i = copy.indexOf(c);
    if (i < 0) return null;
    copy.splice(i, 1);
  }
  return copy;
}

// -- Nope window --
// Every action card played first goes into pending and waits nopeSeconds. During
// that time any living player may play a nope card. An odd number of nopes means
// the card is noped (does not take effect); an even number means it takes
// effect. This makes "noping a nope" work naturally.
function openNopeWindow(s, by, card, payload) {
  s.pending = { by, card, payload: payload || {}, nopes: [] };
  s.phase = 'nope';
  setDeadline(s, s.cfg.nopeSeconds);
  s.log.push({ type: 'played', playerId: by, card });
}

// Resolve pending: the number of nopes decides whether the card takes effect
function resolvePending(s) {
  const p = s.pending;
  if (!p) { nextTurn(s); return; }
  s.pending = null;

  const nopedOut = p.nopes.length % 2 === 1;
  s.log.push({ type: 'resolved', playerId: p.by, card: p.card, noped: nopedOut });
  if (nopedOut) {
    // Noped: the card is void and the turn continues (the player who played it is still in their own turn)
    s.phase = 'playing';
    setDeadline(s, s.cfg.turnSeconds);
    return;
  }
  applyCardEffect(s, p.by, p.card, p.payload);
}

// Where an action card actually takes effect
function applyCardEffect(s, by, card, payload) {
  switch (card) {
    case CARD.SKIP:
      nextTurn(s);
      return;

    case CARD.ATTACK:
      nextTurn(s, 2);
      return;

    case CARD.SHUFFLE:
      s.deck = shuffle(s.deck);
      s.phase = 'playing';
      setDeadline(s, s.cfg.turnSeconds);
      return;

    case CARD.FUTURE:
      // Only the player who played the card sees the top three -- this is the module's only piece of partially visible hidden information
      s.future[by] = s.deck.slice(-3).reverse();
      s.phase = 'playing';
      setDeadline(s, s.cfg.turnSeconds);
      return;

    case CARD.FAVOR: {
      // As in the original game: the player being asked picks the card to hand
      // over themselves (which is why they will hand over their most useless one).
      // That needs a waiting phase -- and like defusing, only the player
      // concerned can act in it.
      const target = payload.target;
      if (target && s.alive[target] && s.hands[target]?.length) {
        s.favor = { from: target, to: by };
        s.phase = 'favor';
        setDeadline(s, s.cfg.favorSeconds);
        s.log.push({ type: 'favor_asked', playerId: by, target });
        return;
      }
      // The target has no cards to give: just move on
      s.phase = 'playing';
      setDeadline(s, s.cfg.turnSeconds);
      return;
    }

    case 'cat_pair': {
      // Two matching cat cards -> steal a random card from the target
      const target = payload.target;
      if (target && s.alive[target] && s.hands[target]?.length) {
        const hand = s.hands[target];
        const i = Math.floor(Math.random() * hand.length);
        const [got] = hand.splice(i, 1);
        s.hands[by].push(got);
        s.lastAction = { type: 'steal', by, target };
      }
      s.phase = 'playing';
      setDeadline(s, s.cfg.turnSeconds);
      return;
    }

    case 'cat_three': {
      // Three matching cards -> name a card: if the target has it they must hand
      // it over, otherwise the demand comes up empty.
      // An empty demand is announced publicly too -- "he has no defuse" is itself
      // valuable public information, and that is exactly the tactical point of
      // the three-card play (probing).
      const target = payload.target;
      const wanted = payload.wanted;
      let got = null;
      if (target && s.alive[target]) {
        const hand = s.hands[target] || [];
        const i = hand.indexOf(wanted);
        if (i >= 0) {
          [got] = hand.splice(i, 1);
          s.hands[by].push(got);
        }
      }
      s.lastAction = { type: 'demand', by, target, wanted, success: !!got };
      s.log.push({ type: 'demand', playerId: by, target, wanted, success: !!got });
      s.phase = 'playing';
      setDeadline(s, s.cfg.turnSeconds);
      return;
    }

    case 'cat_five': {
      // Five different cards -> take any card from the discard pile. The discard pile is public, so everyone sees what was taken.
      const wanted = payload.wanted;
      const i = s.discard.indexOf(wanted);
      if (i >= 0) {
        const [got] = s.discard.splice(i, 1);
        s.hands[by].push(got);
        s.lastAction = { type: 'salvage', by, wanted };
        s.log.push({ type: 'salvage', playerId: by, wanted });
      }
      s.phase = 'playing';
      setDeadline(s, s.cfg.turnSeconds);
      return;
    }

    default:
      s.phase = 'playing';
      setDeadline(s, s.cfg.turnSeconds);
  }
}

// Hand the i-th card of the asked player's hand to the asker and return to the
// asker's turn. This is pulled out into a function because there are two ways in:
// the player giving a card deliberately, and a random card being given on timeout.
function giveFavorCard(s, index) {
  const f = s.favor;
  if (!f) return;
  const hand = s.hands[f.from] || [];
  const [got] = hand.splice(index, 1);
  if (got) s.hands[f.to].push(got);
  s.lastAction = { type: 'favor', by: f.to, target: f.from };
  s.log.push({ type: 'favor_given', playerId: f.from, target: f.to });
  s.favor = null;
  // The turn still belongs to the asker -- asking for a favor does not end the turn
  s.phase = 'playing';
  setDeadline(s, s.cfg.turnSeconds);
}

// Draw a card and end the turn. Drawing a bomb needs special handling.
function drawCard(s, playerId) {
  const events = [];
  if (!s.deck.length) {
    // The deck is empty (an edge case): just move on to the next turn
    nextTurn(s);
    return events;
  }
  const card = s.deck.pop();
  delete s.future[playerId];        // Once you have drawn, the cards you peeked at earlier are stale

  if (card !== CARD.BOMB) {
    s.hands[playerId].push(card);
    s.log.push({ type: 'drew', playerId });
    nextTurn(s);
    return events;
  }

  // A bomb was drawn
  s.log.push({ type: 'drew_bomb', playerId });
  const hand = s.hands[playerId];
  const defuseIdx = hand.indexOf(CARD.DEFUSE);
  if (defuseIdx < 0) {
    // No defuse -> knocked out
    s.discard.push(card);
    eliminate(s, playerId, 'bomb');
    events.push({ type: 'exploded', playerId });
    if (!checkWin(s)) {
      // The eliminated player's turn simply ends, and play passes to the next player
      s.turnsLeft = 1;
      advanceSeat(s);
      s.phase = 'playing';
      setDeadline(s, s.cfg.turnSeconds);
    }
    return events;
  }

  // Holding a defuse -> the bomb is defused, and we move on to choosing where it goes back into the deck
  hand.splice(defuseIdx, 1);
  s.discard.push(CARD.DEFUSE);
  s.defusing = { playerId, bomb: card };
  s.phase = 'defusing';
  setDeadline(s, s.cfg.defuseSeconds);
  events.push({ type: 'defused', playerId });
  s.log.push({ type: 'defused', playerId });
  return events;
}

// -- Apply an action --
// { type:'start' }                           the host starts the game
// { type:'play', cards:[card], target? }     play a card (an action card or a set of cat cards)
// { type:'nope' }                            nope (only during the nope phase)
// { type:'draw' }                            deliberately draw a card and end the turn
// { type:'place_bomb', position }            after defusing, slip the bomb back into the deck
// { type:'tick' }                            the server-side timer
function applyAction(s, action, playerId) {
  const events = [];

  // Spectators and anyone not in this game cannot act (tick is server-driven, with playerId null)
  if (action.type !== 'tick' && !(playerId in s.alive)) {
    return { error: 'game.notAPlayer' };
  }

  switch (action.type) {
    case 'start': {
      if (playerId !== s.hostId) return { error: 'room.hostOnlyStart' };
      if (s.phase !== 'lobby') return { error: 'room.alreadyStarted' };
      if (s.players.length < 2) return { error: 'room.needTwoPlayers' };
      s.phase = 'playing';
      s.turnIndex = 0;
      s.turnsLeft = 1;
      setDeadline(s, s.cfg.turnSeconds);
      return { state: s, events };
    }

    // Nope: any living player may play one, not just the player whose turn it is
    case 'nope': {
      if (s.phase !== 'nope' || !s.pending) return { error: 'kittens.nothingToNope' };
      if (!s.alive[playerId]) return { error: 'game.youAreOut' };
      const hand = takeFromHand(s.hands[playerId], [CARD.NOPE]);
      if (!hand) return { error: 'kittens.noNopeCard' };
      s.hands[playerId] = hand;
      s.discard.push(CARD.NOPE);
      s.pending.nopes.push(playerId);
      // Every nope reopens the window -- a nope can itself be noped
      setDeadline(s, s.cfg.nopeSeconds);
      s.log.push({ type: 'noped', playerId });
      return { state: s, events };
    }

    case 'play': {
      if (s.phase !== 'playing') return { error: 'kittens.cannotPlay' };
      if (playerId !== currentPlayer(s)) return { error: 'game.notYourTurn' };
      const cards = Array.isArray(action.cards) ? action.cards : [];
      if (!cards.length) return { error: 'kittens.noCardsSelected' };

      const allCats = cards.every((c) => CAT_CARDS.includes(c));
      const sameCat = allCats && cards.every((c) => c === cards[0]);
      const needTarget = () => {
        if (!action.target || !s.alive[action.target] || action.target === playerId) {
          return 'kittens.needValidTarget';
        }
        return null;
      };

      // Two of a kind -> steal a random card
      if (cards.length === 2 && sameCat) {
        const rest = takeFromHand(s.hands[playerId], cards);
        if (!rest) return { error: 'kittens.missingCards' };
        const bad = needTarget();
        if (bad) return { error: bad };
        s.hands[playerId] = rest;
        s.discard.push(...cards);
        openNopeWindow(s, playerId, 'cat_pair', { target: action.target });
        return { state: s, events };
      }

      // Three of a kind -> name a card: you call out a card name, and if the
      // target has it they must hand it over, otherwise the demand comes up empty.
      // This is the only way to go after one specific card (a defuse, say), which
      // is why the card name has to be declared up front.
      if (cards.length === 3 && sameCat) {
        const rest = takeFromHand(s.hands[playerId], cards);
        if (!rest) return { error: 'kittens.missingCards' };
        const bad = needTarget();
        if (bad) return { error: bad };
        if (!action.wanted || !CARD_INFO[action.wanted]) return { error: 'kittens.nameACard' };
        s.hands[playerId] = rest;
        s.discard.push(...cards);
        openNopeWindow(s, playerId, 'cat_three', { target: action.target, wanted: action.wanted });
        return { state: s, events };
      }

      // Five all different -> take any card from the discard pile. The discard pile is public information anyway, so no hidden information is involved.
      if (cards.length === 5 && allCats && new Set(cards).size === 5) {
        const rest = takeFromHand(s.hands[playerId], cards);
        if (!rest) return { error: 'kittens.missingCards' };
        if (!action.wanted || !CARD_INFO[action.wanted]) return { error: 'kittens.pickFromDiscard' };
        if (!s.discard.includes(action.wanted)) return { error: 'kittens.notInDiscard' };
        s.hands[playerId] = rest;
        s.discard.push(...cards);
        openNopeWindow(s, playerId, 'cat_five', { wanted: action.wanted });
        return { state: s, events };
      }

      if (cards.length !== 1) {
        return { error: 'kittens.badCombo' };
      }
      const card = cards[0];
      if (!ACTION_CARDS.includes(card)) return { error: 'kittens.cannotPlayAlone' };
      if (card === CARD.FAVOR) {
        if (!action.target || !s.alive[action.target] || action.target === playerId) {
          return { error: 'kittens.favorNeedsTarget' };
        }
      }
      const rest = takeFromHand(s.hands[playerId], [card]);
      if (!rest) return { error: 'kittens.missingCard' };
      s.hands[playerId] = rest;
      s.discard.push(card);
      openNopeWindow(s, playerId, card, { target: action.target });
      return { state: s, events };
    }

    case 'draw': {
      if (s.phase !== 'playing') return { error: 'kittens.cannotDraw' };
      if (playerId !== currentPlayer(s)) return { error: 'game.notYourTurn' };
      events.push(...drawCard(s, playerId));
      return { state: s, events };
    }

    // After defusing, slip the bomb back into the deck. position counts from the top of the deck (0 = the next player draws it immediately)
    case 'place_bomb': {
      if (s.phase !== 'defusing') return { error: 'kittens.noPlaceNeeded' };
      if (!s.defusing || playerId !== s.defusing.playerId) return { error: 'kittens.notYourDefuse' };
      const bomb = s.defusing.bomb;
      const max = s.deck.length;
      let pos = Number.isInteger(action.position) ? action.position : Math.floor(Math.random() * (max + 1));
      pos = Math.min(max, Math.max(0, pos));
      // The end of deck is the top, so "the pos-th card counting from the top" = inserting at length - pos
      s.deck.splice(max - pos, 0, bomb);
      s.defusing = null;
      nextTurn(s);
      return { state: s, events };
    }

    // The asked player picks a card to hand over. Only they can do it -- the
    // asker cannot choose on their behalf, and cannot see what cards they hold
    // (which is exactly the premise of the "hand over your most useless card"
    // mind game).
    case 'give_card': {
      if (s.phase !== 'favor' || !s.favor) return { error: 'kittens.noGiveNeeded' };
      if (playerId !== s.favor.from) return { error: 'kittens.notYourGive' };
      const hand = s.hands[playerId] || [];
      const i = typeof action.index === 'number' ? action.index : hand.indexOf(action.card);
      if (i < 0 || i >= hand.length) return { error: 'kittens.pickOneCard' };
      giveFavorCard(s, i);
      return { state: s, events };
    }

    case 'tick': {
      if (s.phase === 'ended' || !s.deadline || now() < s.deadline) return { state: s, events };
      if (s.phase === 'nope') {
        resolvePending(s);
      } else if (s.phase === 'favor') {
        // Nothing given before the timeout -> hand over a random card, so stalling is not a viable tactic
        const hand = s.hands[s.favor?.from] || [];
        if (hand.length) giveFavorCard(s, Math.floor(Math.random() * hand.length));
        else { s.favor = null; s.phase = 'playing'; setDeadline(s, s.cfg.turnSeconds); }
      } else if (s.phase === 'defusing') {
        // Timed out: put the bomb back at a random position
        const bomb = s.defusing?.bomb;
        if (bomb) {
          const pos = Math.floor(Math.random() * (s.deck.length + 1));
          s.deck.splice(pos, 0, bomb);
        }
        s.defusing = null;
        nextTurn(s);
      } else if (s.phase === 'playing') {
        // Turn timed out: force a draw (which is also the natural outcome in the original game -- you have to draw sooner or later)
        const cur = currentPlayer(s);
        if (cur) events.push(...drawCard(s, cur));
      }
      return { state: s, events };
    }

    default:
      return { error: 'game.unknownAction' };
  }
}

// -- Disconnect / reconnect / leave --
function removePlayer(s, playerId) {
  if (!s || !(playerId in s.alive)) return;
  s.absent[playerId] = true;
  if (s.phase === 'ended') return;
  // Do not stall when it is the disconnected player's turn: draw on their behalf to end the turn
  if (s.phase === 'playing' && currentPlayer(s) === playerId && presentIds(s).length) {
    drawCard(s, playerId);
  }
  // The player who owes a card disconnects -> give a random one, rather than making the asker wait out the whole window
  if (s.phase === 'favor' && s.favor?.from === playerId) {
    const hand = s.hands[playerId] || [];
    if (hand.length) giveFavorCard(s, Math.floor(Math.random() * hand.length));
    else { s.favor = null; s.phase = 'playing'; setDeadline(s, s.cfg.turnSeconds); }
  }
}

function restorePlayer(s, playerId) {
  if (!s || !(playerId in s.alive)) return;
  delete s.absent[playerId];
}

// Actually gone once the grace period expires -> knock them out and re-check for a winner
function eliminatePlayer(s, playerId) {
  if (!s || s.phase === 'ended' || !s.alive[playerId]) return [];
  const wasCurrent = currentPlayer(s) === playerId;
  eliminate(s, playerId, 'left');
  delete s.absent[playerId];
  if (checkWin(s)) return [{ type: 'game_over' }];
  if (wasCurrent) {
    s.turnsLeft = 1;
    advanceSeat(s);
    s.phase = 'playing';
    setDeadline(s, s.cfg.turnSeconds);
  }
  return [];
}

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

// -- Per-player serialized view (information hiding) --
// Built from a whitelist. Never include deck (the deck order) or hands
// (everyone's hands) -- the former gives away where the bombs are, the latter
// gives away what everyone is holding.
function serializeStateFor(s, playerId) {
  const view = {
    phase: s.phase,
    players: s.players.map((p) => ({
      id: p.id, name: p.name,
      alive: !!s.alive[p.id],
      absent: !!s.absent[p.id],
      handCount: (s.hands[p.id] || []).length,   // Only the count, never the contents
    })),
    myId: playerId,
    myHand: s.hands[playerId] ? [...s.hands[playerId]] : [],  // Your own hand only
    alive: !!s.alive[playerId],
    currentPlayer: currentPlayer(s),
    isMyTurn: currentPlayer(s) === playerId && s.phase === 'playing',
    turnsLeft: s.turnsLeft,
    deckCount: s.deck.length,                     // Only how many cards are left, never the order
    discardTop: s.discard[s.discard.length - 1] ?? null,
    discardCount: s.discard.length,
    // The contents of the discard pile are public (the cards are face up on the table), and the five-different-cats play picks from here
    discard: [...s.discard],
    log: s.log.slice(-30),
    lastAction: s.lastAction,
    hostId: s.hostId,
    deadline: s.deadline,
    cfg: s.cfg,
  };

  // Nope window: everyone needs to see who played what and how many nopes it has drawn, otherwise they cannot decide whether to nope it themselves
  if (s.phase === 'nope' && s.pending) {
    view.pending = {
      by: s.pending.by,
      card: s.pending.card,
      target: s.pending.payload?.target ?? null,
      // Which card is being demanded is public -- everyone hears him call out "give me your defuse", and that too is a basis for deciding whether to nope
      wanted: s.pending.payload?.wanted ?? null,
      nopeCount: s.pending.nopes.length,
    };
    view.iCanNope = !!s.alive[playerId] && (s.hands[playerId] || []).includes(CARD.NOPE);
  }

  // Favor: only the asked player can pick a card. The asker cannot see what the
  // other player holds -- the "hand over your most useless card" mind game works
  // precisely because the asker does not know what they are hiding.
  if (s.phase === 'favor' && s.favor) {
    view.favorFrom = s.favor.from;
    view.favorTo = s.favor.to;
    view.iAmGiving = s.favor.from === playerId;
  }

  // Defusing: only the player concerned sees that they are defusing and gets to choose the position. Everyone else only knows that someone is defusing.
  if (s.phase === 'defusing' && s.defusing) {
    view.defusingBy = s.defusing.playerId;
    view.iAmDefusing = s.defusing.playerId === playerId;
    if (view.iAmDefusing) view.deckSize = s.deck.length;
  }

  // See the future: sent only to the player who played the card
  if (s.future[playerId]) view.myFuture = s.future[playerId];

  // Placings become public once the game is over
  if (s.phase === 'ended') {
    view.ranking = s.ranking.map((id) => ({
      id, name: s.players.find((p) => p.id === id)?.name || null,
    }));
  }
  return view;
}

function isGameOver(s) {
  if (s.phase !== 'ended') return false;
  const ranking = s.ranking.map((id, i) => ({
    id,
    name: s.players.find((p) => p.id === id)?.name || null,
    score: Math.max(0, s.players.length - i),
  }));
  return { over: true, ranking };
}

module.exports = {
  id: 'kittens',
  displayName: '炸弹猫',
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
  CARD,
  CARD_INFO,
  configSchema: {
    turnSeconds: { type: 'options', options: TIME_OPTIONS.turnSeconds, default: DEFAULTS.turnSeconds,
                   unit: 's', label: '单回合时长', hint: '超时会自动替你抽牌' },
    nopeSeconds: { type: 'options', options: TIME_OPTIONS.nopeSeconds, default: DEFAULTS.nopeSeconds,
                   unit: 's', label: '否决响应窗口', hint: '出功能牌后等待其他人否决的时间' },
    defuseSeconds: { type: 'options', options: TIME_OPTIONS.defuseSeconds, default: DEFAULTS.defuseSeconds,
                     unit: 's', label: '拆弹放置时长', hint: '选择炸弹塞回牌堆位置的时间' },
    favorSeconds: { type: 'options', options: TIME_OPTIONS.favorSeconds, default: DEFAULTS.favorSeconds,
                    unit: 's', label: '索要给牌时长', hint: '被索要时挑一张牌给对方;超时随机给' },
  },
};
