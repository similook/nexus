/**
 * Assertions on the REALITY `support-x25519mlkem768` link parameter, by exact equality.
 *
 * The flag is opt-in: only a REALITY link that says `support-x25519mlkem768=true` may produce
 * `tls.reality.support_x25519mlkem768`, and every other link must produce the reality block it
 * produced before the flag existed - same keys, nothing added. See core/patches/sing-box/.
 *
 *   npx tsx scripts/check-reality-mlkem.mts
 */
import { parseSingleConfig } from '../src/core/subscription';

const UUID = '11111111-2222-3333-4444-555555555555';
const PBK = 'jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0';
const REALITY = `security=reality&sni=www.microsoft.com&pbk=${PBK}&sid=ab&fp=chrome`;

const BEFORE = { enabled: true, public_key: PBK, short_id: 'ab' };
const OPTED_IN = { ...BEFORE, support_x25519mlkem768: true };

const CASES: Array<[name: string, uri: string, expected: Record<string, unknown> | null]> = [
  ['reality, no parameter: unchanged', `vless://${UUID}@example.com:443?${REALITY}&type=tcp#a`, BEFORE],
  ['reality, =true: opted in', `vless://${UUID}@example.com:443?${REALITY}&type=tcp&support-x25519mlkem768=true#a`, OPTED_IN],
  ['reality + vision, =true: opted in', `vless://${UUID}@example.com:443?${REALITY}&flow=xtls-rprx-vision&type=tcp&support-x25519mlkem768=true#a`, OPTED_IN],
  ['reality, =TRUE: opted in', `vless://${UUID}@example.com:443?${REALITY}&support-x25519mlkem768=TRUE#a`, OPTED_IN],
  ['reality, =false: unchanged', `vless://${UUID}@example.com:443?${REALITY}&support-x25519mlkem768=false#a`, BEFORE],
  ['reality, =1: unchanged (only "true" opts in)', `vless://${UUID}@example.com:443?${REALITY}&support-x25519mlkem768=1#a`, BEFORE],
  ['reality, empty value: unchanged', `vless://${UUID}@example.com:443?${REALITY}&support-x25519mlkem768=#a`, BEFORE],
  ['trojan reality, =true: opted in', `trojan://pw@example.com:443?${REALITY}&type=tcp&support-x25519mlkem768=true#a`, OPTED_IN],
  // Not REALITY: the parameter means nothing and must not leak into the config.
  ['tls, =true: ignored', `vless://${UUID}@example.com:443?security=tls&sni=example.com&support-x25519mlkem768=true#a`, null],
];

let failed = 0;
for (const [name, uri, expected] of CASES) {
  const config = parseSingleConfig(uri).config;
  const outbound = (JSON.parse(config) as { outbounds: Array<Record<string, unknown>> }).outbounds
    .find((o) => o.tag === 'proxy');
  const reality = (outbound?.tls as { reality?: Record<string, unknown> } | undefined)?.reality ?? null;

  const ok = JSON.stringify(reality) === JSON.stringify(expected) &&
    (expected?.support_x25519mlkem768 === true || !config.includes('mlkem'));

  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`         expected ${JSON.stringify(expected)}`);
    console.error(`         actual   ${JSON.stringify(reality)}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${CASES.length} failed`);
  process.exit(1);
}
console.log(`\nall ${CASES.length} passed`);
