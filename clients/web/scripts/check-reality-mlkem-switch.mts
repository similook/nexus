/**
 * The per-node REALITY ML-KEM switch (src/core/realityMlkem.ts), by exact equality.
 *
 *   npx tsx scripts/check-reality-mlkem-switch.mts
 *
 * What must hold: OFF - the default - is byte-for-byte the config the link alone produces; ON
 * adds tls.reality.support_x25519mlkem768 and nothing else, and is exactly the config a link
 * that opts in by itself produces; no other protocol can be switched or affected; the switch
 * follows the node through a subscription refresh the way 3x-ui serves one (list reordered,
 * remarks rewritten, SNI and short ID re-drawn at random), an edit and a reload; and the config
 * Connect and the Delay probe read changes with it. Plus the quota units of the subscription
 * panel, which must match the panel's own.
 */

// localStorage before anything that reads it.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const { parseSingleConfig, parseSubscription, rebuildNodeConfig } = await import('../src/core/subscription');
const {
  applyRealityMlkem,
  carryRealityMlkem,
  loadRealityMlkem,
  realityMlkemKey,
  realityMlkemState,
  rebuildWithRealityMlkem,
  saveRealityMlkem,
  withRealityMlkem,
} = await import('../src/core/realityMlkem');
const { applyEdit } = await import('../src/core/nodeDetails');
const { configFingerprint } = await import('../src/core/serverTests');
type ServerNode = import('../src/data/servers').ServerNode;

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

function proxyOf(node: ServerNode): Record<string, unknown> {
  const outbounds = (JSON.parse(node.config) as { outbounds: Array<Record<string, unknown>> }).outbounds;
  return outbounds.find((o) => o.tag === 'proxy') ?? {};
}
const realityOf = (node: ServerNode) =>
  (proxyOf(node).tls as { reality?: Record<string, unknown> } | undefined)?.reality ?? null;

const UUID = '11111111-2222-3333-4444-555555555555';
const UUID2 = '66666666-7777-8888-9999-000000000000';
const PBK = 'jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0';
const PBK2 = 'Q2BQyM4Hn3fK7WY9n8xXzM2kA0mV1L6p5w3dJcT4rEg';
const REALITY = `security=reality&sni=www.microsoft.com&pbk=${PBK}&sid=ab&fp=chrome&flow=xtls-rprx-vision&type=tcp`;
// The same node as 3x-ui serves it on the next fetch: another SNI and short ID from the
// inbound's lists, a new spiderX, a new remark.
const REDRAWN = `security=reality&sni=www.bing.com&pbk=${PBK}&sid=c0ffee12&spx=%2Fx7Qp&fp=chrome&flow=xtls-rprx-vision&type=tcp`;

const legacy = `vless://${UUID}@a.example.com:443?${REALITY}#legacy`;
const optedIn = `vless://${UUID}@a.example.com:443?${REALITY}&support-x25519mlkem768=true#legacy`;
const trojanReality = `trojan://pw@b.example.com:443?${REALITY}#tr`;
const NOT_REALITY: Array<[string, string]> = [
  ['vless tls', `vless://${UUID}@c.example.com:443?security=tls&sni=c.example.com&type=ws&path=%2Fws#t`],
  ['vless none', `vless://${UUID}@c.example.com:80?type=tcp#n`],
  ['trojan tls', `trojan://pw@c.example.com:443?security=tls&sni=c.example.com#tt`],
  ['vmess', `vmess://${Buffer.from(JSON.stringify({ v: '2', ps: 'vm', add: 'c.example.com', port: '443', id: UUID, aid: '0', net: 'ws', path: '/v', tls: 'tls', sni: 'c.example.com' })).toString('base64')}`],
  ['shadowsocks', `ss://${Buffer.from('aes-256-gcm:pw').toString('base64')}@c.example.com:8388#ss`],
  ['hysteria2', `hysteria2://pw@c.example.com:443?sni=c.example.com#hy`],
  ['tuic', `tuic://${UUID}:pw@c.example.com:443?sni=c.example.com&congestion_control=bbr#tu`],
];

const none = new Set<string>();

