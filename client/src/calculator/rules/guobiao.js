import { isHonor, isTerminalOrHonor, isGreen } from '../tiles.js';

// ══════════════════════════════════════════════════════════
// 国标麻将番型计算器
// 实现主要番型，按番值从高到低
// ══════════════════════════════════════════════════════════

export function calcGB(decompositions, context = {}) {
  if (!decompositions || decompositions.length === 0) return { fan: 0, yaku: [] };

  const first = decompositions[0];

  // 特殊牌型
  if (first[0]?.type === 'thirteen_orphans') {
    return { fan: 88, yaku: [{ name: '十三幺', fan: 88, description: '13种幺九牌各一张加任意一张重复' }] };
  }
  if (first[0]?.type === 'seven_pairs') {
    return calcSevenPairsGB(first[0].tiles, context);
  }

  // 标准牌型 — 选分最高的拆法
  let best = null;
  for (const decomp of decompositions) {
    const result = calcStandardGB(decomp, context);
    if (!best || result.fan > best.fan) best = result;
  }
  return best || { fan: 0, yaku: [] };
}

// ── 七对子 ───────────────────────────────────────────────
function calcSevenPairsGB(tiles, context) {
  const yaku = [];
  let fan = 0;

  // 连七对 (88番): 同花色连续七对
  const suits = tiles.map(t => t.suit);
  const allSameSuit = new Set(suits).size === 1 && suits[0] !== 'z';
  if (allSameSuit) {
    const nums = tiles.map(t => t.num).sort((a, b) => a - b);
    const unique = [...new Set(nums)];
    if (unique.length === 7) {
      let consecutive = true;
      for (let i = 1; i < unique.length; i++) {
        if (unique[i] !== unique[i - 1] + 1) { consecutive = false; break; }
      }
      if (consecutive) {
        yaku.push({ name: '连七对', fan: 88, description: '同花色七个连续对子' });
        return { fan: 88, yaku };
      }
    }
  }

  // 普通七对 (2番)
  yaku.push({ name: '七对', fan: 2, description: '七个对子' });
  fan = 2;

  if (!context.hasOpen) {
    yaku.push({ name: '门前清', fan: 2, description: '手牌未副露' });
    fan += 2;
  }
  if (context.selfDraw) {
    yaku.push({ name: '自摸', fan: 1, description: '自摸和牌' });
    fan += 1;
  }

  return { fan, yaku };
}

