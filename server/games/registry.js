// 游戏模块注册表 —— 平台的可扩展接缝。
// 新增游戏只需实现统一接口并在这里注册,平台其余部分无需改动。

const drawguess = require('./drawguess');

const games = {
  [drawguess.id]: drawguess,
};

function getGame(id) {
  return games[id] || null;
}

// 供前端大厅展示的游戏清单
function listGames() {
  return Object.values(games).map((g) => ({
    id: g.id,
    displayName: g.displayName,
    minPlayers: g.minPlayers,
    maxPlayers: g.maxPlayers,
  }));
}

module.exports = { getGame, listGames };
