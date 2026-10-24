/**
 * The user's server order (src/core/nodeOrder.ts): the key a position is stored under, and how a
 * stored order applies to a list a refresh changed.
 *   npx tsx scripts/check-node-order.mts
 */
// localStorage before anything that reads it.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const { parseSingleConfig, rebuildNodeConfig } = await import('../src/core/subscription');
const order = await import('../src/core/nodeOrder');

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  }
}

const UUID = '11111111-2222-3333-4444-555555555555';
const PBK = 'Z84J2IelR9ch3k8VtlVhhs5ycBUlXA7wHBWcBLM8yhk';
const reality = (sni: string, sid: string) =>
  `security=reality&sni=${sni}&pbk=${PBK}&sid=${sid}&fp=chrome&flow=xtls-rprx-vision&type=tcp`;

// --- 1. The key ---------------------------------------------------------------------------------
{
  const a = parseSingleConfig(`vless://${UUID}@a.example.com:443?${reality('www.microsoft.com', 'ab')}#node A - 3.2 GB left`);
  // What a 3x-ui refresh does to the same server: another SNI and short ID from the inbound's
  // lists, and a remark with new traffic figures.
  const refreshed = parseSingleConfig(`vless://${UUID}@a.example.com:443?${reality('www.apple.com', 'cd')}#node A - 3.1 GB left`);
  check('a refresh (SNI, short id, remark) keeps the key', order.nodeOrderKey(a) === order.nodeOrderKey(refreshed));
  check('the ML-KEM switch keeps the key', order.nodeOrderKey(a) === order.nodeOrderKey(rebuildNodeConfig(a, true)));
  const otherHost = parseSingleConfig(`vless://${UUID}@b.example.com:443?${reality('www.microsoft.com', 'ab')}#node A`);
  const otherPort = parseSingleConfig(`vless://${UUID}@a.example.com:8443?${reality('www.microsoft.com', 'ab')}#node A`);
  const otherUser = parseSingleConfig(`vless://22222222-2222-3333-4444-555555555555@a.example.com:443?${reality('www.microsoft.com', 'ab')}#node A`);
  check('another address is another server', order.nodeOrderKey(a) !== order.nodeOrderKey(otherHost));
  check('another port is another server', order.nodeOrderKey(a) !== order.nodeOrderKey(otherPort));
  check('another credential is another server', order.nodeOrderKey(a) !== order.nodeOrderKey(otherUser));
  const tls = parseSingleConfig(`vless://${UUID}@c.example.com:443?security=tls&sni=c.example.com&type=ws&path=%2Fws#tls one`);
  const tlsRenamed = parseSingleConfig(`vless://${UUID}@c.example.com:443?security=tls&sni=c.example.com&type=ws&path=%2Fws#tls renamed`);
  check('not REALITY: a new remark keeps the key', order.nodeOrderKey(tls) === order.nodeOrderKey(tlsRenamed));
  const broken = { ...a, id: 'x1', config: 'not json' };
  check('an unreadable config falls back to the id', order.nodeOrderKey(broken) === 'id:x1');
}

// --- 2. Keys within a list --------------------------------------------------------------------
const n = (host: string, name = host) =>
  parseSingleConfig(`vless://${UUID}@${host}:443?security=tls&sni=${host}&type=ws&path=%2Fws#${name}`);
const [a, b, c, d] = [n('a.example.com'), n('b.example.com'), n('c.example.com'), n('d.example.com')];
{
  const twice = order.keyedNodes([a, b, n('a.example.com', 'a again')]);
  check('a server listed twice: unique keys', new Set(twice.map((k) => k.key)).size === 3);
  check('...the second copy gets "~2"', twice[2].key === `${twice[0].key}~2`);
}

// --- 3. Applying a stored order ---------------------------------------------------------------
{
  const keyOf = (node: typeof a) => order.nodeOrderKey(node);
  const names = (list: Array<{ node: typeof a }>) => list.map((k) => k.node.name).join(',');
  check('no stored order: the list as it is', names(order.orderedNodes([a, b, c], undefined)) === 'a.example.com,b.example.com,c.example.com');
  const stored = [keyOf(c), keyOf(a), keyOf(b)];
  check('the stored order applies', names(order.orderedNodes([a, b, c], stored)) === 'c.example.com,a.example.com,b.example.com');
  check('a server the order does not know goes after the known ones', names(order.orderedNodes([d, a, b, c], stored)) === 'c.example.com,a.example.com,b.example.com,d.example.com');
  check('a removed server is skipped', names(order.orderedNodes([a, c], stored)) === 'c.example.com,a.example.com');
  check('the panel reordering its list changes nothing', names(order.orderedNodes([b, c, a], stored)) === 'c.example.com,a.example.com,b.example.com');
}

// --- 4. Moving ----------------------------------------------------------------------------------
{
  const list = order.keyedNodes([a, b, c, d]);
  const key = (k: { key: string }) => k.key;
  const moved = order.movedOrder(list, 3, 0, key);
  check('move down-to-up: d first', moved.join() === [list[3], list[0], list[1], list[2]].map(key).join());
  const down = order.movedOrder(list, 0, 2, key);
  check('move up-to-down: a third', down.join() === [list[1], list[2], list[0], list[3]].map(key).join());
  check('out of range: unchanged', order.movedOrder(list, 5, 0, key).join() === list.map(key).join());
  const applied = order.orderedNodes([a, b, c, d], moved);
  check('a move then applies to the same list', applied.map((k) => k.node.name).join() === 'd.example.com,a.example.com,b.example.com,c.example.com');
}

// --- 5. Storage ---------------------------------------------------------------------------------
{
  store.set('nexus.nodeOrder.v1', JSON.stringify({ sub1: ['k1', 'k2'], manual: ['m1'], bad: 'x' }));
  const loaded = order.loadNodeOrders();
  check('stored orders load; a malformed list is dropped', loaded.sub1?.join() === 'k1,k2' && loaded.manual?.join() === 'm1' && !('bad' in loaded));
  store.set('nexus.nodeOrder.v1', '{not json');
  check('unreadable storage: no orders', Object.keys(order.loadNodeOrders()).length === 0);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
