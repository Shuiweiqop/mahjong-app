// i18n consistency checks. Run with: node scripts/check-i18n.mjs
//
// Three things can silently break the bilingual UI, and none of them is caught by
// the unit tests, because each is a gap *between* two files rather than a bug in
// either one:
//   1. a key present in one language table but not the other
//   2. a t('...') call for a key that no table defines
//   3. a server error code with no err.* entry, so the user sees a raw code
//
// Exits non-zero on any of them, so this is safe to wire into CI.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_SRC = path.join(ROOT, 'client', 'src');
const SERVER = path.join(ROOT, 'server');
const I18N = path.join(CLIENT_SRC, 'i18n.jsx');

const src = readFileSync(I18N, 'utf8');

// The two tables are object literals inside STRINGS; slice them apart by their
// opening lines rather than parsing, which keeps this script dependency-free.
const enStart = src.indexOf('  en: {');
const zhStart = src.indexOf('  zh: {');
if (enStart < 0 || zhStart < 0) {
  console.error('could not locate the en/zh tables in i18n.jsx');
  process.exit(1);
}
// The zh table is the last member of STRINGS, so it ends at that object's closing
// "\n};" - without this bound the slice would run on into the YAKU_EN map below,
// whose keys are Chinese yaku names and would look like untranslated entries.
const stringsEnd = src.indexOf('\n};', zhStart);
if (stringsEnd < 0) {
  console.error('could not find the end of the STRINGS object in i18n.jsx');
  process.exit(1);
}
const keysIn = (block) => new Set([...block.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]));
const en = keysIn(src.slice(enStart, zhStart));
const zh = keysIn(src.slice(zhStart, stringsEnd));

const problems = [];

// 1. the two tables must define the same keys
for (const k of en) if (!zh.has(k)) problems.push(`zh is missing: ${k}`);
for (const k of zh) if (!en.has(k)) problems.push(`en is missing: ${k}`);

// 2. every statically-written t('key') must exist.
// Template-literal lookups (t(`role.${x}`)) can't be checked this way; those all
// have runtime fallbacks by design.
const jsxFiles = readdirSync(CLIENT_SRC).filter((f) => f.endsWith('.jsx') && f !== 'i18n.jsx');
for (const f of jsxFiles) {
  const code = readFileSync(path.join(CLIENT_SRC, f), 'utf8');
  for (const m of code.matchAll(/\bt\('([a-zA-Z][a-zA-Z0-9_.]*)'/g)) {
    if (!en.has(m[1])) problems.push(`${f} uses t('${m[1]}') but no table defines it`);
  }
}

// 3. every error code the server can emit needs text in both languages
const codes = new Set();
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    if (f === 'node_modules' || f === '.git') continue;
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!f.endsWith('.js') || f.endsWith('.test.js')) continue;
    const code = readFileSync(p, 'utf8');
    // A code may carry an argument after a colon ("auth.passwordTooShort:8"); only
    // the part before the colon is the table key. Template literals are matched too,
    // since that is how the argument gets interpolated in.
    const add = (raw) => codes.add(raw.split(':')[0].split('${')[0].replace(/[`']/g, ''));
    const DOMAINS = 'auth|room|game|wolf|kittens|draw|client';
    for (const m of code.matchAll(/error: '([^']+)'/g)) add(m[1]);
    for (const m of code.matchAll(/new Error\('([a-z][\w.]*)'\)/g)) add(m[1]);
    // Codes returned directly by a validation helper, as a plain string or a
    // template literal carrying an argument.
    for (const m of code.matchAll(new RegExp(`return ['\`](${DOMAINS})\\.[\\w.]+[^'\`]*['\`]`, 'g'))) {
      add(m[0].replace(/^return\s+/, ''));
    }
  }
};
walk(SERVER);
for (const c of [...codes].sort()) {
  if (!en.has(`err.${c}`)) problems.push(`en is missing err.${c} (server sends this code)`);
  if (!zh.has(`err.${c}`)) problems.push(`zh is missing err.${c} (server sends this code)`);
}
// An err.* entry no server code produces is usually a rename left behind.
// err.client.* is exempt: those are client-side failures, not server codes.
for (const k of en) {
  if (!k.startsWith('err.') || k.startsWith('err.client.')) continue;
  if (!codes.has(k.slice(4))) problems.push(`${k} has no matching server code (stale?)`);
}

if (problems.length) {
  for (const p of problems) console.error('  ' + p);
  console.error(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`en ${en.size} keys / zh ${zh.size} keys / ${codes.size} server error codes`);
console.log('i18n tables are consistent');
