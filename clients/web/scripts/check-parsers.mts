/**
 * Assertions on the URI scanner, checked by exact string equality.
 *
 * WHY EXACT STRINGS AND NOT COUNTS
 *
 * A count-only check passed while every extracted URI was silently truncated: the character
 * class in a `new RegExp(`…`)` had its backslashes eaten by the template literal, so `\s`
 * became the letter `s` and each URI was cut at its first "s". Three URIs were found, three
 * were expected, and all three were corrupt. Only comparing the whole string catches that.
 *
 *   npx tsx scripts/check-parsers.mts
 */
import { extractConfigUris } from '../src/core/subscription';

const U = '11111111-2222-3333-4444-555555555555';
const VMESS_B64 = Buffer.from(
  JSON.stringify({ v: '2', ps: 'FR', add: 'fr.example.com', port: '443', id: U, net: 'ws', tls: 'tls' }),
).toString('base64');

const A = `vless://${U}@a.example.com:443?type=ws#Name1`;
const B = `vmess://${VMESS_B64}`;
const C = 'trojan://pw@c.example.com:443#Name3';
const H2 = 'hysteria2://pw@h.example.com:443?sni=a.com#HY2';
const HY = 'hy2://pw@i.example.com:443#Short';
const SS = 'ss://YWVzLTI1Ni1nY206cHc=@d.example.com:8388#SS';

const CASES: Array<[name: string, input: string, expected: string[]]> = [
  // The point of the exercise: zero whitespace between links.
  ['glued: vless + vmess + trojan', `${A}${B}${C}`, [A, B, C]],
  // hysteria2 must win over hysteria, and hy2 must not be swallowed.
  ['glued: hysteria2 + hy2', `${H2}${HY}`, [H2, HY]],
  // vless:// and vmess:// both END IN "ss://" - the scanner must not split inside them.
  ['single vless is not split', A, [A]],
  ['single vmess is not split', B, [B]],
  ['glued: vless + ss', `${A}${SS}`, [A, SS]],
  // Ordinary shapes must keep working.
  ['newline separated', `${A}\n${C}`, [A, C]],
  ['space separated', `${A} ${C}`, [A, C]],
  ['prose around links', `سرورها:\n${A}\nعضو شوید: https://t.me/x`, [A]],
  ['trailing prose punctuation', `use ${C}, it is fast`, [C]],
  ['duplicates collapse', `${A}\n${A}`, [A]],
  // A subscription URL must never be mined for a config fragment.
  ['subscription url', 'https://example.com/sub?token=abc', []],
  ['prose only', 'سلام خوبی؟', []],
  // A bare base64 body is a subscription paste with no visible scheme.
  ['base64 body', Buffer.from(`${A}\n${C}`).toString('base64'), [A, C]],
];

let failed = 0;
for (const [name, input, expected] of CASES) {
  const actual = extractConfigUris(input);
  const ok =
    actual.length === expected.length && actual.every((uri, i) => uri === expected[i]);

  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`         expected ${expected.length}: ${JSON.stringify(expected, null, 0)}`);
    console.error(`         actual   ${actual.length}: ${JSON.stringify(actual, null, 0)}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${CASES.length} parser checks failed.`);
  process.exit(1);
}
console.log(`\nall ${CASES.length} parser checks passed`);