// ---- OFF is the config the link alone produces --------------------------------------------
for (const [name, uri] of [['vless reality', legacy], ['trojan reality', trojanReality], ...NOT_REALITY] as Array<[string, string]>) {
  const fresh = parseSingleConfig(uri);
  check(`${name}: OFF rebuild is byte-identical`, rebuildWithRealityMlkem(fresh, none).config === fresh.config);
  check(`${name}: OFF rebuild matches the plain rebuild`, rebuildWithRealityMlkem(fresh, none).config === rebuildNodeConfig(fresh).config);
  check(`${name}: OFF apply returns the same object`, applyRealityMlkem(fresh, none) === fresh);
  check(`${name}: OFF config never mentions mlkem`, !fresh.config.includes('mlkem'));
}

// ---- ON adds the one key, and equals a link that opts in by itself -------------------------
{
  const off = parseSingleConfig(legacy);
  check('legacy REALITY starts OFF', realityMlkemState(off, none) === 'off');
  const keys = withRealityMlkem(none, off, true);
  check('switch turns on for REALITY', keys !== null && keys.size === 1);
  const on = rebuildWithRealityMlkem(off, keys!);
  check('ON state', realityMlkemState(on, keys!) === 'on');
  check('ON sets support_x25519mlkem768', realityOf(on)?.support_x25519mlkem768 === true, realityOf(on));
  const { support_x25519mlkem768: _flag, ...rest } = realityOf(on)!;
  check('ON changes nothing else in reality', JSON.stringify(rest) === JSON.stringify(realityOf(off)));
  const stripped = JSON.parse(on.config) as { outbounds: Array<Record<string, unknown>> };
  delete ((stripped.outbounds.find((o) => o.tag === 'proxy')!.tls as { reality: Record<string, unknown> }).reality).support_x25519mlkem768;
  check('ON changes nothing else in the config', JSON.stringify(stripped) === JSON.stringify(JSON.parse(off.config)));
  check('ON equals the link that opts in by itself (the device-tested shape)', on.config === parseSingleConfig(optedIn).config);
  check('ON keeps the link as imported (share/QR unchanged)', on.uri === off.uri);
  check('ON keeps the node id (selection unchanged)', on.id === off.id);
  check('Delay fingerprint changes with the switch', configFingerprint(on.config) !== configFingerprint(off.config));

  const back = withRealityMlkem(keys!, on, false);
  check('switch turns back off', back !== null && back.size === 0);
  check('OFF again is byte-identical to before', rebuildWithRealityMlkem(on, back!).config === off.config);
  check('OFF again restores the Delay fingerprint', configFingerprint(rebuildWithRealityMlkem(on, back!).config) === configFingerprint(off.config));
}
{
  const tr = parseSingleConfig(trojanReality);
  const keys = withRealityMlkem(none, tr, true);
  check('trojan REALITY can be switched', keys !== null && realityOf(rebuildWithRealityMlkem(tr, keys!))?.support_x25519mlkem768 === true);
}

// ---- no other protocol -------------------------------------------------------------------
for (const [name, uri] of NOT_REALITY) {
  const node = parseSingleConfig(uri);
  check(`${name}: no switch`, realityMlkemState(node, none) === 'unsupported' && withRealityMlkem(none, node, true) === null);
  check(`${name}: has no key`, realityMlkemKey(uri) === null);
  // Even a full key set cannot reach it.
  const forced = new Set([realityMlkemKey(legacy)!, realityMlkemKey(trojanReality)!]);
  check(`${name}: a full key set changes nothing`, rebuildWithRealityMlkem(node, forced).config === node.config);
  check(`${name}: a forced key still reads unsupported`, realityMlkemState(node, forced) === 'unsupported');
}

// ---- a link that opts in by itself is left alone (the working imported node) ------------
{
  const linked = parseSingleConfig(optedIn);
  check('link opt-in reads "link"', realityMlkemState(linked, none) === 'link');
  check('link opt-in has no switch', withRealityMlkem(none, linked, false) === null && withRealityMlkem(none, linked, true) === null);
  const anyKeys = new Set([realityMlkemKey(optedIn)!, realityMlkemKey(legacy)!]);
  check('link opt-in config is unchanged under any key set', rebuildWithRealityMlkem(linked, anyKeys).config === linked.config);
  // Same server, user and key: one identity. The opt-in link still reads "link" under it.
  check('link opt-in shares the identity of its legacy link', realityMlkemKey(optedIn) === realityMlkemKey(legacy));
  check('link opt-in stays "link" when that identity is switched on', realityMlkemState(linked, new Set([realityMlkemKey(legacy)!])) === 'link');
}

