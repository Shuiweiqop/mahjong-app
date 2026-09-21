// Word banks for Draw & Guess. Organised by category so difficulty/filtering can be
// added later. Everything is common, easy to draw and family-friendly (no gambling or
// otherwise sensitive associations).
//
// There are two parallel banks, Chinese and English. The CATEGORY KEYS are the Chinese
// strings in both banks on purpose: the client translates those keys for display (see the
// `cat.*` entries in client/src/i18n.jsx) and the room config stores the host's selected
// categories by that key. Renaming them would break both.

const WORDS = {
  动物: ['猫', '狗', '大象', '长颈鹿', '熊猫', '兔子', '老虎', '猴子', '企鹅', '蛇', '鱼', '螃蟹', '蝴蝶', '乌龟', '猪', '鸡', '牛', '马', '羊', '鸭子'],
  食物: ['苹果', '香蕉', '西瓜', '披萨', '汉堡', '冰淇淋', '面条', '蛋糕', '寿司', '草莓', '玉米', '鸡蛋', '面包', '奶茶', '饺子', '包子', '薯条', '甜甜圈'],
  物品: ['雨伞', '眼镜', '手表', '钥匙', '书本', '剪刀', '灯泡', '气球', '雨鞋', '帽子', '钟表', '牙刷', '吉他', '相机', '足球', '风筝', '铅笔', '扇子'],
  交通: ['汽车', '飞机', '轮船', '自行车', '火车', '热气球', '火箭', '摩托车', '直升机', '公交车'],
  自然: ['太阳', '月亮', '彩虹', '树', '花', '山', '云', '闪电', '雪人', '星星', '仙人掌', '蘑菇'],
  建筑: ['房子', '城堡', '桥', '灯塔', '帐篷', '摩天大楼', '风车'],
};

// English bank. Same category keys, comparable sizes per category.
const WORDS_EN = {
  动物: ['cat', 'dog', 'elephant', 'giraffe', 'panda', 'rabbit', 'tiger', 'monkey', 'penguin', 'snake', 'fish', 'crab', 'butterfly', 'turtle', 'pig', 'chicken', 'cow', 'horse', 'sheep', 'duck'],
  食物: ['apple', 'banana', 'watermelon', 'pizza', 'burger', 'ice cream', 'noodles', 'cake', 'sushi', 'strawberry', 'corn', 'egg', 'bread', 'milk tea', 'dumpling', 'pancake', 'fries', 'donut'],
  物品: ['umbrella', 'glasses', 'watch', 'key', 'book', 'scissors', 'light bulb', 'balloon', 'boots', 'hat', 'clock', 'toothbrush', 'guitar', 'camera', 'soccer ball', 'kite', 'pencil', 'fan'],
  交通: ['car', 'airplane', 'ship', 'bicycle', 'train', 'hot air balloon', 'rocket', 'motorcycle', 'helicopter', 'bus'],
  自然: ['sun', 'moon', 'rainbow', 'tree', 'flower', 'mountain', 'cloud', 'lightning', 'snowman', 'star', 'cactus', 'mushroom'],
  建筑: ['house', 'castle', 'bridge', 'lighthouse', 'tent', 'skyscraper', 'windmill'],
};

// Flatten a bank into one array, tagging each word with its category (usable later for
// difficulty filtering).
function flatten(bank) {
  return Object.entries(bank).flatMap(([category, list]) =>
    list.map((word) => ({ word, category }))
  );
}

const ALL_WORDS = flatten(WORDS);
const ALL_WORDS_EN = flatten(WORDS_EN);

// Language registry. 'zh' is the default everywhere, so every existing caller keeps the
// exact behaviour it had before the English bank existed.
const BANKS = {
  zh: { words: WORDS, all: ALL_WORDS },
  en: { words: WORDS_EN, all: ALL_WORDS_EN },
};
const DEFAULT_LANG = 'zh';

// An unknown/absent language falls back to Chinese rather than throwing — a bad config
// value should not be able to crash room creation.
function bankFor(lang) {
  return BANKS[lang] || BANKS[DEFAULT_LANG];
}

// Build the word pool from the host's config:
//   categories:  selected category keys (empty = all)
//   customWords: host's own words (if present, only these are used)
//   lang:        'zh' (default) or 'en'; custom words are language-agnostic
function buildWordPool({ categories, customWords, lang = DEFAULT_LANG } = {}) {
  if (customWords && customWords.length) {
    return customWords.map((w) => ({ word: String(w).trim(), category: '自定义' })).filter((w) => w.word);
  }
  const all = bankFor(lang).all;
  if (categories && categories.length) {
    return all.filter((w) => categories.includes(w.category));
  }
  return all;
}

// Pick n distinct random words from the given pool (skipping any already in exclude).
function pickWords(n = 3, exclude = [], pool = ALL_WORDS) {
  const avail = pool.filter((w) => !exclude.includes(w.word));
  const picked = [];
  const used = new Set();
  while (picked.length < n && picked.length < avail.length) {
    const idx = Math.floor(Math.random() * avail.length);
    if (used.has(idx)) continue;
    used.add(idx);
    picked.push(avail[idx]);
  }
  return picked;
}

const CATEGORIES = Object.keys(WORDS); // for the frontend dropdown

module.exports = {
  WORDS,
  WORDS_EN,
  ALL_WORDS,
  ALL_WORDS_EN,
  CATEGORIES,
  DEFAULT_LANG,
  buildWordPool,
  pickWords,
};
