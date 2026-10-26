import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve('.');
const UUID = '11111111-2222-3333-4444-555555555555';
const pbk = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

const node = (ip, remark, extra = {}) => ({
  uri: `vless://${UUID}@${ip}:443?type=tcp&security=reality&sni=example.net&pbk=${pbk}&sid=ab#${encodeURIComponent(remark)}`,
  ...extra
});

function run(checked, configPatch = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-'));
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  config.generator = { ...config.generator, ...configPatch };
  config.geoip = { ...config.geoip, providers: [] };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data/checked.json'), JSON.stringify(checked));
  const result = spawnSync(process.execPath, [path.join(root, 'src/generator.js')], { cwd: dir, encoding: 'utf8' });
  const file = path.join(dir, 'public/subscription.json');
  return { ...result, subscription: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null, dir };
}

test('no latency limit: very slow nodes stay in the subscription', () => {
  const { status, subscription } = run([
    node('203.0.113.1', 'a', { latency: 250, exitCountry: 'DE' }),
    node('203.0.113.2', 'b', { latency: 9500, exitCountry: 'FR' }),
    node('203.0.113.3', 'c', { exitCountry: 'NL' })
  ]);
  assert.equal(status, 0);
  assert.equal(subscription.length, 4);
  assert.equal(subscription[0].remarks, '🇪🇺 АВТО ⚡');
  assert.equal(subscription[0].routing.balancers[0].selector.length, 3);
});

test('country names come from Intl, flags and numbering are generated', () => {
  const { subscription } = run([
    node('203.0.113.1', 'a', { latency: 100, exitCountry: 'DE' }),
    node('203.0.113.2', 'b', { latency: 200, exitCountry: 'DE' }),
    node('203.0.113.3', 'c', { latency: 300, exitCountry: 'US' })
  ]);
  const names = subscription.slice(1).map((entry) => entry.remarks);
  assert.deepEqual(names, ['🇩🇪 Германия', '🇩🇪 Германия #2', '🇺🇸 США']);
});

test('RU nodes are dropped when others exist, except whitelisted ones', () => {
  const { subscription } = run([
    node('203.0.113.1', 'plain', { latency: 100, exitCountry: 'RU' }),
    node('203.0.113.2', '[Обход БС | Все операторы] x', { latency: 100, exitCountry: 'RU' }),
    node('203.0.113.3', 'eu', { latency: 100, exitCountry: 'DE' })
  ]);
  assert.deepEqual(subscription.slice(1).map((entry) => entry.remarks), ['🇩🇪 Германия', '🇷🇺 🏳️ Россия']);
});

test('if everything is excluded the nodes are kept instead of failing', () => {
  const kept = run([node('203.0.113.1', 'a', { latency: 100, exitCountry: 'RU' })]);
  assert.equal(kept.status, 0);
  assert.equal(kept.subscription.length, 2);

  const strict = run([node('203.0.113.1', 'a', { latency: 100, exitCountry: 'RU' })], { relaxExclusionIfEmpty: false });
  assert.equal(strict.status, 1);
  assert.equal(strict.subscription, null);
});

test('settings come from config', () => {
  const { subscription } = run([node('203.0.113.1', 'a', { latency: 100, exitCountry: 'DE' })], {
    autoRemarks: 'AUTO',
    inbounds: { listen: '127.0.0.1', socksPort: 1080, httpPort: 8080, sniffing: ['tls'] },
    balancer: { tag: 'B', maxRTT: '20s', expected: 1, baselines: ['2s'], tolerance: 0.1, fallbackTag: 'block' }
  });
  assert.equal(subscription[0].remarks, 'AUTO');
  assert.equal(subscription[0].inbounds[0].port, 1080);
  assert.equal(subscription[0].routing.balancers[0].tag, 'B');
  assert.equal(subscription[0].routing.balancers[0].strategy.settings.maxRTT, '20s');
});
