// Server lint config. Minimal by design — its one job is to make the
// information-hiding invariant fail loudly instead of living in prose.
//
// See AGENTS.md and docs/game-module.md: clients must only ever receive
// serializeStateFor(state, playerId), never the raw `state` (which holds every
// role and the secret word). The rule below turns a raw-state leak red.

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    files: ['**/*.js'],
    ignores: ['node_modules/**'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // Catch the actual footgun: `.emit('game_state', state)` or
      // `.emit('game_state', room.state)` — broadcasting the raw authoritative
      // state (every role + the secret word) instead of a per-player view.
      // Deny-list, not allow-list: we can't prove a payload IS a serialized
      // view (it's usually a local like `view` holding a serializeStateFor
      // result — legitimate), but we CAN reject a bare `state`/`*.state`
      // reference, which is never correct here. Keeps false positives at zero.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name='emit'][arguments.0.value='game_state'] > Identifier.arguments[name='state']",
          message:
            "Never emit raw `state` — it leaks every role and the secret word. Emit serializeStateFor(state, playerId). See docs/game-module.md.",
        },
        {
          selector:
            "CallExpression[callee.property.name='emit'][arguments.0.value='game_state'] > MemberExpression.arguments[property.name='state']",
          message:
            "Never emit raw `.state` — it leaks every role and the secret word. Emit serializeStateFor(state, playerId). See docs/game-module.md.",
        },
      ],
    },
  },
];
