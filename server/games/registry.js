// Game module registry —— the platform's extension seam.
// Adding a game only requires implementing the shared interface and registering it here; the rest of the platform needs no changes.

const drawguess = require('./drawguess');
const werewolf = require('./werewolf');
const kittens = require('./kittens');

const games = {
  [drawguess.id]: drawguess,
  [werewolf.id]: werewolf,
  [kittens.id]: kittens,
};

function getGame(id) {
  return games[id] || null;
}

// The list of games for the frontend lobby to display
function listGames() {
  return Object.values(games).map((g) => ({
    id: g.id,
    displayName: g.displayName,
    minPlayers: g.minPlayers,
    maxPlayers: g.maxPlayers,
  }));
}

module.exports = { getGame, listGames };
