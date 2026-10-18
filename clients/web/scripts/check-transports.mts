/**
 * Transports the core cannot speak must fail the import, not become plain TCP.
 *
 *   npx tsx scripts/check-transports.mts
 *
 * What must hold: xhttp/splithttp, mKCP and unknown transports are refused with a reason, for
 * VLESS and VMess alike; `raw` (Xray's name for tcp) is tcp; plain V2Ray QUIC maps to sing-box's
 * quic transport and QUIC's packet encryption or header masquerades are refused; and the shapes
 * that already worked come out exactly as before.
 */
const { parseSingleConfig, SubscriptionError } = await import('../src/core/subscription');

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.log(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  }
}

const UUID = '11111111-2222-3333-4444-555555555555';
const PBK = 'jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0';
const REALITY = `security=reality&sni=www.microsoft.com&pbk=${PBK}&sid=ab&fp=chrome`;
const TLS = 'security=tls&sni=h.example.com';
const vlessLink = (query: string) => `vless://${UUID}@h.example.com:443?${query}#n`;
const vmessLink = (json: Record<string, unknown>) =>
  `vmess://${Buffer.from(JSON.stringify({ v: '2', ps: 'n', add: 'h.example.com', port: '443', id: UUID, aid: '0', ...json })).toString('base64')}`;

type Outbound = Record<string, unknown>;
const proxyOf = (uri: string) =>
  (JSON.parse(parseSingleConfig(uri).config) as { outbounds: Outbound[] }).outbounds.find((o) => o.tag === 'proxy')!;
const rejection = (uri: string) => {
  try {
    parseSingleConfig(uri);
    return null;
  } catch (e) {
    return e instanceof SubscriptionError ? e.message : `not a SubscriptionError: ${String(e)}`;
  }
};

// ---- refused, with the reason --------------------------------------------------------------
for (const [what, uri, mention] of [
  ['vless xhttp + reality', vlessLink(`${REALITY}&type=xhttp&path=%2Fx&mode=auto`), 'XHTTP'],
  ['vless splithttp + tls', vlessLink(`${TLS}&type=splithttp&path=%2Fx`), 'XHTTP'],
  ['vless kcp', vlessLink('type=kcp&headerType=none&seed=s'), 'mKCP'],
  ['vless mkcp', vlessLink('type=mkcp'), 'mKCP'],
  ['vless unknown transport', vlessLink(`${TLS}&type=meek`), 'meek'],
  ['vless quic with packet encryption', vlessLink(`${TLS}&type=quic&quicSecurity=aes-128-gcm&key=k`), 'quic'],
  ['vless quic with a header', vlessLink(`${TLS}&type=quic&headerType=srtp`), 'quic'],
  ['trojan xhttp', `trojan://pw@h.example.com:443?${TLS}&type=xhttp#n`, 'XHTTP'],
  ['vmess xhttp', vmessLink({ net: 'xhttp', tls: 'tls', path: '/x' }), 'XHTTP'],
  ['vmess kcp', vmessLink({ net: 'kcp', type: 'none' }), 'mKCP'],
  ['vmess quic with packet encryption', vmessLink({ net: 'quic', tls: 'tls', host: 'aes-128-gcm', path: 'k' }), 'quic'],
] as const) {
  const reason = rejection(uri);
  check(`refused: ${what}`, reason !== null && reason.includes(mention), reason);
}

// ---- raw is tcp ------------------------------------------------------------------------------
check('raw + reality == tcp + reality', parseSingleConfig(vlessLink(`${REALITY}&type=raw`)).config === parseSingleConfig(vlessLink(`${REALITY}&type=tcp`)).config);
check('raw + http header == tcp + http header', parseSingleConfig(vlessLink('type=raw&headerType=http&host=a.example.com&path=%2F')).config === parseSingleConfig(vlessLink('type=tcp&headerType=http&host=a.example.com&path=%2F')).config);
check('no type == tcp', parseSingleConfig(vlessLink(REALITY)).config === parseSingleConfig(vlessLink(`${REALITY}&type=tcp`)).config);

// ---- plain QUIC maps ---------------------------------------------------------------------------
check('vless quic -> quic transport', JSON.stringify(proxyOf(vlessLink(`${TLS}&type=quic`)).transport) === JSON.stringify({ type: 'quic' }));
check('vless quic, quicSecurity=none -> quic transport', JSON.stringify(proxyOf(vlessLink(`${TLS}&type=quic&quicSecurity=none&headerType=none`)).transport) === JSON.stringify({ type: 'quic' }));
check('vmess quic -> quic transport', JSON.stringify(proxyOf(vmessLink({ net: 'quic', tls: 'tls', host: 'none' })).transport) === JSON.stringify({ type: 'quic' }));

// ---- vmess: what worked is unchanged, what was silently TCP now maps -----------------------
check('vmess ws unchanged', JSON.stringify(proxyOf(vmessLink({ net: 'ws', path: '/v', host: 'c.example.com', tls: 'tls' })).transport) === JSON.stringify({ type: 'ws', path: '/v', headers: { Host: 'c.example.com' } }));
check('vmess grpc unchanged', JSON.stringify(proxyOf(vmessLink({ net: 'grpc', path: 'svc', tls: 'tls' })).transport) === JSON.stringify({ type: 'grpc', service_name: 'svc' }));
check('vmess plain tcp: no transport', !('transport' in proxyOf(vmessLink({ net: 'tcp', type: 'none' }))));
check('vmess tcp without type: no transport', !('transport' in proxyOf(vmessLink({ net: 'tcp' }))));
check('vmess tcp + http header -> http masquerade', JSON.stringify(proxyOf(vmessLink({ net: 'tcp', type: 'http', host: 'a.example.com', path: '/p' })).transport) === JSON.stringify({ type: 'http', method: 'GET', host: ['a.example.com'], path: '/p' }));
check('vmess h2 -> http transport', JSON.stringify(proxyOf(vmessLink({ net: 'h2', tls: 'tls', host: 'a.example.com', path: '/h' })).transport) === JSON.stringify({ type: 'http', host: ['a.example.com'], path: '/h' }));
check('vmess httpupgrade -> httpupgrade', JSON.stringify(proxyOf(vmessLink({ net: 'httpupgrade', host: 'a.example.com', path: '/u' })).transport) === JSON.stringify({ type: 'httpupgrade', path: '/u', host: 'a.example.com' }));

// ---- the shapes that already worked ----------------------------------------------------------
check('vless ws + tls unchanged', JSON.stringify(proxyOf(vlessLink(`${TLS}&type=ws&path=%2Fws&host=c.example.com`)).transport) === JSON.stringify({ type: 'ws', path: '/ws', headers: { Host: 'c.example.com' } }));
check('vless grpc + reality unchanged', JSON.stringify(proxyOf(vlessLink(`${REALITY}&type=grpc&serviceName=g`)).transport) === JSON.stringify({ type: 'grpc', service_name: 'g' }));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
