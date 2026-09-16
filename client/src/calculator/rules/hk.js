import { isHonor, isTerminalOrHonor } from '../tiles.js';

// ── Hong Kong mahjong scoring patterns ───────────────────
// Returns: [{ name, fan, description }]

export function calcHK(decompositions, context = {}) {
  // context: { selfDraw, lastTile, seat, prevailing }
  if (!decompositions || decompositions.length === 0) return { fan: 0, yaku: [] };

  // Special hand shapes
  const first = decompositions[0];
  if (first[0]?.type === 'seven_pairs') {
    return calcSevenPairs(first[0].tiles, context);
  }
  if (first[0]?.type === 'thirteen_orphans') {
    return { fan: 13, yaku: [{ name: '国士无双', fan: 13, description: '13种幺九牌各一张加一对' }] };
  }

  // Standard hand shape -- pick the highest-scoring decomposition
  let best = null;
  for (const decomp of decompositions) {
    const result = calcStandard(decomp, context);
    if (!best || result.fan > best.fan) best = result;
  }
  return best || { fan: 0, yaku: [] };
}

// ── Seven Pairs ──────────────────────────────────────────
function calcSevenPairs(tiles, context) {
  const yaku = [{ name: '七对', fan: 3, description: '七个对子' }];
  let fan = 3;

  // Deluxe Seven Pairs (contains 4 identical tiles)
  const counts = {};
  for (const t of tiles) {
    const k = `${t.suit}${t.num}`;
    counts[k] = (counts[k] || 0) + 1;
  }
  if (Object.values(counts).some(v => v === 4)) {
    yaku.push({ name: '豪华七对', fan: 1, description: '七对中含一对4张相同的牌' });
    fan += 1;
  }

  if (context.selfDraw) {
    yaku.push({ name: '自摸', fan: 1, description: '自己摸牌和牌' });
    fan += 1;
  }

  return { fan, yaku };
}

// ── Standard hand shape ──────────────────────────────────
function calcStandard(decomp, context) {
  const pair = decomp.find(m => m.type === 'pair');
  const melds = decomp.filter(m => m.type !== 'pair');
  const yaku = [];
  let fan = 0;

  // Base win (always awarded)
  yaku.push({ name: '和牌', fan: 1, description: '基本和牌' });
  fan += 1;

  // Self-draw
  if (context.selfDraw) {
    yaku.push({ name: '自摸', fan: 1, description: '自己摸牌和牌' });
    fan += 1;
  }

  // Fully concealed (no melds claimed from other players)
  if (!context.hasOpen) {
    yaku.push({ name: '门清', fan: 1, description: '手牌全部未副露' });
    fan += 1;
  }

  // All Sequences (all sequences + a pair that is not a value tile)
  const allSeq = melds.every(m => m.type === 'seq');
  const pairNotHonor = pair && !isHonor(pair.tiles[0]);
  if (allSeq && pairNotHonor) {
    yaku.push({ name: '平和', fan: 1, description: '四组顺子加非字牌对子' });
    fan += 1;
  }

  // All Triplets (every meld is a triplet)
  const allTri = melds.every(m => m.type === 'tri');
  if (allTri) {
    yaku.push({ name: '对对和', fan: 3, description: '全部刻子（含碰）' });
    fan += 3;
  }

  // Full Flush
  const allSuits = new Set([
    ...melds.flatMap(m => m.tiles.map(t => t.suit)),
    ...pair.tiles.map(t => t.suit)
  ]);
  const noHonor = [...allSuits].every(s => s !== 'z');
  if (allSuits.size === 1 && noHonor) {
    yaku.push({ name: '清一色', fan: 5, description: '所有牌同一花色' });
    fan += 5;
  }

  // Half Flush
  if (allSuits.size === 2 && allSuits.has('z')) {
    yaku.push({ name: '混一色', fan: 3, description: '一种花色加字牌' });
    fan += 3;
  }

  // Terminal/honour triplets (triplets made of terminals or honour tiles)
  const terminalMelds = melds.filter(m =>
    m.type === 'tri' && isTerminalOrHonor(m.tiles[0])
  );
  if (terminalMelds.length > 0) {
    yaku.push({ name: `幺九刻 x${terminalMelds.length}`, fan: terminalMelds.length, description: '含1、9或字牌的刻子' });
    fan += terminalMelds.length;
  }

  // Honour pair (a dragon, or the prevailing/seat wind)
  if (pair && isHonor(pair.tiles[0])) {
    const n = pair.tiles[0].num;
    if (n >= 5) { // Red(5) Green(6) White(7)
      const names = { 5: '中', 6: '发', 7: '白' };
      yaku.push({ name: `役牌：${names[n]}`, fan: 1, description: '三元牌对子' });
      fan += 1;
    }
  }

  // Dragon tiles (triplets of Red/Green/White)
  const dragonMelds = melds.filter(m =>
    m.type === 'tri' && m.tiles[0].suit === 'z' && m.tiles[0].num >= 5
  );
  if (dragonMelds.length === 1) {
    const names = { 5: '中', 6: '发', 7: '白' };
    const n = dragonMelds[0].tiles[0].num;
    yaku.push({ name: `役牌：${names[n]}`, fan: 1, description: '三元牌刻子' });
    fan += 1;
  }
  if (dragonMelds.length === 2) {
    yaku.push({ name: '混幺九', fan: 2, description: '两组三元牌刻子' });
    fan += 2;
  }
  if (dragonMelds.length === 3) {
    yaku.push({ name: '大三元', fan: 8, description: '中发白三组刻子' });
    fan += 8;
  }

  // Wind triplets
  const windMelds = melds.filter(m =>
    m.type === 'tri' && m.tiles[0].suit === 'z' && m.tiles[0].num <= 4
  );
  if (windMelds.length === 4) {
    yaku.push({ name: '大四喜', fan: 13, description: '四种风牌各一组刻子' });
    fan += 13;
  } else if (windMelds.length === 3 && pair?.tiles[0].suit === 'z' && pair?.tiles[0].num <= 4) {
    yaku.push({ name: '小四喜', fan: 6, description: '三种风刻子加一种风对子' });
    fan += 6;
  }

  return { fan, yaku };
}