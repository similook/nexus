#!/usr/bin/env node
/**
 * Detect drift between clients/shared and the Android sources it was copied from.
 *
 * =========================================================================================
 * WHY THIS EXISTS
 *
 * Phase 1 was required to leave clients/web byte-for-byte untouched, so the shared tree is a
 * COPY, not an extraction. clients/web still contains its own full copy of every view,
 * component and hook, and Capacitor still reaches straight into them.
 *
 * That is a deliberate trade — the shipped Android app cannot break if nothing in it changes —
 * and it has a well-known cost, which the repo has already paid once: CONTRIBUTING.md has a
 * section called "Kotlin sources are in two places", and keeping those in step is manual.
 *
 * This script is the thing that section lacks. It does not prevent drift. It makes drift
 * VISIBLE, which is the difference between a known cost and a silent one.
 *
 * WHAT IT ACTUALLY CHECKS
 *
 * manifest.json records, for every file copied out of clients/web, the SHA-256 of the source
 * at the moment it was copied. This script re-hashes the source today:
 *
 *   unchanged  the Android file is exactly as it was when copied. Nothing to do.
 *   CHANGED    the Android file has moved on since. Whatever changed there is probably also
 *              needed here — a parser fix, a protocol change, a UI bug. Port it.
 *   MISSING    the Android file is gone. The copy here is now an orphan.
 *
 * It deliberately does NOT compare the two files to each other. They are expected to differ:
 * the whole point of Phase 1 was rewriting the copies onto PlatformPort. Diffing them would
 * report every intentional change as a problem and train everyone to ignore the output.
 *
 * WHEN TO RUN IT
 *
 * Before starting work in clients/shared, and in any PR that touches either tree. A `CHANGED`
 * row is not a failure — it is a question: does that Android change belong here too?
 *
 * WHEN THIS SCRIPT SHOULD BE DELETED
 *
 * When clients/web imports from @nexus/shared instead of holding its own copy. Then there is
 * one source, drift is impossible, and this becomes dead weight. That is the end state; this
 * is scaffolding for the interval before it.
 * =========================================================================================
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';

const manifestPath = fileURLToPath(new URL('../manifest.json', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

const changed = [];
const missing = [];
let unchanged = 0;

for (const entry of manifest.files) {
  let content;
  try {
    content = await readFile(new URL(entry.source, `file:///${repoRoot.replaceAll('\\', '/')}`));
  } catch {
    missing.push(entry);
    continue;
  }

  if (sha256(content) === entry.sourceSha256) unchanged += 1;
  else changed.push(entry);
}

console.log(`\nclients/shared drift check — ${manifest.files.length} copied files`);
console.log(`copied at: ${manifest.copiedAt} (${manifest.note})\n`);

if (changed.length === 0 && missing.length === 0) {
  console.log(`  all ${unchanged} sources unchanged since the copy — nothing to port\n`);
  process.exit(0);
}

for (const entry of missing) {
  console.log(`  MISSING  ${entry.source}`);
  console.log(`           gone from the Android tree; ${entry.target} is now an orphan`);
}

for (const entry of changed) {
  console.log(`  CHANGED  ${entry.source}`);
  console.log(`           → review against ${entry.target}`);
}

console.log(`\n  ${unchanged} unchanged, ${changed.length} changed, ${missing.length} missing`);
console.log(
  '\n  A CHANGED row is a question, not a failure: does that Android change belong in the\n' +
    '  shared copy too? If yes, port it and re-record the hash with:\n' +
    '      node scripts/record-manifest.mjs\n',
);

// Exit non-zero so CI notices. Drift is not automatically wrong, but it must not pass silently.
process.exit(1);
