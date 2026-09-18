/**
 * Generate one sing-box config per supported link shape, for core/nexuscore's checker test.
 *
 * WHY THIS EXISTS
 *
 * Every protocol gap so far was found the same expensive way: build an APK, install it, add a
 * subscription, connect, read a device log, and infer the schema mistake from a runtime symptom
 * three layers away ("unknown version: 72", "reality verification failed"). That loop is hours
 * per protocol and it only covers the one protocol the user happened to have a node for.
 *
 * These fixtures go through the SAME assembler the app uses, and the Go test next to them hands
 * each one to libbox.CheckConfig - the same validator that runs on device. A schema mistake in
 * any supported link shape now fails in seconds, on a laptop, for every shape at once.
 *
 * The credentials are syntactically valid and entirely fake. The public key is a real-shape
 * x25519 value so REALITY parsing is actually exercised.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSingleConfig } from '../src/core/subscription';

const UUID = '11111111-2222-3333-4444-555555555555';
const PBK = 'jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0';

const CASES: Array<[name: string, uri: string]> = [
  ['vless-tcp-plain', `vless://${UUID}@example.com:443?encryption=none#a`],
  ['vless-tcp-http-header', `vless://${UUID}@example.com:58641?type=tcp&headerType=http&host=speedtest.net&path=%2F#a`],
  ['vless-ws-tls', `vless://${UUID}@example.com:443?type=ws&path=%2Fws&host=cdn.example.com&security=tls&sni=cdn.example.com#a`],
  ['vless-reality-vision', `vless://${UUID}@example.com:443?security=reality&sni=www.microsoft.com&pbk=${PBK}&sid=ab&fp=chrome&flow=xtls-rprx-vision&type=tcp#a`],
  ['vless-reality-grpc', `vless://${UUID}@example.com:443?security=reality&sni=www.microsoft.com&pbk=${PBK}&sid=&fp=chrome&type=grpc&serviceName=gsvc#a`],
  ['vless-httpupgrade', `vless://${UUID}@example.com:80?type=httpupgrade&path=%2Fhu&host=h.example.com#a`],
  ['trojan-tls-ws', `trojan://password123@example.com:443?security=tls&sni=example.com&type=ws&path=%2Ftr#a`],
  ['shadowsocks', `ss://${Buffer.from('aes-256-gcm:password123').toString('base64')}@example.com:8388#a`],
  ['hysteria2', `hysteria2://password123@example.com:443?sni=example.com#a`],
  ['tuic', `tuic://${UUID}:password123@example.com:443?sni=example.com&congestion_control=bbr#a`],
  // Panels stamp flow onto plain-TCP nodes. The generated outbound must NOT carry it.
  ['vless-tcp-stray-flow', `vless://${UUID}@example.com:443?type=tcp&flow=xtls-rprx-vision&encryption=none#a`],
  // Panels emit a fixed "h2,http/1.1,h3" on every node. h2 breaks a WS upgrade and h3 is UDP.
  ['vless-ws-tls-panel-alpn', `vless://${UUID}@example.com:8880?type=ws&path=%2F&host=cdn.example.com&security=tls&sni=cdn.example.com&alpn=h2%2Chttp%2F1.1%2Ch3#a`],
  ['vmess-ws', `vmess://${Buffer.from(JSON.stringify({
    v: '2', ps: 'a', add: 'example.com', port: '443', id: UUID,
    aid: '0', net: 'ws', path: '/vm', host: 'h.example.com', tls: 'tls', sni: 'example.com',
  })).toString('base64')}`],
];

const outDir = process.argv[2] ?? join('..', '..', 'core', 'testdata', 'configs');
mkdirSync(outDir, { recursive: true });

/**
 * Rules the core does NOT enforce.
 *
 * libbox.CheckConfig validates the schema, not whether the combination can work on the wire.
 * Anything it accepts but a server rejects has to be asserted here or it ships.
 */
function assertSane(name: string, outbound: Record<string, unknown>) {
  // xtls-rprx-vision operates on TLS records. Without TLS there are none, the server rejects
  // the handshake, and every connection dies as a bare `EOF` with no config-level warning.
  // CheckConfig returns nil for this - verified.
  if (outbound.flow && !outbound.tls) {
    throw new Error(`${name}: flow="${outbound.flow}" with no tls block`);
  }

  // A WebSocket upgrade is HTTP/1.1. If TLS negotiates h2 there is no upgrade to perform and
  // the connection dies just after the handshake - again with no config-level complaint.
  const tls = outbound.tls as { alpn?: string[] } | undefined;
  const transport = outbound.transport as { type?: string } | undefined;
  const alpn = tls?.alpn;
  if (alpn && (transport?.type === 'ws' || transport?.type === 'httpupgrade')) {
    const bad = alpn.filter((a) => a !== 'http/1.1');
    if (bad.length > 0) {
      throw new Error(`${name}: ${transport.type} node offers alpn ${bad.join(',')}`);
    }
  }
  // h3 is HTTP/3 over QUIC. Advertising it on a TCP socket is never right.
  if (alpn?.includes('h3')) {
    throw new Error(`${name}: alpn includes h3 on a TCP transport`);
  }
}

let failures = 0;
for (const [name, uri] of CASES) {
  try {
    const node = parseSingleConfig(uri);
    assertSane(name, JSON.parse(node.config).outbounds[0]);
    writeFileSync(join(outDir, `${name}.json`), node.config);
    console.log(`  ok   ${name} (${node.protocol} / ${node.transport})`);
  } catch (e) {
    failures++;
    console.error(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} link shape(s) could not be parsed at all.`);
  process.exit(1);
}
console.log(`\nwrote ${CASES.length} fixtures to ${outDir}`);
