import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { curlOnce, probeThroughProxy, parseTrace } = require('../src/checker.cjs');

function startProxy(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => handler(req, res));
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const baseCfg = {
  curlBinary: 'curl',
  requestTimeoutMs: 2000,
  attemptsPerTest: 2,
  timeoutsBeforeGiveUp: 2,
  latencyRounds: 2,
  retryDelayMs: 10
};

const alive = { isAlive: () => true };
const t204 = (name) => ({ url: `http://${name}.test/generate_204`, status: 204 });
const trace = { url: 'http://trace.test/cdn-cgi/trace', status: 200, kind: 'trace' };

test('accepts only the exact expected status', async () => {
  const ok = await startProxy((req, res) => { res.writeHead(204); res.end(); });
  const bad = await startProxy((req, res) => { res.writeHead(502); res.end('Bad Gateway'); });
  const wrong = await startProxy((req, res) => { res.writeHead(200); res.end('<html>captive portal</html>'); });
  const body204 = await startProxy((req, res) => { res.writeHead(204, { 'Content-Type': 'text/plain' }); res.end(); });

  try {
    assert.equal((await curlOnce(baseCfg, ok.port, t204('a'))).ok, true);
    const r502 = await curlOnce(baseCfg, bad.port, t204('a'));
    assert.equal(r502.ok, false);
    assert.match(r502.error, /HTTP 502/);
    const r200 = await curlOnce(baseCfg, wrong.port, t204('a'));
    assert.equal(r200.ok, false);
    assert.match(r200.error, /HTTP 200, expected 204/);
    assert.equal((await curlOnce(baseCfg, body204.port, t204('a'))).ok, true);
  } finally {
    for (const item of [ok, bad, wrong, body204]) item.server.close();
  }
});

test('a node is not rejected for not supporting keep-alive and slow answers are fine', async () => {
  const slow = await startProxy((req, res) => {
    setTimeout(() => { res.writeHead(204, { Connection: 'close' }); res.end(); }, 900);
  });
  try {
    const cfg = { ...baseCfg, tests: [t204('slow')] };
    const ok = await probeThroughProxy(cfg, slow.port, alive);
    assert.equal(ok.ok, true);
    assert.ok(ok.latency >= 900, `latency ${ok.latency}`);
  } finally {
    slow.server.close();
  }
});

test('trace test returns the exit IP and country; falls through to the next URL', async () => {
  const proxy = await startProxy((req, res) => {
    if (req.url.includes('trace.test')) {
      res.writeHead(200);
      res.end('fl=1\nip=198.51.100.77\nloc=DE\ntls=TLSv1.3\n');
    } else {
      res.writeHead(204);
      res.end();
    }
  });
  const blocked = await startProxy((req, res) => {
    if (req.url.includes('trace.test')) { res.writeHead(403); res.end('no'); }
    else { res.writeHead(204); res.end(); }
  });
  try {
    const first = await probeThroughProxy({ ...baseCfg, tests: [trace, t204('b')] }, proxy.port, alive);
    assert.equal(first.ok, true);
    assert.equal(first.exitIp, '198.51.100.77');
    assert.equal(first.exitCountry, 'DE');

    const second = await probeThroughProxy({ ...baseCfg, tests: [trace, t204('b')] }, blocked.port, alive);
    assert.equal(second.ok, true);
    assert.equal(second.exitCountry, null);
    assert.match(second.url, /generate_204/);
  } finally {
    proxy.server.close();
    blocked.server.close();
  }
});

test('dead nodes fail, and a node that answers 5xx everywhere is never marked as working', async () => {
  const bad = await startProxy((req, res) => { res.writeHead(503); res.end(); });
  try {
    const result = await probeThroughProxy({ ...baseCfg, tests: [trace, t204('c'), t204('d')] }, bad.port, alive);
    assert.equal(result.ok, false);
    assert.match(result.error, /HTTP 503/);
  } finally {
    bad.server.close();
  }

  const closed = await probeThroughProxy({ ...baseCfg, tests: [t204('e')] }, 9, alive);
  assert.equal(closed.ok, false);
  assert.equal((await probeThroughProxy({ ...baseCfg, tests: [t204('e')] }, 9, { isAlive: () => false })).error, 'Xray process died');
});

test('gives up early on repeated timeouts', async () => {
  const hang = await startProxy(() => {});
  try {
    const started = Date.now();
    const cfg = { ...baseCfg, requestTimeoutMs: 2000, tests: [t204('f'), t204('g'), t204('h')] };
    const result = await probeThroughProxy(cfg, hang.port, alive);
    assert.equal(result.ok, false);
    assert.ok(Date.now() - started < 5500, 'should stop after two timeouts');
  } finally {
    hang.server.closeAllConnections?.();
    hang.server.close();
  }
});

test('parseTrace', () => {
  assert.deepEqual(parseTrace('ip=1.2.3.4\nloc=NL\nbad line'), { ip: '1.2.3.4', loc: 'NL' });
});
