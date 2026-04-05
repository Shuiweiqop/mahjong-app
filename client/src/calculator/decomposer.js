import { tileEq } from './tiles.js';
// 从手牌里移除一张牌
function removeTile(tiles, t) {
  const idx = tiles.findIndex(x => tileEq(x, t));
  if (idx === -1) return null;
  const next = [...tiles];
  next.splice(idx, 1);  
  return next;
}

// 找所有顺子（连续3张数牌）
function findSequences(tiles) {
  const seqs = [];
  for (const t of tiles) {
    if (t.suit === 'z') continue;
    const r1 = removeTile(tiles, t);
    if (!r1) continue;
    const t2 = { suit: t.suit, num: t.num + 1 };
    const r2 = removeTile(r1, t2);
    if (!r2) continue;
    const t3 = { suit: t.suit, num: t.num + 2 };
    const r3 = removeTile(r2, t3);
    if (!r3) continue;
    seqs.push({ type: 'seq', tiles: [t, t2, t3] });
  }
  return seqs;
}

// 找所有刻子（3张相同）
function findTriplets(tiles) {
  const seen = new Set();
  const trips = [];
  for (const t of tiles) {
    const key = `${t.suit}${t.num}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r1 = removeTile(tiles, t);
    const r2 = r1 && removeTile(r1, t);
    const r3 = r2 && removeTile(r2, t);
    if (r3) trips.push({ type: 'tri', tiles: [t, t, t] });
  }
  return trips;
}

// 找所有对子
function findPairs(tiles) {
  const seen = new Set();
  const pairs = [];
  for (const t of tiles) {
    const key = `${t.suit}${t.num}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = removeTile(tiles, t);
    if (r && removeTile(r, t)) {
      pairs.push({ type: 'pair', tiles: [t, t] });
    }
  }
  return pairs;
}

// 递归找所有合法拆法（标准和牌：4组 + 1对）
function decompose(tiles, melds, pairUsed) {
  if (tiles.length === 0 && pairUsed) return [melds];
  if (tiles.length === 0) return [];

  const results = [];

  // 先尝试用对子（如果还没用过）
  if (!pairUsed && tiles.length >= 2) {
    for (const pair of findPairs(tiles)) {
      const rest = removeTile(removeTile(tiles, pair.tiles[0]), pair.tiles[1]);
      const sub = decompose(rest, [...melds, pair], true);
      results.push(...sub);
    }
  }

  // 尝试顺子
  for (const seq of findSequences(tiles)) {
    const rest = seq.tiles.reduce((acc, t) => removeTile(acc, t), tiles);
    if (rest) {
      const sub = decompose(rest, [...melds, seq], pairUsed);
      results.push(...sub);
    }
  }

  // 尝试刻子
  for (const tri of findTriplets(tiles)) {
    const rest = tri.tiles.reduce((acc, t) => removeTile(acc, t), tiles);
    if (rest) {
      const sub = decompose(rest, [...melds, tri], pairUsed);
      results.push(...sub);
    }
  }

  return results;
}

// 检查七对子
function checkSevenPairs(tiles) {
  const counts = {};
  for (const t of tiles) {
    const k = `${t.suit}${t.num}`;
    counts[k] = (counts[k] || 0) + 1;
  }
  const pairs = Object.values(counts).filter(v => v >= 2);
  if (pairs.length === 7) {
    return [{ type: 'seven_pairs', tiles }];
  }
  return null;
}

// 检查国士无双（13幺）
function checkThirteenOrphans(tiles) {
  const required = [
    {suit:'m',num:1},{suit:'m',num:9},
    {suit:'p',num:1},{suit:'p',num:9},
    {suit:'s',num:1},{suit:'s',num:9},
    {suit:'z',num:1},{suit:'z',num:2},{suit:'z',num:3},{suit:'z',num:4},
    {suit:'z',num:5},{suit:'z',num:6},{suit:'z',num:7},
  ];
  const counts = {};
  for (const t of tiles) {
    const k = `${t.suit}${t.num}`;
    counts[k] = (counts[k] || 0) + 1;
  }
  const hasAll = required.every(t => counts[`${t.suit}${t.num}`] >= 1);
  const hasPair = required.some(t => counts[`${t.suit}${t.num}`] >= 2);
  if (hasAll && hasPair) return [{ type: 'thirteen_orphans', tiles }];
  return null;
}

// 主入口：判断是否和牌，返回所有拆法
export function analyzeHand(tiles) {
  if (tiles.length !== 14) return { win: false, decompositions: [] };

  // 七对子
  const sevenPairs = checkSevenPairs(tiles);
  if (sevenPairs) return { win: true, decompositions: [sevenPairs] };

  // 国士无双
  const thirteen = checkThirteenOrphans(tiles);
  if (thirteen) return { win: true, decompositions: [thirteen] };

  // 标准和牌
  const decomps = decompose(tiles, [], false);
  const valid = decomps.filter(d => {
    const pairs = d.filter(m => m.type === 'pair');
    const melds = d.filter(m => m.type !== 'pair');
    return pairs.length === 1 && melds.length === 4;
  });

  // 去重
  const seen = new Set();
  const unique = valid.filter(d => {
    const key = JSON.stringify(d.map(m => m.type + m.tiles.map(t => `${t.suit}${t.num}`).join('')).sort());
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { win: unique.length > 0, decompositions: unique };
}