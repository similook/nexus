/**
 * Assertions on desktop routing (src/core/routing.ts), and the fixture the Go tests run.
 *
 *   npx --yes tsx scripts/check-routing.mts
 *
 * The fixture is the point of the second half. core/desktop/tunnel's routing test starts a
 * real sing-box on the EXACT rules this composer produces — only the TUN inbound, the two
 * outbounds and the local DNS server are swapped for loopback test doubles — so a rule that
 * sing-box reads differently from how it is written here fails in Go, deterministically, with
 * no tunnel and no network.
 *
 * Test data only: a documentation address (RFC 5737), a zero UUID and a made-up key.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// localStorage for Node, so the persistence half runs as it does in the webview.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
};

const { composeRouting, loadRoutingMode, saveRoutingMode, isRoutingMode, ROUTING_MODES, ROUTING_MODE_HELP } =
  await import('../src/core/routing');
const { parseSingleConfig } = await import('../src/core/subscription');

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---- modes ----------------------------------------------------------------------------
console.log('modes');
check('exactly two modes, VPN and Direct', same(ROUTING_MODES, ['VPN', 'Direct']));
check('VPN explains itself', ROUTING_MODE_HELP.VPN === 'All traffic uses the VPN.');
check('Direct explains itself', ROUTING_MODE_HELP.Direct === 'All traffic uses your normal internet connection.');
for (const old of ['Global', 'Whitelist', 'Blacklist', 'vpn', 'Rule', '', null, 42]) {
  check(`${JSON.stringify(old)} is not a routing mode`, !isRoutingMode(old));
}

// ---- persistence ----------------------------------------------------------------------
console.log('persistence');
check('first install: VPN', loadRoutingMode() === 'VPN');
saveRoutingMode('Direct');
check('a saved choice survives a reload', loadRoutingMode() === 'Direct');
saveRoutingMode('VPN');
check('and changes back', loadRoutingMode() === 'VPN');
store.set('nexus.routing.v2', JSON.stringify({ mode: 'Sideways' }));
check('an unknown stored mode reads as VPN', loadRoutingMode() === 'VPN');
store.set('nexus.routing.v2', '{broken');
check('malformed storage reads as VPN', loadRoutingMode() === 'VPN');
store.clear();
store.set('nexus.routing.v1', JSON.stringify({ mode: 'Blacklist', whitelist: ['a.test'], blacklist: ['b.test'] }));
check('the unreleased v1 data is ignored, not reinterpreted', loadRoutingMode() === 'VPN');
store.clear();

// ---- composition ----------------------------------------------------------------------
console.log('composition');
const PLACEHOLDER_KEY = Buffer.alloc(32, 7).toString('base64url');
const node = parseSingleConfig(
  `vless://00000000-0000-4000-8000-000000000000@192.0.2.10:443?security=reality&sni=www.example.com` +
    `&pbk=${PLACEHOLDER_KEY}&sid=ab&fp=chrome&flow=xtls-rprx-vision&type=tcp#Routing-Fixture`,
);
const original = JSON.parse(node.config);

type Rule = Record<string, unknown>;
const MODE_RULES: Rule[] = [
  { clash_mode: 'Direct', action: 'route', outbound: 'direct' },
  { clash_mode: 'VPN', ip_is_private: true, action: 'route', outbound: 'direct' },
  { clash_mode: 'VPN', action: 'route', outbound: 'proxy' },
];

for (const mode of ROUTING_MODES) {
  const composed = JSON.parse(composeRouting(node.config, mode));
  check(`${mode}: the node's rules come first, unchanged`, same(composed.route.rules.slice(0, original.route.rules.length), original.route.rules));
  check(`${mode}: both modes are compiled in, so a switch needs no reconnect`, same(composed.route.rules.slice(original.route.rules.length), MODE_RULES), JSON.stringify(composed.route.rules));
  check(`${mode}: starts in the chosen mode`, composed.experimental.clash_api.default_mode === mode);
}

const g = JSON.parse(composeRouting(node.config, 'VPN'));
check('route.final is still the proxy', g.route.final === 'proxy');
check('no clash API listener is added', g.experimental.clash_api.external_controller === undefined);
check('the node DNS servers are kept, dns-local is added', same(g.dns.servers.slice(0, -1), original.dns.servers) && same(g.dns.servers.at(-1), { type: 'local', tag: 'dns-local' }));
check('direct resolves through dns-local', same(g.outbounds.find((o: Rule) => o.tag === 'direct').domain_resolver, { server: 'dns-local', strategy: 'prefer_ipv4' }));
check('the proxy outbound and the TUN inbound are untouched', same(g.outbounds[0], original.outbounds[0]) && same(g.inbounds, original.inbounds));
check('fakeip and the DNS final are untouched', same(g.dns.servers[0], original.dns.servers[0]) && g.dns.final === original.dns.final);
check(
  'DNS: the node rules first (address lookups keep their fake IP), then one Direct-only rule',
  same(g.dns.rules, [...original.dns.rules, { clash_mode: 'Direct', server: 'dns-local' }]),
  JSON.stringify(g.dns.rules),
);
check('DNS: no rule changes what VPN mode resolves', !g.dns.rules.some((r: Rule) => r.clash_mode === 'VPN'));

const once = composeRouting(node.config, 'Direct');
check('composing a composed config changes nothing', composeRouting(once, 'Direct') === once);
check('recomposing switches only the starting mode', JSON.parse(composeRouting(once, 'VPN')).experimental.clash_api.default_mode === 'VPN');

let threw = false;
try {
  composeRouting(JSON.stringify({ ...original, outbounds: [original.outbounds[0]] }), 'VPN');
} catch {
  threw = true;
}
check('a config without a direct outbound is refused', threw);

// ---- the Go fixture -------------------------------------------------------------------
const FIXTURE = fileURLToPath(new URL('../../../core/testdata/desktop/routing.json', import.meta.url));
writeFileSync(FIXTURE, `${JSON.stringify(JSON.parse(composeRouting(node.config, 'VPN')), null, 2)}\n`);
console.log(`\nwrote ${FIXTURE}`);

if (failed > 0) {
  console.log(`\n${failed} routing check(s) FAILED`);
  process.exit(1);
}
console.log('\nall routing checks passed');
