// 国标番型计算测试。纯函数,用 node --test 跑,不需要任何测试框架:
//
//   cd client && npm test
//
// 这里钉的都是"算错了不会报错、只会安静地给出一个错数字"的东西 ——
// 番数错了没人会发现,除非有人拿着规则书逐条核对。

import { test } from 'node:test';
import assert from 'node:assert';

import { parseHand } from './parser.js';
import { analyzeHand } from './decomposer.js';
import { calcGB } from './rules/guobiao.js';
import { calcHK } from './rules/hk.js';
import { calcTenpai } from './tenpai.js';

// 算番:返回 { fan, names[] }
const gb = (hand, ctx = {}) => {
  const p = parseHand(hand);
  assert.ok(!p.error, `解析失败: ${p.error}`);
  const a = analyzeHand(p.tiles);
  assert.ok(a.win, `${hand} 应该是和牌`);
  const r = calcGB(a.decompositions, ctx);
  return { fan: r.fan, names: (r.yaku || []).map((y) => y.name), below: !!r.belowMinimum };
};

const CONCEALED_SELF = { hasOpen: false, selfDraw: true };
const CONCEALED_RON = { hasOpen: false, selfDraw: false };

// ── 四暗刻:必须是"暗"的,且不能吃掉清一色 ──

test('四暗刻要求门清自摸 —— 荣和不算', () => {
  // 番种描述自己写着"四组暗刻",荣和时最后一组是明刻。
  const self = gb('111222333444m55m', CONCEALED_SELF);
  const ron = gb('111222333444m55m', CONCEALED_RON);
  assert.ok(self.names.includes('四暗刻'), '门清自摸应算四暗刻');
  assert.ok(!ron.names.includes('四暗刻'), '荣和不该算四暗刻');
});

test('四暗刻不吞掉清一色', () => {
  // 原实现命中四暗刻就 return,而清一色写在后面 —— 清一色四暗刻会少算 24 番。
  const r = gb('111222333444m55m', CONCEALED_SELF);
  assert.ok(r.names.includes('四暗刻'), '应有四暗刻');
  assert.ok(r.names.includes('清一色'), '同一手牌也是清一色,不能被提前 return 吃掉');
});

test('四暗刻与三暗刻不重复计算', () => {
  // 四组暗刻已经包含三组,国标不重复计
  const r = gb('111222333444m55m', CONCEALED_SELF);
  assert.ok(!(r.names.includes('四暗刻') && r.names.includes('三暗刻')),
    '四暗刻与三暗刻不能同时出现');
});

// ── 断幺:曾被"不求人"挡住 ──

test('断幺不被"不求人"挡住', () => {
  // 断幺讲牌型、不求人讲和牌方式,两者不是同一维度,互相挡是错的。
  // 修复前这手门清自摸只有 不求人4+自摸1+门前清2 = 7 番 < 8,被判"不能和牌"。
  const r = gb('234m567m345p678s55p', CONCEALED_SELF);
  assert.ok(r.names.includes('断幺'), '无幺九字牌应算断幺');
  assert.ok(r.fan >= 8, `国标 8 番起和,实际 ${r.fan} 番`);
  assert.ok(!r.below, '不该被判为未达起和番');
});

test('不求人不与自摸/门前清重复计算', () => {
  // 不求人 = 门清 + 自摸,三者同时计会多出 3 番
  const r = gb('234m567m345p678s55p', CONCEALED_SELF);
  assert.ok(r.names.includes('不求人'));
  assert.ok(!r.names.includes('自摸'), '不求人已含自摸');
  assert.ok(!r.names.includes('门前清'), '不求人已含门前清');
});

test('非门清自摸时仍单独计自摸/门前清', () => {
  const r = gb('123456789m123p11s', CONCEALED_RON);
  assert.ok(r.names.includes('门前清'), '荣和门清仍应计门前清');
  assert.ok(!r.names.includes('不求人'), '荣和不是不求人');
});

// ── 高番牌型回归(改动没碰它们,但结构改了,要确认没坏) ──

test('高番牌型仍然正确', () => {
  const cases = [
    ['111z222z333z444z55z', '大四喜', 88],
    ['555z666z777z123m11p', '大三元', 88],
    ['19m19p19s1234567z1z', '十三幺', 88],
  ];
  for (const [hand, name, fan] of cases) {
    const r = gb(hand, {});
    assert.ok(r.names.includes(name), `${hand} 应为 ${name},实际 ${r.names}`);
    assert.strictEqual(r.fan, fan, `${name} 应为 ${fan} 番`);
  }
});

test('国标 8 番起和:不够番判不能和', () => {
  // 断幺平和荣和只有 4+2=6 番,国标本就不能和 —— 这是规则不是 bug
  const r = gb('234m567m345p678s55p', CONCEALED_RON);
  assert.strictEqual(r.fan, 0);
  assert.ok(r.below, '应标记 belowMinimum,UI 据此提示"未达 8 番"');
});

// ── 解析器 ──

test('解析器:汉字与数字格式都支持', () => {
  assert.strictEqual(parseHand('123m456m789m东东东中中').tiles.length, 14);
  assert.strictEqual(parseHand('1122m3344p5566s77z').tiles.length, 14);
});

test('解析器:非法输入报错而不是静默返回垃圾', () => {
  for (const bad of ['abc', '0m', '123x', '999999999m']) {
    assert.ok(parseHand(bad).error, `${bad} 应报错`);
  }
});

// ── 听牌 ──

test('听牌返回等待的牌', () => {
  const p = parseHand('123m456m789m123p1s');
  const waits = calcTenpai(p.tiles);
  assert.strictEqual(waits.length, 1, '应听 1 种');
  assert.strictEqual(waits[0].suit, 's');
  assert.strictEqual(waits[0].num, 1);
});

test('十三幺听 13 面', () => {
  const p = parseHand('19m19p19s1234567z');
  assert.strictEqual(p.tiles.length, 13);
  assert.strictEqual(calcTenpai(p.tiles).length, 13, '十三幺单钓应听 13 面');
});

// ── 港式(未改动,回归用) ──

test('港麻基本番型可算', () => {
  const p = parseHand('1122m3344p5566s77z');
  const a = analyzeHand(p.tiles);
  const r = calcHK(a.decompositions, {});
  assert.ok(r.fan > 0, '七对应有番');
});
