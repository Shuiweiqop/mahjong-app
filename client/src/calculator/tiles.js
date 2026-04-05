// ── 牌的定义 ────────────────────────────────────────────
// 花色: m=万, p=饼, s=条, z=字牌
// 字牌: z1=东 z2=南 z3=西 z4=北 z5=中 z6=发 z7=白

export const SUITS = ['m', 'p', 's', 'z'];

export const TILE_NAMES = {
  m: ['', '一万', '二万', '三万', '四万', '五万', '六万', '七万', '八万', '九万'],
  p: ['', '一饼', '二饼', '三饼', '四饼', '五饼', '六饼', '七饼', '八饼', '九饼'],
  s: ['', '一条', '二条', '三条', '四条', '五条', '六条', '七条', '八条', '九条'],
  z: ['', '东', '南', '西', '北', '中', '发', '白'],
};

// 创建一张牌对象
export function tile(suit, num) {
  return { suit, num };
}

// 牌转字符串，方便 debug
export function tileToStr(t) {
  return `${t.num}${t.suit}`;
}

// 牌的显示名
export function tileName(t) {
  return TILE_NAMES[t.suit][t.num];
}

// 两张牌是否相同
export function tileEq(a, b) {
  return a.suit === b.suit && a.num === b.num;
}

// 排序（用于标准化手牌）
export function sortTiles(tiles) {
  const order = { m: 0, p: 1, s: 2, z: 3 };
  return [...tiles].sort((a, b) =>
    order[a.suit] - order[b.suit] || a.num - b.num
  );
}

// 是否字牌
export function isHonor(t) { return t.suit === 'z'; }

// 是否老头牌（1、9、字牌）
export function isTerminalOrHonor(t) {
  return t.suit === 'z' || t.num === 1 || t.num === 9;
}

// 是否绿牌（发财用，国标需要）
export function isGreen(t) {
  return (t.suit === 's' && [2,3,4,6,8].includes(t.num)) ||
         (t.suit === 'z' && t.num === 6);
}

// 全部牌（136张）
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