import { analyzeHand } from './decomposer.js';
import { sortTiles } from './tiles.js';

// 所有可能的牌（34种）
const ALL_TILES = [
  ...['m','p','s'].flatMap(suit => [1,2,3,4,5,6,7,8,9].map(num => ({ suit, num }))),
  ...[1,2,3,4,5,6,7].map(num => ({ suit: 'z', num })),
];

// 计算听牌：输入13张，返回能和的牌列表
export function calcTenpai(tiles13) {
  if (tiles13.length !== 13) return [];

  const waiting = [];

  for (const candidate of ALL_TILES) {
    // 检查这张牌还有没有剩余（最多4张）
    const used = tiles13.filter(t => t.suit === candidate.suit && t.num === candidate.num).length;
    if (used >= 4) continue;

    const hand14 = sortTiles([...tiles13, candidate]);
    const { win } = analyzeHand(hand14);

    if (win) {
      // 避免重复
      const already = waiting.find(w => w.suit === candidate.suit && w.num === candidate.num);
      if (!already) waiting.push(candidate);
    }
  }

  return waiting;
}

// 计算向听数（shanten）：还差几步能听牌
// -1 = 已和牌, 0 = 听牌, 1 = 一向听, ...
export function calcShanten(tiles) {
  // 简化版：直接枚举看能不能听
  if (tiles.length === 13) {
    const tenpai = calcTenpai(tiles);
    return tenpai.length > 0 ? 0 : 1;
  }
  return -1;
}