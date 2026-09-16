// Fails if any tracked source file contains Chinese characters, with a short
// allowlist for the places where Chinese is load-bearing data rather than text.
// Run with: node scripts/check-no-chinese.mjs
//
// Note for anyone grepping by hand: the shell-friendly range [一-龥] also matches
// em-dashes and box-drawing characters in some locales, which produces confusing
// false positives. This uses \p{Script=Han}, which does not.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HAN = /\p{Script=Han}/u;
const EXT = new Set(['.js', '.jsx', '.md', '.json', '.html', '.css']);

// Files where Chinese is intentional. Each entry says why, because a bare list
// invites someone to add to it without justification.
const ALLOWED = {
  'client/src/i18n.jsx': 'holds the zh translation table and the yaku lookup keys',
  'server/games/drawguess/words.js': 'the Chinese word bank and its category keys',
  'client/src/calculator/rules/guobiao.js': 'yaku names are lookup keys into YAKU_EN',
  'client/src/calculator/rules/hk.js': 'yaku names are lookup keys into YAKU_EN',
  'client/src/calculator/guobiao.test.js': 'asserts on the engine\'s Chinese yaku names',
  'client/src/calculator/parser.js': 'CHINESE_MAP parses 东南西北中发白 tile input',
  'client/src/calculator/tiles.js': 'TILE_NAMES reference data for tile display names',
  'server/games/werewolf/index.js': 'displayName + configSchema label/hint the client falls back to',
  'server/games/kittens/index.js': 'displayName + configSchema label/hint the client falls back to',
  'server/games/drawguess/index.js': 'displayName + configSchema label/hint the client falls back to',
  'server/routes/auth.test.js': 'multibyte fixtures - the byte-vs-character length test needs them',
  'AGENTS.md': 'documents the exceptions above, quoting them',
  'scripts/check-no-chinese.mjs': 'this file names the characters it looks for',
};

const offenders = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    if (['node_modules', '.git', 'dist', 'build'].includes(f)) continue;
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!EXT.has(path.extname(f))) continue;
    const rel = path.relative(ROOT, p).split(path.sep).join('/');
    if (ALLOWED[rel]) continue;
    const lines = readFileSync(p, 'utf8').split('\n');
    const hits = lines
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => HAN.test(line));
    if (hits.length) offenders.push([rel, hits]);
  }
};
walk(ROOT);

if (offenders.length) {
  for (const [file, hits] of offenders) {
    console.error(`${file}  (${hits.length} line${hits.length > 1 ? 's' : ''})`);
    for (const [n, line] of hits.slice(0, 5)) console.error(`  ${n}: ${line.trim().slice(0, 90)}`);
    if (hits.length > 5) console.error(`  … ${hits.length - 5} more`);
  }
  console.error(`\nChinese found in ${offenders.length} file(s). Code and comments should be English;`);
  console.error('user-facing Chinese belongs in the zh table in client/src/i18n.jsx.');
  process.exit(1);
}
console.log(`no unexpected Chinese (${Object.keys(ALLOWED).length} allowlisted files skipped)`);