// ── 标准牌型 ─────────────────────────────────────────────
function calcStandardGB(decomp, context) {
  const pair  = decomp.find(m => m.type === 'pair');
  const melds = decomp.filter(m => m.type !== 'pair');
  const allTiles = decomp.flatMap(m => m.tiles);
  const yaku = [];
  let fan = 0;

  const addYaku = (name, f, description) => {
    yaku.push({ name, fan: f, description });
    fan += f;
  };

  // 提前定义花色变量（全局使用）
  const suits = new Set(allTiles.map(t => t.suit));
  const hasHonor = suits.has('z');
  const numSuits = [...suits].filter(s => s !== 'z').length;

  // ── 88番 ────────────────────────────────────────────────

  const windMelds = melds.filter(m => m.tiles[0].suit === 'z' && m.tiles[0].num <= 4);
  if (windMelds.length === 4) {
    addYaku('大四喜', 88, '四种风牌各一组刻子');
    return { fan, yaku };
  }

  const dragonMelds = melds.filter(m => m.tiles[0].suit === 'z' && m.tiles[0].num >= 5);
  if (dragonMelds.length === 3) {
    addYaku('大三元', 88, '中发白三组刻子');
    return { fan, yaku };
  }

  const allGreen = allTiles.every(t => isGreen(t));
  if (allGreen) {
    addYaku('绿一色', 88, '全部由绿色牌组成');
    return { fan, yaku };
  }

  if (checkNineLanterns(allTiles)) {
    addYaku('九莲宝灯', 88, '同花色1112345678999加任意一张');
    return { fan, yaku };
  }

  // ── 64番 ────────────────────────────────────────────────

  const windPair = pair && pair.tiles[0].suit === 'z' && pair.tiles[0].num <= 4;
  if (windMelds.length === 3 && windPair) {
    addYaku('小四喜', 64, '三种风刻子加一种风对子');
    return { fan, yaku };
  }

  const dragonPair = pair && pair.tiles[0].suit === 'z' && pair.tiles[0].num >= 5;
  if (dragonMelds.length === 2 && dragonPair) {
    addYaku('小三元', 64, '两组箭牌刻子加一对箭牌');
    return { fan, yaku };
  }

  if (allTiles.every(t => t.suit === 'z')) {
    addYaku('字一色', 64, '手牌全部为字牌');
    return { fan, yaku };
  }

  if (!context.hasOpen && melds.every(m => m.type === 'tri')) {
    addYaku('四暗刻', 64, '四组自摸刻子未副露');
    return { fan, yaku };
  }

  // ── 48番 ────────────────────────────────────────────────

  const siFourSame = checkSameSuitFourIdentical(melds);
  if (siFourSame) {
    addYaku('一色四同顺', 48, '同花色四组完全相同的顺子');
    return { fan, yaku };
  }

  const fourStepTri = checkSameSuitFourStepTriplets(melds);
  if (fourStepTri) {
    addYaku('一色四节高', 48, '同花色四组数字依次递增1的刻子');
    return { fan, yaku };
  }

  // ── 32番 ────────────────────────────────────────────────

  const fourStepSeq = checkSameSuitFourStep(melds);
  if (fourStepSeq) {
    addYaku('一色四步高', 32, '同花色四组递增顺子');
  }

  const allTerminal = decomp.every(m => m.tiles.some(t => isTerminalOrHonor(t)));
  if (allTerminal && allTiles.some(t => t.suit === 'z') && allTiles.some(t => t.suit !== 'z')) {
    addYaku('混幺九', 32, '所有面子和对子都含幺九牌，含字牌');
    return { fan, yaku };
  }

  // ── 24番 ────────────────────────────────────────────────

  // 清一色：移到这里，不加 fan === 0 限制，避免被清龙等番型挡住
  if (numSuits === 1 && !hasHonor) {
    addYaku('清一色', 24, '全部同一花色，无字牌');
  }

  const threeSame = checkSameSuitThreeIdentical(melds);
  if (threeSame && fan === 0) {
    addYaku('一色三同顺', 24, '同花色三组完全相同的顺子');
  }

  const threeStepTri = checkSameSuitThreeStepTriplets(melds);
  if (threeStepTri && fan === 0) {
    addYaku('一色三节高', 24, '同花色三组数字依次递增1的刻子');
  }

  const allNums = allTiles.filter(t => t.suit !== 'z').map(t => t.num);
  const onlyNonHonor = allTiles.every(t => t.suit !== 'z');
  if (onlyNonHonor && allNums.every(n => n >= 7)) {
    addYaku('全大', 24, '所有牌数字为7-9');
    return { fan, yaku };
  }
  if (onlyNonHonor && allNums.every(n => n >= 4 && n <= 6)) {
    addYaku('全中', 24, '所有牌数字为4-6');
    return { fan, yaku };
  }
  if (onlyNonHonor && allNums.every(n => n <= 3)) {
    addYaku('全小', 24, '所有牌数字为1-3');
    return { fan, yaku };
  }

  // ── 16番 ────────────────────────────────────────────────

  if (allTiles.every(t => t.suit !== 'z' && (t.num === 1 || t.num === 9))) {
    addYaku('清幺九', 16, '全部由1和9组成，无字牌');
    return { fan, yaku };
  }

  if (!context.hasOpen) {
    const triCount = melds.filter(m => m.type === 'tri').length;
    if (triCount >= 3) {
      addYaku('三暗刻', 16, '三组暗刻');
    }
  }

  const allContainFive = decomp.every(m => m.tiles.some(t => t.num === 5));
  if (allContainFive && onlyNonHonor) {
    addYaku('全带五', 16, '每组面子和对子都含5');
  }

  const triSameNum = checkTripletsThreeSuits(melds);
  if (triSameNum) addYaku('三同刻', 16, '三种花色相同数字的刻子');

  // ── 12番 ────────────────────────────────────────────────

  if (onlyNonHonor && allNums.every(n => n > 5)) {
    addYaku('大于五', 12, '所有牌数字大于5');
  }
  if (onlyNonHonor && allNums.every(n => n < 5)) {
    addYaku('小于五', 12, '所有牌数字小于5');
  }

  if (windMelds.length === 3) {
    addYaku('三风刻', 12, '三组风牌刻子');
  }

  // ── 8番 ─────────────────────────────────────────────────

  if (numSuits === 1 && hasHonor && fan === 0) {
    addYaku('混一色', 8, '一种花色加字牌');
  }

  const allTri = melds.every(m => m.type === 'tri');
  if (allTri && fan === 0) {
    addYaku('碰碰和', 8, '四组刻子加一对');
  }

  const clearDragon = checkClearDragon(melds);
  if (clearDragon && fan === 0) addYaku('清龙', 16, '同花色1-9顺子各一组');

  const triColorDragon = checkTriColorDragon(melds, pair);
  if (triColorDragon && fan === 0) addYaku('三色双龙会', 16, '三种花色老少副和对子');

  // ── 4番 ─────────────────────────────────────────────────

  const allWithTerminal = decomp.every(m => m.tiles.some(t => isTerminalOrHonor(t)));
  if (allWithTerminal && fan === 0) {
    addYaku('全带幺', 4, '每组面子和对子都含幺九牌');
  }

  if (!context.hasOpen && context.selfDraw && fan === 0) {
    addYaku('不求人', 4, '门清手牌自摸');
  }

  const noTerminal = allTiles.every(t => !isTerminalOrHonor(t));
  if (noTerminal && fan === 0) {
    addYaku('断幺', 4, '手牌无幺九牌和字牌');
  }

  // ── 平和 ─────────────────────────────────────────────────
  const allSeq = melds.every(m => m.type === 'seq');
  const pairNotHonor = pair && !isHonor(pair.tiles[0]);
  if (allSeq && pairNotHonor && fan === 0) {
    addYaku('平和', 2, '四组顺子加非字牌对子');
  }

  // ── 通用加分 ─────────────────────────────────────────────

  for (const d of dragonMelds) {
    const names = { 5: '中', 6: '发', 7: '白' };
    addYaku(`箭刻：${names[d.tiles[0].num]}`, 2, '中发白刻子');
  }

  if (context.prevailing) {
    const prevailingMeld = melds.find(m =>
      m.type === 'tri' && m.tiles[0].suit === 'z' && m.tiles[0].num === context.prevailing
    );
    if (prevailingMeld) addYaku('圈风刻', 2, '当前圈风刻子');
  }
  if (context.seat) {
    const seatMeld = melds.find(m =>
      m.type === 'tri' && m.tiles[0].suit === 'z' && m.tiles[0].num === context.seat
    );
    if (seatMeld) addYaku('门风刻', 2, '自己门风刻子');
  }

  if (context.selfDraw) addYaku('自摸', 1, '自摸和牌');
  if (!context.hasOpen) addYaku('门前清', 2, '手牌未副露');

  // 最少 8 番才算和牌（国标规则）
  if (fan < 8) {
    return { fan: 0, yaku: [], belowMinimum: true };
  }

  return { fan, yaku };
}

