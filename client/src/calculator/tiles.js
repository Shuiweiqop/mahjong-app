// ── Tile definitions ────────────────────────────────────
// Suits: m=Characters, p=Dots, s=Bamboo, z=honour tiles
// Honours: z1=East z2=South z3=West z4=North z5=Red z6=Green z7=White

export const SUITS = ['m', 'p', 's', 'z'];

// Chinese display names for tiles. This is reference data, not UI text: nothing
// renders it today (tileName below is unused, and the calculator builds its own tile
// faces from the string table). Kept as the canonical mapping.
export const TILE_NAMES = {
  m: ['', '一万', '二万', '三万', '四万', '五万', '六万', '七万', '八万', '九万'],
  p: ['', '一饼', '二饼', '三饼', '四饼', '五饼', '六饼', '七饼', '八饼', '九饼'],
  s: ['', '一条', '二条', '三条', '四条', '五条', '六条', '七条', '八条', '九条'],
  z: ['', '东', '南', '西', '北', '中', '发', '白'],
};

// Create a tile object
export function tile(suit, num) {
  return { suit, num };
}

// Tile to string, handy for debugging
export function tileToStr(t) {
  return `${t.num}${t.suit}`;
}

// Display name of a tile
export function tileName(t) {
  return TILE_NAMES[t.suit][t.num];
}

// Whether two tiles are the same
export function tileEq(a, b) {
  return a.suit === b.suit && a.num === b.num;
}

// Sorting (used to normalize a hand)
export function sortTiles(tiles) {
  const order = { m: 0, p: 1, s: 2, z: 3 };
  return [...tiles].sort((a, b) =>
    order[a.suit] - order[b.suit] || a.num - b.num
  );
}

// Whether it is an honour tile
export function isHonor(t) { return t.suit === 'z'; }

// Whether it is a terminal tile (1, 9, or an honour)
export function isTerminalOrHonor(t) {
  return t.suit === 'z' || t.num === 1 || t.num === 9;
}

// Whether it is a green tile (used for All Green, required by Chinese Official)
export function isGreen(t) {
  return (t.suit === 's' && [2,3,4,6,8].includes(t.num)) ||
         (t.suit === 'z' && t.num === 6);
}

// The full deck (136 tiles)
export function fullDeck() {
  const deck = [];
  for (const suit of ['m', 'p', 's']) {
    for (let n = 1; n <= 9; n++) {
      for (let i = 0; i < 4; i++) deck.push(tile(suit, n));
    }
  }
  for (let n = 1; n <= 7; n++) {
    for (let i = 0; i < 4; i++) deck.push(tile('z', n));
  }
  return deck;
}