// ---- subscription refresh: positions and remarks change, the link does not ---------------
{
  const other = `vless://${UUID}@d.example.com:443?${REALITY}#other`;
  const body1 = Buffer.from([legacy, trojanReality, other].join('\n')).toString('base64');
  const first = parseSubscription(body1, 'sub-x').nodes;
  const target = first[0];
  const keys = withRealityMlkem(none, target, true)!;

  // The next fetch, as 3x-ui serves it: reordered, remarks rewritten (traffic left, days left),
  // SNI and short ID drawn again at random, a new spiderX.
  const renamed = `vless://${UUID}@a.example.com:443?${REDRAWN}#legacy%20-%2012.3GB%20-%205D`;
  check('refresh: the link itself did change', renamed.split('#')[0] !== legacy.split('#')[0]);
  const body2 = [other, renamed, trojanReality].join('\n');
  const second = parseSubscription(body2, 'sub-x').nodes.map((n) => applyRealityMlkem(n, keys));
  const moved = second.find((n) => n.uri === renamed)!;
  check('refresh: the id moved with the position', moved.id !== target.id);
  check('refresh: the switch followed the link', realityOf(moved)?.support_x25519mlkem768 === true);
  check('refresh: the node now at the old position stays OFF', second.find((n) => n.id === target.id)?.config.includes('mlkem') === false);
  check('refresh: no other node switched', second.filter((n) => n.config.includes('mlkem')).length === 1);

  // A new UUID or a new key pair is a different node.
  const rotated = parseSingleConfig(legacy.replace(UUID, UUID2));
  check('a new UUID starts OFF', realityMlkemState(rotated, keys) === 'off' && applyRealityMlkem(rotated, keys) === rotated);
  const rekeyed = parseSingleConfig(legacy.replace(PBK, PBK2));
  check('a new public key starts OFF', realityMlkemState(rekeyed, keys) === 'off' && applyRealityMlkem(rekeyed, keys) === rekeyed);
}

// ---- edits --------------------------------------------------------------------------------
{
  const node = parseSingleConfig(legacy);
  const keys = withRealityMlkem(none, node, true)!;

  const renamed = applyEdit(node, { name: 'renamed', server: 'a.example.com', port: 443 });
  check('rename keeps the key without a carry', carryRealityMlkem(keys, node, renamed) === keys);
  check('rename: still ON', realityOf(applyRealityMlkem(renamed, keys))?.support_x25519mlkem768 === true);

  const moved = applyEdit(node, { name: 'legacy', server: 'e.example.com', port: 8443 });
  check('address/port edit: OFF without the carry', applyRealityMlkem(moved, keys) === moved);
  const carried = carryRealityMlkem(keys, node, moved);
  check('address/port edit: carried', realityOf(applyRealityMlkem(moved, carried))?.support_x25519mlkem768 === true);
  check('edit of an OFF node carries nothing', carryRealityMlkem(none, node, moved) === none);
}

