// Exploding Kittens deck definition.
//
// Card counts scale with the player count: there is always one bomb fewer than
// players (so exactly one player must be left standing at the end), one defuse
// per player plus a few spares. The remaining action cards follow the ratios of
// the original game.

const CARD = {
  BOMB: 'bomb',            // Exploding kitten: drawing it knocks you out (unless you hold a defuse)
  DEFUSE: 'defuse',        // Defuse: cancels the bomb and lets you slip it back anywhere in the deck
  NOPE: 'nope',            // Nope: cancels the action card just played (and can itself be noped)
  ATTACK: 'attack',        // Attack: you draw nothing, the next player takes two turns in a row
  SKIP: 'skip',            // Skip: end your turn without drawing
  FAVOR: 'favor',          // Favor: name a player who must give you a card
  SHUFFLE: 'shuffle',      // Shuffle: randomize the deck
  FUTURE: 'future',        // See the future: peek at the top three cards of the deck
  // Cat cards have no effect on their own; two of a kind pair up to steal a card
  CAT_TACO: 'cat_taco',
  CAT_MELON: 'cat_melon',
  CAT_BEARD: 'cat_beard',
  CAT_RAINBOW: 'cat_rainbow',
  CAT_POTATO: 'cat_potato',
};

const CAT_CARDS = [CARD.CAT_TACO, CARD.CAT_MELON, CARD.CAT_BEARD, CARD.CAT_RAINBOW, CARD.CAT_POTATO];

// Action cards (the ones that can be played on their own). Cat cards are not in
// this list -- they can only be used in matching sets.
const ACTION_CARDS = [CARD.ATTACK, CARD.SKIP, CARD.FAVOR, CARD.SHUFFLE, CARD.FUTURE];

const CARD_INFO = {
  [CARD.BOMB]:    { name: 'Exploding Kitten', emoji: '💣', desc: 'Draw it and you are out, unless you hold a Defuse' },
  [CARD.DEFUSE]:  { name: 'Defuse',   emoji: '🙅', desc: 'Cancels a bomb and slides it back anywhere in the deck' },
  [CARD.NOPE]:    { name: 'Nope',   emoji: '🚫', desc: 'Interrupts the action card just played (a Nope can itself be Noped)' },
  [CARD.ATTACK]:  { name: 'Attack',   emoji: '⚔️', desc: 'You draw nothing; the next player takes two turns in a row' },
  [CARD.SKIP]:    { name: 'Skip',   emoji: '⏭️', desc: 'Ends your turn without drawing' },
  [CARD.FAVOR]:   { name: 'Favor',   emoji: '🤲', desc: 'Name a player, who must give you one card' },
  [CARD.SHUFFLE]: { name: 'Shuffle',   emoji: '🔀', desc: 'Shuffles the whole deck' },
  [CARD.FUTURE]:  { name: 'See the Future', emoji: '🔮', desc: 'Peek at the top three cards of the deck' },
  [CARD.CAT_TACO]:    { name: 'Taco Cat', emoji: '🌮', desc: 'Two matching cats steal a card' },
  [CARD.CAT_MELON]:   { name: 'Melon Cat', emoji: '🍉', desc: 'Two matching cats steal a card' },
  [CARD.CAT_BEARD]:   { name: 'Beard Cat', emoji: '🧔', desc: 'Two matching cats steal a card' },
  [CARD.CAT_RAINBOW]: { name: 'Rainbow Cat', emoji: '🌈', desc: 'Two matching cats steal a card' },
  [CARD.CAT_POTATO]:  { name: 'Potato Cat', emoji: '🥔', desc: 'Two matching cats steal a card' },
};

// Deck composition apart from bombs and defuses. The more players there are the
// more cards there are, so a game lasts long enough.
function buildDeck(playerCount) {
  const deck = [];
  const scale = playerCount <= 3 ? 1 : playerCount <= 5 ? 1.5 : 2;
  const n = (base) => Math.max(1, Math.round(base * scale));

  for (let i = 0; i < n(4); i++) deck.push(CARD.ATTACK);
  for (let i = 0; i < n(4); i++) deck.push(CARD.SKIP);
  for (let i = 0; i < n(4); i++) deck.push(CARD.NOPE);
  for (let i = 0; i < n(2); i++) deck.push(CARD.FAVOR);
  for (let i = 0; i < n(3); i++) deck.push(CARD.SHUFFLE);
  for (let i = 0; i < n(3); i++) deck.push(CARD.FUTURE);
  for (const cat of CAT_CARDS) {
    for (let i = 0; i < n(3); i++) deck.push(cat);
  }
  return deck;
}

module.exports = { CARD, CAT_CARDS, ACTION_CARDS, CARD_INFO, buildDeck };