// ── 辅助判断函数 ─────────────────────────────────────────

function checkNineLanterns(tiles) {
  const suits = new Set(tiles.map(t => t.suit));
  if (suits.size !== 1 || suits.has('z')) return false;
  const counts = {};
  for (const t of tiles) counts[t.num] = (counts[t.num] || 0) + 1;
  return counts[1] >= 3 && counts[9] >= 3 &&
    [2,3,4,5,6,7,8].every(n => counts[n] >= 1);
}

function checkSameSuitFourIdentical(melds) {
  const seqs = melds.filter(m => m.type === 'seq');
  if (seqs.length < 4) return false;
  for (let i = 0; i <= seqs.length - 4; i++) {
    const ref = seqs[i];
    const matches = seqs.filter(s =>
      s.tiles[0].suit === ref.tiles[0].suit &&
      s.tiles[0].num  === ref.tiles[0].num
    );
    if (matches.length >= 4) return true;
  }
  return false;
}

function checkSameSuitFourStepTriplets(melds) {
  const tris = melds.filter(m => m.type === 'tri' && m.tiles[0].suit !== 'z');
  if (tris.length < 4) return false;
  const suitList = [...new Set(tris.map(m => m.tiles[0].suit))];
  for (const suit of suitList) {
    const nums = tris.filter(m => m.tiles[0].suit === suit)
                     .map(m => m.tiles[0].num).sort((a, b) => a - b);
    if (nums.length >= 4) {
      for (let i = 0; i <= nums.length - 4; i++) {
        if (nums[i+1] === nums[i]+1 && nums[i+2] === nums[i]+2 && nums[i+3] === nums[i]+3)
          return true;
      }
    }
  }
  return false;
}

