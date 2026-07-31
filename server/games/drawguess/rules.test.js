// 你画我猜规则测试 —— 重点是笔画的限量/校验与视图体积。
//
// 这些约束违反了不会崩:画布越画越大,广播越来越慢,直到免费实例扛不住。
// 没有测试的话谁也不会发现,因为本地两个标签页永远画不满一轮。
//
//   cd server && npm test

const { test } = require('node:test');
const assert = require('node:assert');

const dg = require('./index');

const P = (n) => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i }));
const seg = () => ({
  from: [Math.random(), Math.random()], to: [Math.random(), Math.random()],
  color: '#000000', size: 4,
});

// 造一个已进入作画阶段的状态
function drawState(n = 4) {
  const s = dg.createInitialState(P(n), {});
  dg.applyAction(s, { type: 'start' }, s.hostId);
  if (s.phase === 'pick') dg.applyAction(s, { type: 'pick', word: s.wordChoices[0] }, s.drawerId);
  return s;
}
const guesserOf = (s) => s.players.find((p) => p.id !== s.drawerId).id;

// ── 笔画限量(防止画布无限增长) ──

test('单轮笔画有上限,超出部分被丢弃而不是报错', () => {
  const s = drawState();
  for (let i = 0; i < 100; i++) {
    const r = dg.applyAction(s, { type: 'stroke', strokes: Array.from({ length: 500 }, seg) }, s.drawerId);
    assert.ok(!r.error, '到达上限后应静默丢弃,不能打断画手');
  }
  assert.ok(s.strokes.length <= 20000, `笔画数应有上限,实际 ${s.strokes.length}`);
});

test('单条消息的笔画数有上限(挡住一次性塞爆内存)', () => {
  const s = drawState();
  dg.applyAction(s, { type: 'stroke', strokes: Array.from({ length: 200000 }, seg) }, s.drawerId);
  assert.ok(s.strokes.length <= 500, `单条消息不应能推入 ${s.strokes.length} 段`);
});

test('非法笔画被丢弃,越界数值被夹回合法区间', () => {
  const s = drawState();
  dg.applyAction(s, { type: 'stroke', strokes: [
    { evil: '<script>' },                                             // 无 from/to → 丢弃
    { from: [5, -3], to: [0.5, 0.5], color: 'javascript:x', size: 9999 }, // 夹紧 + 换默认色
  ] }, s.drawerId);

  assert.strictEqual(s.strokes.length, 1, '格式错误的笔画应被丢弃');
  const [k] = s.strokes;
  assert.deepStrictEqual(k.from, [1, 0], '坐标应夹回 0..1');
  assert.strictEqual(k.color, '#000000', '非法颜色应换成默认色');
  assert.ok(k.size <= 64, '线宽应有上限');
  assert.deepStrictEqual(Object.keys(k).sort(), ['color', 'from', 'size', 'to'], '不应保留额外字段');
});

test('非画手不能画', () => {
  const s = drawState();
  assert.ok(dg.applyAction(s, { type: 'stroke', strokes: [seg()] }, guesserOf(s)).error);
});

// ── 视图体积(核心:常规广播不带全量画布) ──

test('在场玩家的常规视图不携带全量笔画', () => {
  const s = drawState(8);
  for (let i = 0; i < 20; i++) {
    dg.applyAction(s, { type: 'stroke', strokes: Array.from({ length: 500 }, seg) }, s.drawerId);
  }
  assert.ok(s.strokes.length > 5000, '前置条件:画布上应有大量笔画');

  const view = dg.serializeStateFor(s, guesserOf(s));
  assert.strictEqual(view.strokes, undefined, '在场玩家靠 stroke 事件收增量,不该每次广播都收全量');

  const kb = Buffer.byteLength(JSON.stringify(view), 'utf8') / 1024;
  assert.ok(kb < 50, `视图应保持很小,实际 ${kb.toFixed(1)} KB`);
});

test('中途加入者/掉线者拿得到全量笔画(否则画布是空的)', () => {
  const s = drawState(4);
  dg.applyAction(s, { type: 'stroke', strokes: Array.from({ length: 10 }, seg) }, s.drawerId);

  const spec = dg.serializeStateFor(s, '__spectator__');
  assert.strictEqual(spec.strokes?.length, 10, '观战者需要全量补画');

  const g = guesserOf(s);
  s.absent[g] = true;
  assert.strictEqual(dg.serializeStateFor(s, g).strokes?.length, 10, '重连者需要全量补画');
});

test('清空/换轮会推进 strokeRev,让前端知道要重绘', () => {
  const s = drawState();
  const rev0 = s.strokeRev;

  dg.applyAction(s, { type: 'stroke', strokes: [seg()] }, s.drawerId);
  assert.strictEqual(s.strokeRev, rev0, '普通落笔不该推进版本号(增量走 stroke 事件)');

  dg.applyAction(s, { type: 'clear' }, s.drawerId);
  assert.ok(s.strokeRev > rev0, '清空必须推进版本号');
  assert.deepStrictEqual(
    dg.serializeStateFor(s, guesserOf(s)).strokes, [],
    '清空后应下发空数组让前端清屏'
  );
});

// ── 猜词 ──

test('猜测文本被截断,不能当成任意长度的广播通道', () => {
  const s = drawState();
  const r = dg.applyAction(s, { type: 'guess', text: 'x'.repeat(100000) }, guesserOf(s));
  assert.ok(r.events[0].text.length <= 100, `猜测广播长度应有上限,实际 ${r.events[0].text.length}`);
});

test('猜中仍正常计分,首尾空格不影响判定', () => {
  const s = drawState();
  const g = guesserOf(s);
  dg.applyAction(s, { type: 'guess', text: '  ' + s.word + ' ' }, g);
  assert.ok(s.scores[g] > 0, '带空格的正确答案应判对');
  assert.ok(s.scores[s.drawerId] > 0, '画手也应得分');
});

test('猜错的内容不会泄露答案,且已猜中者不能重复得分', () => {
  const s = drawState();
  const g = guesserOf(s);
  const wrong = dg.applyAction(s, { type: 'guess', text: '错的' }, g);
  assert.ok(!JSON.stringify(wrong.events).includes(s.word), '猜错的广播里不该出现答案');

  dg.applyAction(s, { type: 'guess', text: s.word }, g);
  const pts = s.scores[g];
  assert.ok(dg.applyAction(s, { type: 'guess', text: s.word }, g).error, '已猜中者不能再猜');
  assert.strictEqual(s.scores[g], pts, '分数不应重复累加');
});

test('画手不能猜自己的词', () => {
  const s = drawState();
  assert.ok(dg.applyAction(s, { type: 'guess', text: s.word }, s.drawerId).error);
});

test('猜者视图不含答案,画手视图含答案', () => {
  const s = drawState();
  const view = dg.serializeStateFor(s, guesserOf(s));
  assert.strictEqual(view.word, undefined, '猜者视图绝不能带 word');
  assert.strictEqual(typeof view.wordLength, 'number', '猜者应拿到词长占位');
  assert.strictEqual(dg.serializeStateFor(s, s.drawerId).word, s.word, '画手应看到答案');
});
