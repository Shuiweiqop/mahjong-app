// 中文词库 —— 你画我猜。按类别组织,便于以后加难度/分类。
// 都是常见、易画、家庭友好的中性词汇(无赌博/敏感联想)。

const WORDS = {
  动物: ['猫', '狗', '大象', '长颈鹿', '熊猫', '兔子', '老虎', '猴子', '企鹅', '蛇', '鱼', '螃蟹', '蝴蝶', '乌龟', '猪', '鸡', '牛', '马', '羊', '鸭子'],
  食物: ['苹果', '香蕉', '西瓜', '披萨', '汉堡', '冰淇淋', '面条', '蛋糕', '寿司', '草莓', '玉米', '鸡蛋', '面包', '奶茶', '饺子', '包子', '薯条', '甜甜圈'],
  物品: ['雨伞', '眼镜', '手表', '钥匙', '书本', '剪刀', '灯泡', '气球', '雨鞋', '帽子', '钟表', '牙刷', '吉他', '相机', '足球', '风筝', '铅笔', '扇子'],
  交通: ['汽车', '飞机', '轮船', '自行车', '火车', '热气球', '火箭', '摩托车', '直升机', '公交车'],
  自然: ['太阳', '月亮', '彩虹', '树', '花', '山', '云', '闪电', '雪人', '星星', '仙人掌', '蘑菇'],
  建筑: ['房子', '城堡', '桥', '灯塔', '帐篷', '摩天大楼', '风车'],
};

// 拉平成一个数组(带类别标注,以后可用于难度筛选)
const ALL_WORDS = Object.entries(WORDS).flatMap(([category, list]) =>
  list.map((word) => ({ word, category }))
);

// 根据房主配置构建词池:
//   categories: 选定的分类数组(空=全部)
//   customWords: 房主自定义词数组(有则只用它)
function buildWordPool({ categories, customWords } = {}) {
  if (customWords && customWords.length) {
    return customWords.map((w) => ({ word: String(w).trim(), category: '自定义' })).filter((w) => w.word);
  }
  if (categories && categories.length) {
    return ALL_WORDS.filter((w) => categories.includes(w.category));
  }
  return ALL_WORDS;
}

// 从给定词池随机取 n 个不重复的词(exclude 已用过的)
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

const CATEGORIES = Object.keys(WORDS); // 供前端下拉

module.exports = { WORDS, ALL_WORDS, CATEGORIES, buildWordPool, pickWords };