function checkSameSuitFourStep(melds) {
  const seqs = melds.filter(m => m.type === 'seq' && m.tiles[0].suit !== 'z');
  if (seqs.length < 4) return false;
  const suitList = [...new Set(seqs.map(m => m.tiles[0].suit))];
  for (const suit of suitList) {
    const nums = seqs.filter(m => m.tiles[0].suit === suit)
                     .map(m => m.tiles[0].num).sort((a, b) => a - b);
    if (nums.length >= 4) {
      for (let i = 0; i <= nums.length - 4; i++) {
        if (nums[i+1]-nums[i]===1 && nums[i+2]-nums[i+1]===1 && nums[i+3]-nums[i+2]===1) return true;
      }
      for (let i = 0; i <= nums.length - 4; i++) {
        if (nums[i+1]-nums[i]===2 && nums[i+2]-nums[i+1]===2 && nums[i+3]-nums[i+2]===2) return true;
      }
    }
  }
  return false;
}

function checkSameSuitThreeIdentical(melds) {
  const seqs = melds.filter(m => m.type === 'seq');
  if (seqs.length < 3) return false;
  for (let i = 0; i <= seqs.length - 3; i++) {
    const ref = seqs[i];
    const matches = seqs.filter(s =>
      s.tiles[0].suit === ref.tiles[0].suit &&
      s.tiles[0].num  === ref.tiles[0].num
    );
    if (matches.length >= 3) return true;
  }
  return false;
}

function checkSameSuitThreeStepTriplets(melds) {
  const tris = melds.filter(m => m.type === 'tri' && m.tiles[0].suit !== 'z');
  if (tris.length < 3) return false;
  const suitList = [...new Set(tris.map(m => m.tiles[0].suit))];
  for (const suit of suitList) {
    const nums = tris.filter(m => m.tiles[0].suit === suit)
                     .map(m => m.tiles[0].num).sort((a, b) => a - b);
    if (nums.length >= 3) {
      for (let i = 0; i <= nums.length - 3; i++) {
        if (nums[i+1] === nums[i]+1 && nums[i+2] === nums[i]+2) return true;
      }
    }
  }
  return false;
}

function checkTripletsThreeSuits(melds) {
  const tris = melds.filter(m => m.type === 'tri' && m.tiles[0].suit !== 'z');
  const byNum = {};
  for (const t of tris) {
    const n = t.tiles[0].num;
    if (!byNum[n]) byNum[n] = new Set();
    byNum[n].add(t.tiles[0].suit);
  }
  return Object.values(byNum).some(s => s.size >= 3);
}

function checkClearDragon(melds) {
  const seqs = melds.filter(m => m.type === 'seq');
  const suits = ['m', 'p', 's'];
  for (const suit of suits) {
    const suitSeqs = seqs.filter(m => m.tiles[0].suit === suit).map(m => m.tiles[0].num);
    if (suitSeqs.includes(1) && suitSeqs.includes(4) && suitSeqs.includes(7)) return true;
  }
  return false;
}

function checkTriColorDragon(melds, pair) {
  const seqs = melds.filter(m => m.type === 'seq');
  if (!pair || pair.tiles[0].suit === 'z') return false;
  const pairNum = pair.tiles[0].num;
  if (![2,3,4,5,6,7,8].includes(pairNum)) return false;
  const suits = ['m', 'p', 's'];
  let count = 0;
  for (const suit of suits) {
    const nums = seqs.filter(m => m.tiles[0].suit === suit).map(m => m.tiles[0].num);
    if (nums.includes(1) && nums.includes(7)) count++;
  }
  return count >= 2;
}