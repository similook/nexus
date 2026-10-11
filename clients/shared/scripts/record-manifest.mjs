#!/usr/bin/env node
/**
 * (Re)record manifest.json — the source hashes check-drift.mjs compares against.
 *
 * Run this after porting an Android change into clients/shared, to say "this copy is now in
 * step with that source again". Running it WITHOUT porting the change just silences the
 * warning, which is the one way to make this whole mechanism useless.
 *
 * The file list is derived from what actually exists in both trees, so a file added to
 * clients/shared with no Android counterpart (platform.ts, index.ts) is correctly left out.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { join, relative, sep } from 'node:path';

const sharedSrc = fileURLToPath(new URL('../src', import.meta.url));
const webSrc = fileURLToPath(new URL('../../web/src', import.meta.url));
const manifestPath = fileURLToPath(new URL('../manifest.json', import.meta.url));

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = [];
for (const full of walk(sharedSrc).sort()) {
  const rel = relative(sharedSrc, full).split(sep).join('/');
  const source = join(webSrc, rel);
  if (!existsSync(source)) continue; // shared-only file (platform.ts, index.ts)

  files.push({
    target: `clients/shared/src/${rel}`,
    source: `clients/web/src/${rel}`,
    sourceSha256: createHash('sha256').update(await readFile(source)).digest('hex'),
  });
}

const manifest = {
  note: 'ADR-0003 Phase 1. clients/web must not be modified, so these are copies.',
  copiedAt: process.env.NEXUS_MANIFEST_DATE ?? new Date().toISOString().slice(0, 10),
  files,
};

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`recorded ${files.length} source hashes → clients/shared/manifest.json`);
