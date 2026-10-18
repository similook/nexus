/**
 * VLESS Encryption links (`encryption=mlkem768x25519plus…`) and the fakeip table, by exact
 * equality.
 *
 *   npx tsx scripts/check-vless-encryption.mts
 *
 * What must hold: a supported encryption reaches the outbound unchanged; "none", empty or absent
 * produces exactly the config it always did; anything else fails the import with a reason rather
 * than producing a plain VLESS the server drops; Vision survives on top of the encryption; and
 * every generated config keeps its fakeip table across restarts.
 */
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const { parseSingleConfig, SubscriptionError } = await import('../src/core/subscription');
const { realityMlkemKey } = await import('../src/core/realityMlkem');

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
const MLKEM = 'A'.repeat(1579); // 1184 bytes, unpadded base64url
const REALITY = `security=reality&sni=www.microsoft.com&pbk=${PBK}&sid=ab&fp=chrome&type=tcp`;
const ENC = `mlkem768x25519plus.native.0rtt.${PBK}`;

type Outbound = Record<string, unknown>;
const generated = (uri: string) => JSON.parse(parseSingleConfig(uri).config) as { outbounds: Outbound[]; experimental?: unknown };
const proxyOf = (uri: string) => generated(uri).outbounds.find((o) => o.tag === 'proxy')!;
const rejects = (uri: string) => {
  try {
    parseSingleConfig(uri);
    return null;
  } catch (e) {
    return e instanceof SubscriptionError ? e.message : `not a SubscriptionError: ${String(e)}`;
  }
};

const plain = `vless://${UUID}@h.example.com:443?${REALITY}#n`;
const withEnc = (value: string, extra = '') => `vless://${UUID}@h.example.com:443?${REALITY}${extra}&encryption=${encodeURIComponent(value)}#n`;

// ---- carried exactly ---------------------------------------------------------------------
for (const value of [
  ENC,
  `mlkem768x25519plus.native.1rtt.${PBK}`,
  `mlkem768x25519plus.xorpub.0rtt.${PBK}`,
  `mlkem768x25519plus.random.1rtt.${PBK}`,
  `mlkem768x25519plus.native.0rtt.${MLKEM}`,
  `mlkem768x25519plus.native.0rtt.${PBK}.${MLKEM}`,
  `mlkem768x25519plus.random.0rtt.100-111-1111.75-0-111.50-0-3333.${PBK}`,
]) {
  const proxy = proxyOf(withEnc(value));
  check(`carried: ${value.slice(0, 34)}… (${value.length})`, proxy.encryption === value, proxy.encryption);
  check(`REALITY untouched beside it: ${value.slice(19, 34)}`, JSON.stringify(proxy.tls) === JSON.stringify(proxyOf(plain).tls));
}

// ---- off: byte-identical to before -------------------------------------------------------
check('encryption=none: config identical to no parameter', parseSingleConfig(withEnc('none')).config === parseSingleConfig(plain).config);
check('encryption= (empty): config identical', parseSingleConfig(`vless://${UUID}@h.example.com:443?${REALITY}&encryption=#n`).config === parseSingleConfig(plain).config);
check('absent: no encryption field', !('encryption' in proxyOf(plain)));
check('no encryption field for none', !('encryption' in proxyOf(withEnc('none'))));

// ---- unknown: the import fails, with the reason ------------------------------------------
for (const [what, value] of [
  ['other scheme', 'aes-128-gcm'],
  ['auto', 'auto'],
  ['unknown mode', `mlkem768x25519plus.plain.0rtt.${PBK}`],
  ['unknown handshake', `mlkem768x25519plus.native.2rtt.${PBK}`],
  ['no key', 'mlkem768x25519plus.native.0rtt.100-111-1111'],
  ['key of the wrong size', `mlkem768x25519plus.native.0rtt.${PBK}AA`],
  ['key with padding characters', `mlkem768x25519plus.native.0rtt.${PBK.slice(0, 42)}=`],
  ['truncated', 'mlkem768x25519plus.native'],
] as const) {
  const reason = rejects(withEnc(value));
  check(`rejected: ${what}`, reason !== null && reason.includes('VLESS encryption'), reason);
}

// ---- Vision on top of the encryption -----------------------------------------------------
const visionRaw = `vless://${UUID}@h.example.com:443?type=tcp&flow=xtls-rprx-vision&encryption=${ENC}#n`;
check('flow kept with encryption and no TLS', proxyOf(visionRaw).flow === 'xtls-rprx-vision', proxyOf(visionRaw));
check('flow still dropped without TLS or encryption', !('flow' in proxyOf(`vless://${UUID}@h.example.com:443?type=tcp&flow=xtls-rprx-vision#n`)));
check('flow kept with REALITY and encryption', proxyOf(withEnc(ENC, '&flow=xtls-rprx-vision')).flow === 'xtls-rprx-vision');

// ---- the ML-KEM switch tells them apart --------------------------------------------------
check('switch key differs with and without encryption', realityMlkemKey(withEnc(ENC)) !== null && realityMlkemKey(withEnc(ENC)) !== realityMlkemKey(plain));

// ---- fakeip table persists ---------------------------------------------------------------
for (const uri of [plain, withEnc(ENC), `vless://${UUID}@h.example.com:443?security=tls&sni=h.example.com&type=ws&path=%2F#n`]) {
  const experimental = generated(uri).experimental;
  check(`store_fakeip on: ${uri.split('?')[1].slice(0, 20)}`, JSON.stringify(experimental) === JSON.stringify({ cache_file: { enabled: true, store_fakeip: true } }), experimental);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
