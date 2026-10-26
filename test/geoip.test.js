import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGeoResolver } from '../src/geoip.js';

const providers = [
  { name: 'a', url: 'https://a.test/{ip}', code: 'country_code', ok: { success: true } },
  { name: 'b', url: 'https://b.test/{ip}', code: 'country' },
  { name: 'c', url: 'https://c.test/{ip}', code: 'country_code', failIf: 'error' },
  { name: 'd', url: 'http://d.test/{ip}', code: 'countryCode', ok: { status: 'success' } }
];

const options = {
  ttlDays: 30,
  timeoutMs: 1000,
  concurrency: 2,
  quorum: 2,
  maxQueriesPerIp: 4,
  maxFailuresPerProvider: 2,
  maxIpsPerHost: 2,
  useRemarkFlagHint: true,
  providers
};

function tmpCache() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'geo-')), 'cache.json');
}

function fakeFetch(answers, calls = []) {
  return async (url) => {
    const name = new URL(url).host.split('.')[0];
    calls.push(name);
    const answer = answers[name];
    if (answer === 'down') throw new Error('network');
    if (answer === 429) return new Response('', { status: 429 });
    return new Response(JSON.stringify(answer), { status: 200 });
  };
}

test('two agreeing providers are enough', async () => {
  const calls = [];
  const geo = createGeoResolver(options, tmpCache(), fakeFetch({ a: { success: true, country_code: 'NL' }, b: { country: 'NL' } }, calls));
  assert.deepEqual(await geo.lookup('203.0.113.5'), { countryCode: 'NL', source: 'geoip' });
  assert.deepEqual(calls.sort(), ['a', 'b']);
});

test('a disagreement is settled by further providers (majority wins)', async () => {
  const geo = createGeoResolver(options, tmpCache(), fakeFetch({
    a: { success: true, country_code: 'RU' },
    b: { country: 'DE' },
    c: { country_code: 'DE' },
    d: { status: 'success', countryCode: 'DE' }
  }));
  assert.equal((await geo.lookup('203.0.113.6')).countryCode, 'DE');
});

test('failed providers are skipped, error payloads are ignored, a single answer is accepted', async () => {
  const geo = createGeoResolver(options, tmpCache(), fakeFetch({
    a: 'down',
    b: { country: 'FI' },
    c: { error: true, reason: 'RateLimited' },
    d: { status: 'fail' }
  }));
  assert.equal((await geo.lookup('203.0.113.7')).countryCode, 'FI');
});

test('unknown when everything fails; private addresses are never sent to providers', async () => {
  const calls = [];
  const geo = createGeoResolver(options, tmpCache(), fakeFetch({ a: 'down', b: 'down', c: 'down', d: 'down' }, calls));
  assert.equal((await geo.lookup('203.0.113.8')).countryCode, 'UN');
  const before = calls.length;
  assert.equal((await geo.lookup('10.1.2.3')).countryCode, 'UN');
  assert.equal(calls.length, before);
});

test('remark flag is only a fallback', async () => {
  const down = fakeFetch({ a: 'down', b: 'down', c: 'down', d: 'down' });
  const geo = createGeoResolver(options, tmpCache(), down);
  assert.deepEqual(await geo.lookup('203.0.113.9', '🇫🇷 Paris'), { countryCode: 'FR', source: 'remark' });

  const live = createGeoResolver(options, tmpCache(), fakeFetch({ a: { success: true, country_code: 'SE' }, b: { country: 'SE' } }));
  assert.equal((await live.lookup('203.0.113.10', '🇫🇷 Paris')).countryCode, 'SE');
});

test('results persist in the cache file', async () => {
  const file = tmpCache();
  const first = createGeoResolver(options, file, fakeFetch({ a: { success: true, country_code: 'PL' }, b: { country: 'PL' } }));
  await first.lookup('203.0.113.11');
  first.save();

  const calls = [];
  const second = createGeoResolver(options, file, fakeFetch({}, calls));
  assert.equal((await second.lookup('203.0.113.11')).countryCode, 'PL');
  assert.equal(calls.length, 0);
});
