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
import { classifyImport, extractConfigUris, parseSubscription, type ImportKind } from '../src/core/subscription';
import { endpointOf } from '../src/data/servers';

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

// ---------------------------------------------------------------------------------------
// classifyImport: what the Add box and the QR scanner do with a paste / scanned text.
// ---------------------------------------------------------------------------------------
const SUB = 'https://panel.example.com/sub/abcDEF123?token=xyz';
const enc = encodeURIComponent;
const b64 = (s: string) => Buffer.from(s).toString('base64');
const b64url = (s: string) => b64(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sub = (url: string, insecure = false): ImportKind => ({ kind: 'subscription', url, insecure });

const IMPORT_CASES: Array<[name: string, input: string, expected: ImportKind]> = [
  // Unchanged behaviour.
  ['bare https subscription', SUB, sub(SUB)],
  ['bare http subscription is flagged insecure', 'http://panel.example.com/sub', sub('http://panel.example.com/sub', true)],
  ['whitespace around a bare url', `\n  ${SUB}  \n`, sub(SUB)],
  ['proxy scheme inside the query stays a subscription', 'https://p.example.com/s?x=vless://foo', sub('https://p.example.com/s?x=vless://foo')],
  ['single config', A, { kind: 'configs', uris: [A] }],
  ['configs next to a t.me link stay configs', `سرورها:\n${A}\nعضو شوید: https://t.me/x`, { kind: 'configs', uris: [A] }],
  ['base64 body stays configs', b64(`${A}\n${C}`), { kind: 'configs', uris: [A, C] }],
  ['empty', '   ', { kind: 'empty' }],
  ['prose only', 'hello world', { kind: 'unknown' }],
  // New: a subscription URL inside other text.
  ['url inside prose', `Your subscription:\n${SUB}\nThanks`, sub(SUB)],
  ['url inside persian prose', `لینک اشتراک شما: ${SUB}`, sub(SUB)],
  ['trailing prose punctuation', `link: ${SUB}.`, sub(SUB)],
  ['fragment with a space is cut at the space', 'https://panel.example.com/sub/abc#My Sub', sub('https://panel.example.com/sub/abc#My')],
  ['two urls are ambiguous', `${SUB} and https://other.example.com/sub`, { kind: 'unknown' }],
  // New: subscription links wrapped in other clients' import schemes.
  ['sub:// base64', `sub://${b64(SUB)}#Remark`, sub(SUB)],
  ['sub:// base64url without padding', `sub://${b64url(SUB)}`, sub(SUB)],
  ['sing-box import-remote-profile', `sing-box://import-remote-profile?url=${enc(SUB)}#My%20Sub`, sub(SUB)],
  ['clash install-config', `clash://install-config?url=${enc(SUB)}`, sub(SUB)],
  ['clashmeta install-config with name', `clashmeta://install-config?url=${enc(SUB)}&name=x`, sub(SUB)],
  ['v2rayng install-sub', `v2rayng://install-sub?url=${enc(SUB)}`, sub(SUB)],
  ['hiddify import raw url', `hiddify://import/${SUB}#Name`, sub(SUB)],
  ['hiddify import encoded url', `hiddify://import/${enc(SUB)}`, sub(SUB)],
  // Security: a wrapper may only ever yield http(s).
  ['sub:// carrying file: is rejected', `sub://${b64('file:///etc/hosts')}`, { kind: 'unknown' }],
  ['sing-box carrying file: is rejected', `sing-box://import-remote-profile?url=${enc('file:///x')}`, { kind: 'unknown' }],
  ['sing-box carrying javascript: is rejected', `sing-box://import-remote-profile?url=${enc('javascript:alert(1)')}`, { kind: 'unknown' }],
  ['unknown wrapper is not unwrapped', `foo://install-config?url=${enc(SUB)}`, { kind: 'unknown' }],
  ['ftp is not a subscription', 'ftp://panel.example.com/sub', { kind: 'unknown' }],
];

for (const [name, input, expected] of IMPORT_CASES) {
  const actual = classifyImport(input);
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ok   import: ${name}`);
  } else {
    failed++;
    console.error(`  FAIL import: ${name}`);
    console.error(`         expected ${JSON.stringify(expected)}`);
    console.error(`         actual   ${JSON.stringify(actual)}`);
  }
}

// A subscription body with several configs imports every one, each against its own endpoint.
{
  const { nodes, failures } = parseSubscription(b64(`${A}\n${C}\n${H2}`), 'sub-test');
  const got = nodes.map((n) => [n.id, endpointOf(n)?.server, endpointOf(n)?.port]);
  const want = [
    ['sub-test-0', 'a.example.com', 443],
    ['sub-test-1', 'c.example.com', 443],
    ['sub-test-2', 'h.example.com', 443],
  ];
  if (failures.length === 0 && JSON.stringify(got) === JSON.stringify(want)) {
    console.log('  ok   import: multi-config subscription body -> 3 nodes, own endpoints');
  } else {
    failed++;
    console.error('  FAIL import: multi-config subscription body');
    console.error(`         expected ${JSON.stringify(want)}`);
    console.error(`         actual   ${JSON.stringify(got)} failures=${failures.length}`);
  }
}

const total = CASES.length + IMPORT_CASES.length + 1;
if (failed > 0) {
  console.error(`\n${failed} of ${total} parser checks failed.`);
  process.exit(1);
}
console.log(`\nall ${total} parser checks passed`);
