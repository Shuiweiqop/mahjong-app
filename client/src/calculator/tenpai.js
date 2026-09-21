import { analyzeHand } from './decomposer.js';
import { sortTiles } from './tiles.js';

// Every possible tile (34 kinds)
const ALL_TILES = [
  ...['m','p','s'].flatMap(suit => [1,2,3,4,5,6,7,8,9].map(num => ({ suit, num }))),
  ...[1,2,3,4,5,6,7].map(num => ({ suit: 'z', num })),
];

// Compute the waits: given 13 tiles, return the list of tiles that complete the hand
export function calcTenpai(tiles13) {
  if (tiles13.length !== 13) return [];

  const waiting = [];

  for (const candidate of ALL_TILES) {
    // Check whether any copy of this tile is left (4 at most)
    const used = tiles13.filter(t => t.suit === candidate.suit && t.num === candidate.num).length;
    if (used >= 4) continue;

    const hand14 = sortTiles([...tiles13, candidate]);
    const { win } = analyzeHand(hand14);

    if (win) {
      // Avoid duplicates
      const already = waiting.find(w => w.suit === candidate.suit && w.num === candidate.num);
      if (!already) waiting.push(candidate);
    }
  }

  return waiting;
}

// Compute the shanten count: how many steps away the hand is from being ready
// -1 = already won, 0 = ready (tenpai), 1 = one away, ...
export function calcShanten(tiles) {
  // Simplified version: just enumerate and see whether the hand is ready
  if (tiles.length === 13) {
    const tenpai = calcTenpai(tiles);
    return tenpai.length > 0 ? 0 : 1;
  }
  return -1;
}