// ---- persistence --------------------------------------------------------------------------
{
  const node = parseSingleConfig(legacy);
  const keys = withRealityMlkem(none, node, true)!;
  saveRealityMlkem(keys);
  const reloaded = loadRealityMlkem();
  check('saved set reloads', reloaded.size === 1 && reloaded.has(realityMlkemKey(legacy)!));
  // What a relaunch does: rebuild the stored node from its link with the stored set.
  const stored = JSON.parse(JSON.stringify(node)) as ServerNode;
  check('relaunch rebuild is ON', realityOf(rebuildWithRealityMlkem(stored, reloaded))?.support_x25519mlkem768 === true);
  const raw = store.get('nexus.realityMlkem.v2') ?? '';
  check('stored keys are hashes, not credentials', raw.length > 0 && !raw.includes('example.com') && !raw.includes(UUID) && !raw.includes(PBK));

  store.set('nexus.realityMlkem.v2', '{not json');
  check('corrupt storage reads as all OFF', loadRealityMlkem().size === 0);
  store.set('nexus.realityMlkem.v2', JSON.stringify([1, null, 'x']));
  check('non-string entries are dropped', loadRealityMlkem().size === 1);
  store.delete('nexus.realityMlkem.v2');
  check('no storage reads as all OFF', loadRealityMlkem().size === 0);
  store.set('nexus.realityMlkem.v1', JSON.stringify(['old']));
  check('v1 (whole-link) keys are not read', loadRealityMlkem().size === 0);
  store.delete('nexus.realityMlkem.v1');
}

