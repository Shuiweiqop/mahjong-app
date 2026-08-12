// 炸弹猫牌库定义。
//
// 牌数按人数缩放:炸弹永远比人数少 1(所以最后必然只剩一人),拆弹每人 1 张
// 再加少量余牌。其余功能牌按原版比例。

const CARD = {
  BOMB: 'bomb',            // 炸弹猫:抽到即出局(除非有拆弹)
  DEFUSE: 'defuse',        // 拆弹:抵消炸弹,并把炸弹塞回牌堆任意位置
  NOPE: 'nope',            // 否决:打断上一张功能牌(可被再否决)
  ATTACK: 'attack',        // 攻击:自己不抽牌,下家连打两回合
  SKIP: 'skip',            // 跳过:结束回合且不抽牌
  FAVOR: 'favor',          // 索要:指定一名玩家给你一张牌
  SHUFFLE: 'shuffle',      // 洗牌:打乱牌堆
  FUTURE: 'future',        // 洞悉未来:看牌堆顶三张
  // 猫咪牌本身没有效果,两张同款可以配对偷牌
  CAT_TACO: 'cat_taco',
  CAT_MELON: 'cat_melon',
  CAT_BEARD: 'cat_beard',
  CAT_RAINBOW: 'cat_rainbow',
  CAT_POTATO: 'cat_potato',
};

const CAT_CARDS = [CARD.CAT_TACO, CARD.CAT_MELON, CARD.CAT_BEARD, CARD.CAT_RAINBOW, CARD.CAT_POTATO];

// 功能牌(可以单张打出的)。猫咪牌不在此列 —— 它们只能成对使用。
const ACTION_CARDS = [CARD.ATTACK, CARD.SKIP, CARD.FAVOR, CARD.SHUFFLE, CARD.FUTURE];

const CARD_INFO = {
  [CARD.BOMB]:    { name: '炸弹猫', emoji: '💣', desc: '抽到即出局,除非你有拆弹' },
  [CARD.DEFUSE]:  { name: '拆弹',   emoji: '🙅', desc: '抵消炸弹,并把它塞回牌堆任意位置' },
  [CARD.NOPE]:    { name: '否决',   emoji: '🚫', desc: '打断刚打出的功能牌(否决也能被否决)' },
  [CARD.ATTACK]:  { name: '攻击',   emoji: '⚔️', desc: '自己不抽牌,下家连打两回合' },
  [CARD.SKIP]:    { name: '跳过',   emoji: '⏭️', desc: '结束回合且不用抽牌' },
  [CARD.FAVOR]:   { name: '索要',   emoji: '🤲', desc: '指定一名玩家给你一张牌' },
  [CARD.SHUFFLE]: { name: '洗牌',   emoji: '🔀', desc: '打乱整个牌堆' },
  [CARD.FUTURE]:  { name: '洞悉未来', emoji: '🔮', desc: '偷看牌堆顶三张' },
  [CARD.CAT_TACO]:    { name: '塔可猫', emoji: '🌮', desc: '两张同款可偷一张牌' },
  [CARD.CAT_MELON]:   { name: '西瓜猫', emoji: '🍉', desc: '两张同款可偷一张牌' },
  [CARD.CAT_BEARD]:   { name: '胡须猫', emoji: '🧔', desc: '两张同款可偷一张牌' },
  [CARD.CAT_RAINBOW]: { name: '彩虹猫', emoji: '🌈', desc: '两张同款可偷一张牌' },
  [CARD.CAT_POTATO]:  { name: '土豆猫', emoji: '🥔', desc: '两张同款可偷一张牌' },
};

// 除炸弹和拆弹外的牌堆构成。人数越多牌越多,保证摸得够久。
function buildDeck(playerCount) {
  const deck = [];
  const scale = playerCount <= 3 ? 1 : playerCount <= 5 ? 1.5 : 2;
  const n = (base) => Math.max(1, Math.round(base * scale));

  for (let i = 0; i < n(4); i++) deck.push(CARD.ATTACK);
  for (let i = 0; i < n(4); i++) deck.push(CARD.SKIP);
  for (let i = 0; i < n(4); i++) deck.push(CARD.NOPE);
  for (let i = 0; i < n(2); i++) deck.push(CARD.FAVOR);
  for (let i = 0; i < n(3); i++) deck.push(CARD.SHUFFLE);
  for (let i = 0; i < n(3); i++) deck.push(CARD.FUTURE);
  for (const cat of CAT_CARDS) {
    for (let i = 0; i < n(3); i++) deck.push(cat);
  }
  return deck;
}

module.exports = { CARD, CAT_CARDS, ACTION_CARDS, CARD_INFO, buildDeck };
