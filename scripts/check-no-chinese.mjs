// Fails if any tracked source file contains Chinese characters outside the places
// where Chinese is load-bearing data rather than display text.
// Run with: node scripts/check-no-chinese.mjs
//
// Exceptions are matched per LINE, not per file. An earlier version allowlisted whole
// files, which quietly hid 38 untranslated comment lines in a module that was on the
// list only for its displayName -- so the allowlist is a list of patterns a matching
// line must contain, and everything else in those files is still checked.
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

// Files whose Chinese is entirely intentional, with the reason. Only these are
// skipped wholesale, and only because every Chinese line in them is data.
const ALLOWED_FILES = {
  'client/src/strings.js': 'holds the zh translation table and the yaku lookup keys',
  'server/games/drawguess/words.js': 'the Chinese word bank and its category keys',
  'client/src/calculator/rules/guobiao.js': 'yaku names are lookup keys into YAKU_EN',
  'client/src/calculator/rules/hk.js': 'yaku names are lookup keys into YAKU_EN',
  'client/src/calculator/guobiao.test.js': 'asserts on the engine\'s Chinese yaku names',
  'client/src/calculator/parser.js': 'CHINESE_MAP parses 东南西北中发白 tile input',
  'client/src/calculator/tiles.js': 'TILE_NAMES reference data for tile display names',
  'client/src/i18n.test.js': 'asserts on Chinese output and untranslated-fallback behaviour',
  'server/routes/auth.test.js': 'multibyte fixtures - the byte-vs-character length test needs them',
  'AGENTS.md': 'documents the exceptions here, quoting them',
  'scripts/check-no-chinese.mjs': 'this file names the characters it looks for',
};

// Individual lines that may contain Chinese anywhere in the tree. A line is exempt
// only if it contains one of these substrings, so a stray comment on the next line
// is still reported.
const ALLOWED_LINES = [
  'displayName:',        // the server's own game name; the client translates it by id
  'label:',              // configSchema label the client falls back to
  'hint:',               // configSchema hint, same
];

const offenders = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    if (['node_modules', '.git', 'dist', 'build'].includes(f)) continue;
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!EXT.has(path.extname(f))) continue;
    const rel = path.relative(ROOT, p).split(path.sep).join('/');
    if (ALLOWED_FILES[rel]) continue;
    const hits = readFileSync(p, 'utf8').split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => HAN.test(line) && !ALLOWED_LINES.some((a) => line.includes(a)));
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
  console.error('user-facing Chinese belongs in the zh table in client/src/strings.js.');
  process.exit(1);
}
console.log(`no unexpected Chinese (${Object.keys(ALLOWED_FILES).length} allowlisted files skipped)`);