// ---- keys: the node's complete generated outbound, minus SNI, short ID and the flag ---------
{
  // One REALITY link, built from parts so that each test changes exactly one of them.
  type Parts = { scheme: string; cred: string; host: string; port: string; params: Record<string, string>; remark: string };
  const BASE: Parts = {
    scheme: 'vless', cred: UUID, host: 'h.example.com', port: ':443', remark: 'n',
    params: { security: 'reality', sni: 'a.example.net', pbk: PBK, sid: 'ab', fp: 'chrome', type: 'tcp' },
  };
  const link = (change: Partial<Omit<Parts, 'params'>> & { params?: Record<string, string | null> } = {}) => {
    const p = { ...BASE, ...change, params: { ...BASE.params } as Record<string, string | null> };
    for (const [k, v] of Object.entries(change.params ?? {})) p.params[k] = v;
    const query = Object.entries(p.params).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join('&');
    return `${p.scheme}://${p.cred}@${p.host}${p.port}?${query}#${p.remark}`;
  };
  const key0 = realityMlkemKey(link());
  check('base link has a key', key0 !== null);

  // Randomized by the panel on every fetch, or never part of the config: same key.
  const SAME: Array<[string, string]> = [
    ['another SNI', link({ params: { sni: 'b.example.net' } })],
    ['no SNI (falls back to the address)', link({ params: { sni: null } })],
    ['another short ID', link({ params: { sid: 'c0ffee12' } })],
    ['no short ID', link({ params: { sid: null } })],
    ['another spiderX', link({ params: { spx: '/zz' } })],
    ['another remark', link({ remark: 'renamed' })],
    ['SNI, short ID, spiderX and remark all re-drawn', link({ params: { sni: 'c.example.net', sid: '07f3', spx: '/q' }, remark: 'x - 12.3GB' })],
    ['the link opting in by itself (the flag is not identity)', link({ params: { 'support-x25519mlkem768': 'true' } })],
    ['port given as 443 vs omitted (the parser defaults it)', link({ port: '' })],
  ];
  for (const [what, uri] of SAME) check(`same key: ${what}`, realityMlkemKey(uri) === key0);

  // Every other field the core is given: a different key.
  const DIFFERENT: Array<[string, string]> = [
    ['protocol (trojan)', link({ scheme: 'trojan', cred: 'pw' })],
    ['UUID', link({ cred: UUID2 })],
    ['address', link({ host: 'g.example.com' })],
    ['address case (not normalized)', link({ host: 'H.example.com' })],
    ['port', link({ port: ':8443' })],
    ['public key', link({ params: { pbk: PBK2 } })],
    ['fingerprint', link({ params: { fp: 'firefox' } })],
    ['flow', link({ params: { flow: 'xtls-rprx-vision' } })],
    ['transport: grpc', link({ params: { type: 'grpc', serviceName: 'svc' } })],
    ['transport: ws', link({ params: { type: 'ws', path: '/p' } })],
    ['ALPN', link({ params: { alpn: 'h2' } })],
    ['certificate check disabled', link({ params: { allowInsecure: '1' } })],
  ];
  for (const [what, uri] of DIFFERENT) {
    const k = realityMlkemKey(uri);
    check(`different key: ${what}`, k !== null && k !== key0, { hasKey: k !== null });
  }
  check('different key: ws path', realityMlkemKey(link({ params: { type: 'ws', path: '/a' } })) !== realityMlkemKey(link({ params: { type: 'ws', path: '/b' } })));
  check('different key: grpc service name', realityMlkemKey(link({ params: { type: 'grpc', serviceName: 'a' } })) !== realityMlkemKey(link({ params: { type: 'grpc', serviceName: 'b' } })));
  check('different key: trojan password', realityMlkemKey(link({ scheme: 'trojan', cred: 'pw1' })) !== realityMlkemKey(link({ scheme: 'trojan', cred: 'pw2' })));

  // Missing or invalid identity: no key, no switch, nothing to attach to.
  const NO_KEY: Array<[string, string]> = [
    ['VLESS without UUID', link({ cred: '' })],
    ['Trojan without password', link({ scheme: 'trojan', cred: '' })],
    ['no public key', link({ params: { pbk: null } })],
    ['empty public key', link({ params: { pbk: '' } })],
    ['public key too short', link({ params: { pbk: PBK.slice(0, 42) } })],
    ['public key too long', link({ params: { pbk: `${PBK}A` } })],
    ['public key in standard base64 (+ and /)', link({ params: { pbk: `${PBK.slice(0, 41)}+/` } })],
    ['no address', link({ host: '' })],
    ['port out of range', link({ port: ':70000' })],
    ['not a link at all', 'definitely not a link'],
  ];
  for (const [what, uri] of NO_KEY) {
    check(`no key: ${what}`, realityMlkemKey(uri) === null);
    let node: ServerNode | null = null;
    try { node = parseSingleConfig(uri); } catch { /* unparseable: nothing to switch */ }
    if (node !== null) {
      check(`no switch: ${what}`, realityMlkemState(node, new Set([key0!])) === 'unsupported' && withRealityMlkem(new Set(), node, true) === null);
      check(`config untouched under any keys: ${what}`, rebuildWithRealityMlkem(node, new Set([key0!])).config === node.config);
    }
  }
  // The failure the earlier identity had: two credential-less links shared one key.
  check('two links without UUID do not share a key', realityMlkemKey(link({ cred: '' })) === null && realityMlkemKey(link({ cred: '', params: { sid: 'cd' } })) === null);

  // Two distinct nodes on one server: each switch is its own.
  const PAIRS: Array<[string, string, string]> = [
    ['same server and port, two users', link(), link({ cred: UUID2 })],
    ['same server, two ports', link(), link({ port: ':8443' })],
    ['same server, port and user, two flows', link(), link({ params: { flow: 'xtls-rprx-vision' } })],
    ['same server, port and user, two key pairs', link(), link({ params: { pbk: PBK2 } })],
  ];
  for (const [what, a, b] of PAIRS) {
    const nodeA = parseSingleConfig(a);
    const nodeB = parseSingleConfig(b);
    const keys = withRealityMlkem(new Set(), nodeA, true)!;
    check(`${what}: A on`, realityMlkemState(nodeA, keys) === 'on');
    check(`${what}: B stays off`, realityMlkemState(nodeB, keys) === 'off');
    check(`${what}: B's config untouched`, rebuildWithRealityMlkem(nodeB, keys).config === nodeB.config);
  }
}

// Whitespace around a pasted link is not part of it.
check('key ignores surrounding whitespace', realityMlkemKey(` ${legacy}\n`) === realityMlkemKey(legacy));

// ---- quota units (the subscription panel) ------------------------------------------------
{
  const { formatQuota, formatTotal } = await import('../src/core/format');
  const GIB = 1024 ** 3;
  check('a 50 GB plan reads 50.0 GB, as on the panel', formatQuota(50 * GIB) === '50.0 GB', formatQuota(50 * GIB));
  check('12.5 GB used', formatQuota(12.5 * GIB) === '12.5 GB');
  check('512 MB', formatQuota(512 * 1024 ** 2) === '512 MB');
  check('300 KB', formatQuota(300 * 1024) === '300 KB');
  check('nothing used', formatQuota(0) === '0 KB');
  check('live traffic totals unchanged (decimal)', formatTotal(50 * GIB) === '53.7 GB' && formatTotal(1_400_000_000) === '1.4 GB');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
