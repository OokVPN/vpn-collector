import test from 'node:test';
import assert from 'node:assert/strict';
import { extractUris, parseUri, nodeKey } from '../src/parser.js';

const UUID = '11111111-2222-3333-4444-555555555555';
const reality = `vless://${UUID}@203.0.113.10:443?type=tcp&security=reality&sni=example.net&pbk=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ&sid=ab&flow=xtls-rprx-vision&fp=chrome`;

test('keeps spaces and brackets in the remark of a plain list', () => {
  const line = `${reality}#[Обход БС | Все операторы] Server 1 (fast)`;
  const uris = extractUris(`\uFEFF${line}\r\n\r\n# comment\r\n`);
  assert.deepEqual(uris, [line]);
  assert.equal(parseUri(uris[0]).remark, '[Обход БС | Все операторы] Server 1 (fast)');
});

test('decodes a base64 subscription', () => {
  const text = `${reality}#a\nss://YWVzLTI1Ni1nY206cGFzcw@198.51.100.5:8388#b`;
  const encoded = Buffer.from(text).toString('base64');
  assert.equal(extractUris(encoded).length, 2);
  assert.equal(extractUris(encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')).length, 2);
});

test('finds URIs inside JSON with escaped slashes and in HTML', () => {
  const json = JSON.stringify({ links: [reality + '&x=1#n'], nested: { raw: Buffer.from(reality).toString('base64') } }).replace(/\//g, '\\/');
  assert.equal(extractUris(json).length, 2);
  assert.deepEqual(extractUris(`<a href="${reality}&amp;x=1">link</a>`), [`${reality}&x=1`]);
});

test('mixes direct URIs and base64 blocks', () => {
  const other = `trojan://pass@198.51.100.7:443?sni=example.net#t`;
  const text = `${reality}\n${Buffer.from(other).toString('base64')}`;
  assert.equal(extractUris(text).length, 2);
});

test('parses VLESS Reality and IPv6 hosts', () => {
  const parsed = parseUri(reality);
  assert.equal(parsed.type, 'VLESS');
  assert.equal(parsed.outbound.streamSettings.security, 'reality');
  assert.equal(parsed.outbound.settings.vnext[0].users[0].flow, 'xtls-rprx-vision');

  const v6 = parseUri(`vless://${UUID}@[2001:db8::1]:443?security=tls&sni=example.net&type=ws&host=cdn.example.net&path=%2Fws`);
  assert.equal(v6.host, '2001:db8::1');
  assert.equal(v6.outbound.settings.vnext[0].address, '2001:db8::1');
  assert.deepEqual(v6.outbound.streamSettings.wsSettings.headers, { Host: 'cdn.example.net' });
});

test('rejects Reality without a public key and unsupported transports', () => {
  assert.equal(parseUri(`vless://${UUID}@203.0.113.10:443?security=reality&sni=a.b`), null);
  assert.equal(parseUri(`vless://${UUID}@203.0.113.10:443?type=quic&security=tls`), null);
});

test('shadowsocks: SIP002, percent-encoded userinfo, legacy and plugin', () => {
  const user = Buffer.from('aes-256-gcm:secret').toString('base64');
  assert.equal(parseUri(`ss://${user}@203.0.113.9:8388#x`).outbound.settings.servers[0].password, 'secret');
  assert.equal(parseUri(`ss://${encodeURIComponent(user)}@203.0.113.9:8388`).outbound.settings.servers[0].method, 'aes-256-gcm');
  assert.equal(parseUri(`ss://aes-128-gcm:p%40ss@203.0.113.9:8388`).outbound.settings.servers[0].password, 'p@ss');
  const legacy = Buffer.from('chacha20-ietf-poly1305:pw@203.0.113.9:443').toString('base64');
  assert.equal(parseUri(`ss://${legacy}#legacy`).port, 443);
  assert.equal(parseUri(`ss://${user}@203.0.113.9:8388?plugin=v2ray-plugin%3Bmode%3Dwebsocket`), null);
});

test('vmess and hysteria2', () => {
  const vmess = Buffer.from(JSON.stringify({ v: '2', ps: 'vm', add: 'vm.example.net', port: '443', id: UUID, aid: '0', net: 'ws', host: 'h.example.net', path: '/p', tls: 'tls', sni: 's.example.net' })).toString('base64');
  const parsed = parseUri(`vmess://${vmess}`);
  assert.equal(parsed.remark, 'vm');
  assert.equal(parsed.outbound.streamSettings.tlsSettings.serverName, 's.example.net');

  const hy2 = parseUri('hy2://secret@hy.example.net?sni=hy.example.net');
  assert.equal(hy2.port, 443);
  assert.equal(hy2.outbound.streamSettings.hysteriaSettings.auth, 'secret');
});

test('drops placeholders and stub nodes', () => {
  assert.equal(parseUri(`vless://00000000-0000-0000-0000-000000000000@203.0.113.10:443?security=tls`), null);
  assert.equal(parseUri(`vless://${UUID}@0.0.0.0:443?security=tls`), null);
  assert.equal(parseUri(`vless://${UUID}@192.168.1.5:443?security=tls`), null);
  assert.equal(parseUri(`vless://${UUID}@example.com:443?security=tls`), null);
});

test('nodeKey ignores the remark but not the transport', () => {
  const a = parseUri(`${reality}#one`);
  const b = parseUri(`${reality}#two`);
  const c = parseUri(reality.replace('sni=example.net', 'sni=other.net'));
  assert.equal(nodeKey(a), nodeKey(b));
  assert.notEqual(nodeKey(a), nodeKey(c));
});
