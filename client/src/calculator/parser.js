import { tile, sortTiles } from './tiles.js';

// 解析文字输入
// 支持格式: "123m456p789s1122z" 或 "1m2m3m东东东中中中发发发白白"
// 也支持汉字: 东南西北中发白

const CHINESE_MAP = {
  '东': 'z1', '南': 'z2', '西': 'z3', '北': 'z4',
  '中': 'z5', '发': 'z6', '白': 'z7',
};

export function parseHand(input) {
  if (!input) return { tiles: [], error: null };

  let str = input.trim();

  // 替换汉字
  for (const [ch, code] of Object.entries(CHINESE_MAP)) {
    str = str.split(ch).join(code.replace('z', '') + 'z_');
  }
  str = str.replace(/z_/g, 'z');

  // 解析 "123m" 格式
  const tiles = [];
  const regex = /(\d+)([mpsz])/g;
  let match;

  while ((match = regex.exec(str)) !== null) {
    const nums = match[1].split('').map(Number);
    const suit = match[2];

    for (const n of nums) {
      if (suit === 'z' && (n < 1 || n > 7)) {
        return { tiles: [], error: `无效字牌: z${n}` };
      }
      if (suit !== 'z' && (n < 1 || n > 9)) {
        return { tiles: [], error: `无效数牌: ${n}${suit}` };
      }
      tiles.push(tile(suit, n));
    }
  }

  if (tiles.length === 0) {
    return { tiles: [], error: '无法解析输入' };
  }

  if (tiles.length !== 13 && tiles.length !== 14) {
    return { tiles, error: `需要13或14张牌，当前${tiles.length}张` };
  }

  return { tiles: sortTiles(tiles), error: null };
}