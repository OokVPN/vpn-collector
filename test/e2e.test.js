import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve('.');
const UUID = '11111111-2222-3333-4444-555555555555';

const FAKE_XRAY = `#!/usr/bin/env node
const fs = require('fs');
const http = require('http');
const args = process.argv.slice(2);
if (args.includes('-test')) process.exit(0);
const cfg = JSON.parse(fs.readFileSync(args[args.indexOf('-config') + 1], 'utf8'));
const target = cfg.outbounds[0].settings.vnext[0].port;
const live = (process.env.FAKE_LIVE_PORTS || '').split(',').map(Number);
http.createServer((req, res) => {
  if (!live.includes(target)) { res.writeHead(503); res.end('proxy error'); return; }
  if (req.url.includes('trace')) { res.writeHead(200); res.end('ip=198.51.100.1\\nloc=SE\\n'); return; }
  res.writeHead(204); res.end();
}).listen(cfg.inbounds[0].port, '127.0.0.1');
`;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function runNode(script, cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd, env: { ...process.env, ...env } });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (status) => resolve({ status, output }));
  });
}

test('full pipeline: collect -> check -> generate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
  const live1 = net.createServer((s) => s.destroy());
  const live2 = net.createServer((s) => s.destroy());
  const fake503 = net.createServer((s) => s.destroy());
  const ports = { live1: await listen(live1), live2: await listen(live2), fake503: await listen(fake503) };
  const probe = net.createServer();
  const deadPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  const uri = (port, name) => `vless://${UUID}@127.0.0.1:${port}?security=tls&sni=x.test#${encodeURIComponent(name)}`;
  const body = Buffer.from([
    uri(ports.live1, 'one'), uri(ports.live2, 'two'), uri(ports.fake503, 'bad-503'), uri(deadPort, 'dead'),
    `vless://00000000-0000-0000-0000-000000000000@127.0.0.1:${ports.live1}?security=tls#stub`
  ].join('\n')).toString('base64');
  const source = http.createServer((req, res) => { res.writeHead(200); res.end(body); });
  const sourcePort = await listen(source);

  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  config.parser.rejectPrivateAddresses = false;
  config.checker.tests = [
    { url: 'http://trace.test/cdn-cgi/trace', status: 200, kind: 'trace' },
    { url: 'http://t.test/generate_204', status: 204 }
  ];
  config.checker.requestTimeoutMs = 2000;
  config.checker.tcpPrecheckTimeoutMs = 1000;
  config.geoip.providers = [];
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(dir, 'sources.json'), JSON.stringify([`http://127.0.0.1:${sourcePort}/sub`]));
  fs.writeFileSync(path.join(dir, 'xray'), FAKE_XRAY, { mode: 0o755 });

  const env = { XRAY_BIN: path.join(dir, 'xray'), FAKE_LIVE_PORTS: `${ports.live1},${ports.live2}` };

  try {
    const check = await runNode(path.join(root, 'src/checker.cjs'), dir, env);
    assert.equal(check.status, 0, check.output);
    assert.doesNotMatch(check.output, new RegExp(String(sourcePort) + '/sub'), 'source URL must not be printed');

    const checked = JSON.parse(fs.readFileSync(path.join(dir, 'data/checked.json'), 'utf8'));
    assert.equal(checked.length, 2, check.output);
    assert.ok(checked.every((entry) => entry.exitCountry === 'SE' && entry.latency > 0));
    assert.ok(checked.every((entry) => !('outbound' in entry) && !('key' in entry)));
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'data/failed.json'), 'utf8'))).length, 2);

    const again = await runNode(path.join(root, 'src/checker.cjs'), dir, env);
    assert.equal(again.status, 0, again.output);
    assert.match(again.output, /Still working: 2\/2/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'data/checked.json'), 'utf8')).length, 2);

    const generate = await runNode(path.join(root, 'src/generator.js'), dir, env);
    assert.equal(generate.status, 0, generate.output);
    const subscription = JSON.parse(fs.readFileSync(path.join(dir, 'public/subscription.json'), 'utf8'));
    assert.deepEqual(subscription.slice(1).map((entry) => entry.remarks), ['🇸🇪 Швеция', '🇸🇪 Швеция #2']);

    const validate = await runNode(path.join(root, 'src/validate.js'), dir, env);
    assert.equal(validate.status, 0, validate.output);

    fs.writeFileSync(path.join(dir, 'xray'), FAKE_XRAY);
    const down = await runNode(path.join(root, 'src/checker.cjs'), dir, { ...env, FAKE_LIVE_PORTS: ports.live1 + '' });
    assert.match(down.output, /Still working: 1\/2/);
  } finally {
    for (const server of [live1, live2, fake503, source]) server.close();
  }
});
