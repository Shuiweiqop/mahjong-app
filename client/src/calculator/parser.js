import { tile, sortTiles } from './tiles.js';

// Parse text input
// Supported formats: "123m456p789s1122z" or "1m2m3m东东东中中中发发发白白"
// Chinese characters are also supported: 东南西北中发白
//
// error is not a human-readable string but a { key, vars } pair -- the parser does not
// know the UI language, so the caller renders it from the message table (see errText in
// CalculatorScreen).

const CHINESE_MAP = {
  '东': 'z1', '南': 'z2', '西': 'z3', '北': 'z4',
  '中': 'z5', '发': 'z6', '白': 'z7',
};

export function parseHand(input) {
  if (!input) return { tiles: [], error: null };

  let str = input.trim();

  // Replace the Chinese characters
  for (const [ch, code] of Object.entries(CHINESE_MAP)) {
    str = str.split(ch).join(code.replace('z', '') + 'z_');
  }
  str = str.replace(/z_/g, 'z');

  // Parse the "123m" format
  const tiles = [];
  const regex = /(\d+)([mpsz])/g;
  let match;

  while ((match = regex.exec(str)) !== null) {
    const nums = match[1].split('').map(Number);
    const suit = match[2];

    for (const n of nums) {
      if (suit === 'z' && (n < 1 || n > 7)) {
        return { tiles: [], error: { key: 'calc.err.badHonour', vars: { n } } };
      }
      if (suit !== 'z' && (n < 1 || n > 9)) {
        return { tiles: [], error: { key: 'calc.err.badTile', vars: { n, suit } } };
      }
      tiles.push(tile(suit, n));
    }
  }

  if (tiles.length === 0) {
    return { tiles: [], error: { key: 'calc.err.unparsable' } };
  }

  if (tiles.length !== 13 && tiles.length !== 14) {
    return { tiles, error: { key: 'calc.err.wrongCount', vars: { n: tiles.length } } };
  }

  return { tiles: sortTiles(tiles), error: null };
}