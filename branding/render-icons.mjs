import sharp from 'sharp';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RES = process.argv[2];
if (!RES) throw new Error('usage: node render.mjs <res-dir>');

const full = readFileSync('full.svg');
const fg = readFileSync('foreground.svg');

// Legacy launcher icon: 48dp base. Adaptive foreground: 108dp canvas at the same densities.
const DENSITIES = [
  ['mdpi', 1],
  ['hdpi', 1.5],
  ['xhdpi', 2],
  ['xxhdpi', 3],
  ['xxxhdpi', 4],
];

/** Circular mask, for ic_launcher_round on launchers that ask for it. */
const roundMask = (size) =>
  Buffer.from(
    `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`,
  );

for (const [density, scale] of DENSITIES) {
  const dir = join(RES, `mipmap-${density}`);
  mkdirSync(dir, { recursive: true });

  const legacy = Math.round(48 * scale);
  const adaptive = Math.round(108 * scale);

  // The source squircle is inset 24/512 on each side; rendering the whole 512 box keeps that
  // padding, which is what the legacy icon wants (it is its own shape, unmasked).
  await sharp(full, { density: 600 }).resize(legacy, legacy).png().toFile(join(dir, 'ic_launcher.png'));

  const square = await sharp(full, { density: 600 }).resize(legacy, legacy).png().toBuffer();
  await sharp(square)
    .composite([{ input: roundMask(legacy), blend: 'dest-in' }])
    .png()
    .toFile(join(dir, 'ic_launcher_round.png'));

  await sharp(fg, { density: 600 })
    .resize(adaptive, adaptive)
    .png()
    .toFile(join(dir, 'ic_launcher_foreground.png'));

  console.log(`${density.padEnd(8)} legacy ${legacy}px  adaptive ${adaptive}px`);
}

// Play Store listing icon.
await sharp(full, { density: 600 }).resize(512, 512).png().toFile('play-store-icon-512.png');
console.log('play-store-icon-512.png');

// A big preview so the result can actually be looked at before it ships.
await sharp(full, { density: 600 }).resize(384, 384).png().toFile('preview-full.png');
await sharp(fg, { density: 600 }).resize(384, 384).flatten({ background: '#080E1D' }).png().toFile('preview-foreground.png');
writeFileSync('preview.txt', 'rendered\n');
console.log('previews written');
