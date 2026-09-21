// Resize and convert the game art to WebP.
// Run from the client directory: npm run art
//
// The generated PNGs come out far larger than anything the UI shows: role cards
// are ~1700x2500 but render at 200x300, and covers are ~2750px wide but render
// around 390px. That was ~40MB of assets for a lobby that needs well under 2MB.
//
// Each image is resized to 2x its displayed size -- enough for retina screens,
// and past the point where more pixels are visible -- then encoded as WebP.
//
// Sources live in art-src/ and are committed; this script writes the served
// copies into client/public/games/. Re-run it after adding or replacing art.
import { readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

// This lives under client/ because that is where sharp is installed -- ESM resolves
// dependencies from the script's own location, not the working directory.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'art-src', 'games');
const OUT = path.join(ROOT, 'client', 'public', 'games');

// Displayed sizes come from the components:
//   cards  -> CARD_W/CARD_H in RoleReveal.jsx (200x300)
//   covers -> the lobby card, roughly 390px wide at 16:9
// Targets are 2x those. Height is left to sharp so the aspect ratio is kept.
const TARGETS = [
  { dir: 'cards', width: 400, quality: 82 },
  { dir: '.', width: 800, quality: 82 },
];

const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
let before = 0, after = 0;

for (const { dir, width, quality } of TARGETS) {
  const from = path.join(SRC, dir);
  const to = path.join(OUT, dir);
  if (!existsSync(from)) { console.log(`skip ${dir}: no source directory`); continue; }
  mkdirSync(to, { recursive: true });

  for (const f of readdirSync(from)) {
    if (!/\.(png|jpe?g)$/i.test(f)) continue;
    const srcPath = path.join(from, f);
    if (statSync(srcPath).isDirectory()) continue;

    const outName = f.replace(/\.(png|jpe?g)$/i, '.webp');
    const outPath = path.join(to, outName);

    const meta = await sharp(srcPath).metadata();
    // Never upscale: an image already smaller than the target is left at its size.
    const targetWidth = Math.min(width, meta.width);

    await sharp(srcPath)
      .resize({ width: targetWidth, withoutEnlargement: true })
      .webp({ quality })
      .toFile(outPath);

    const inSize = statSync(srcPath).size;
    const outSize = statSync(outPath).size;
    before += inSize; after += outSize;
    console.log(
      `${(dir === '.' ? '' : dir + '/') + outName}`.padEnd(30),
      `${meta.width}x${meta.height} -> ${targetWidth}px`.padEnd(22),
      `${mb(inSize)} -> ${mb(outSize)}`
    );
  }
}

console.log(`\ntotal ${mb(before)} -> ${mb(after)}  (${(100 - after / before * 100).toFixed(1)}% smaller)`);
