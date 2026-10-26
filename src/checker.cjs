'use strict';

const fs = require('node:fs');
const net = require('node:net');
const { execFile } = require('node:child_process');

const MARKER = '__CURL_RESULT__';
const CLEAN_ENV = {
  HTTP_PROXY: '',
  HTTPS_PROXY: '',
  ALL_PROXY: '',
  http_proxy: '',
  https_proxy: '',
  all_proxy: ''
};

const errorStats = new Map();
let printedErrors = 0;
let maxErrorPrints = 50;

function addError(reason) {
  errorStats.set(reason, (errorStats.get(reason) || 0) + 1);
  if (printedErrors < maxErrorPrints) {
    console.log(`FAIL ${reason}`);
    printedErrors++;
  }
}

function cleanError(error) {
  return String(error || '')
    .replace(/\r/g, ' ')
    .replace(/\n+/g, ' ')
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<uuid>')
    .slice(0, 300);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function parseTrace(body) {
  const info = {};
  for (const line of String(body).split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) info[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return info;
}

function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let finished = false;
    const done = (ok, error) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve({ ok, error });
    };
    socket.setTimeout(timeoutMs, () => done(false, 'timeout'));
    socket.once('connect', () => done(true));
    socket.once('error', (error) => done(false, error.code || error.message));
  });
}

function isTcpBased(outbound) {
  const network = outbound && outbound.streamSettings && outbound.streamSettings.network;
  return outbound.protocol !== 'hysteria' && !['kcp', 'quic', 'hysteria'].includes(network);
}

function curlOnce(cfg, port, test) {
  return new Promise((resolve) => {
    const seconds = Math.max(2, Math.ceil(cfg.requestTimeoutMs / 1000));
    const args = [
      '--silent',
      '--show-error',
      '--http1.1',
      '--connect-timeout', String(seconds),
      '--max-time', String(seconds),
      '--max-filesize', '65536',
      '--proxy', `http://127.0.0.1:${port}`,
      '--noproxy', '',
      '--write-out', `\n${MARKER}%{http_code}|%{time_total}`,
      test.url
    ];

    execFile(cfg.curlBinary, args, {
      timeout: seconds * 1000 + 5000,
      maxBuffer: 262144,
      env: { ...process.env, ...CLEAN_ENV }
    }, (error, stdout, stderr) => {
      const output = String(stdout || '');
      const at = output.lastIndexOf(MARKER);
      const timedOut = Boolean(error) && (error.code === 28 || error.killed === true);

      let status = 0;
      let totalSeconds = NaN;
      let body = '';
      if (at !== -1) {
        body = output.slice(0, at);
        const [code, total] = output.slice(at + MARKER.length).trim().split('|');
        status = Number(code) || 0;
        totalSeconds = Number(total);
      }

      if (error || status === 0 || !Number.isFinite(totalSeconds)) {
        resolve({ ok: false, timedOut, error: cleanError(String(stderr || '').trim() || (error && error.message) || 'no HTTP response') });
        return;
      }

      const expected = test.status || 204;
      if (status !== expected) {
        resolve({ ok: false, timedOut: false, error: `HTTP ${status}, expected ${expected}` });
        return;
      }

      const result = { ok: true, latency: Math.max(1, Math.round(totalSeconds * 1000)) };

      if (test.kind === 'trace') {
        const info = parseTrace(body);
        if (!info.ip) {
          resolve({ ok: false, timedOut: false, error: 'unexpected response body (no ip= field)' });
          return;
        }
        result.exitIp = info.ip;
        if (/^[A-Z]{2}$/.test(info.loc || '') && !['XX', 'T1'].includes(info.loc)) result.exitCountry = info.loc;
      } else if (expected === 204 && body.trim() !== '') {
        resolve({ ok: false, timedOut: false, error: 'HTTP 204 with a non-empty body' });
        return;
      }

      resolve(result);
    });
  });
}

async function probeThroughProxy(cfg, port, xray) {
  let lastError = 'no tests configured';
  let timeouts = 0;

  for (const test of cfg.tests) {
    const samples = [];
    let exitIp = null;
    let exitCountry = null;

    for (let attempt = 1; attempt <= cfg.attemptsPerTest; attempt++) {
      if (!xray.isAlive()) return { ok: false, error: 'Xray process died' };
      const result = await curlOnce(cfg, port, test);
      if (result.ok) {
        samples.push(result.latency);
        exitIp = result.exitIp || exitIp;
        exitCountry = result.exitCountry || exitCountry;
        break;
      }
      lastError = `${test.url} ${result.error}`;
      if (result.timedOut) {
        timeouts++;
        break;
      }
      await delay(cfg.retryDelayMs);
    }

    if (samples.length > 0) {
      for (let round = 1; round < cfg.latencyRounds; round++) {
        const result = await curlOnce(cfg, port, test);
        if (result.ok) {
          samples.push(result.latency);
          exitIp = result.exitIp || exitIp;
          exitCountry = result.exitCountry || exitCountry;
        }
      }
      if (!xray.isAlive()) return { ok: false, error: 'Xray process died during the check' };
      return { ok: true, url: test.url, latency: median(samples), exitIp, exitCountry };
    }

    if (timeouts >= cfg.timeoutsBeforeGiveUp) break;
  }

  return { ok: false, error: lastError };
}

async function checkNode(entry, ctx) {
  const { cfg, xray: xrayModule } = ctx;
  const { type, host, port, outbound, uri } = entry;
  const label = `${type} ${host}:${port}`;

  if (isTcpBased(outbound)) {
    const tcp = await tcpProbe(host, port, cfg.tcpPrecheckTimeoutMs);
    if (!tcp.ok) {
      addError(`${label} TCP ${tcp.error}`);
      return null;
    }
  }

  const localPort = await xrayModule.getFreePort();
  const configPath = xrayModule.writeTempConfig(xrayModule.buildCheckConfig(outbound, localPort));
  let xray;

  try {
    const valid = await xrayModule.testConfig(configPath, cfg.xrayStartTimeoutMs);
    if (!valid.ok) {
      addError(`${label} XRAY CONFIG ${cleanError(valid.output)}`);
      return null;
    }

    xray = xrayModule.startXray(configPath);
    const ready = await xrayModule.waitForPort(localPort, cfg.xrayStartTimeoutMs, xray.isAlive);
    if (!ready || !xray.isAlive()) {
      const output = xray.getOutput();
      addError(`${label} XRAY START ${cleanError(output.stderr || output.stdout || 'HTTP inbound did not start')}`);
      return null;
    }

    const probe = await ctx.probe(cfg, localPort, xray);
    if (!probe.ok) {
      addError(`${label} ${cleanError(probe.error)}`);
      return null;
    }

    console.log(`PASS ${probe.latency}ms ${label}${probe.exitCountry ? ` exit ${probe.exitCountry}` : ''}`);
    return {
      uri,
      latency: probe.latency,
      ...(probe.exitIp ? { exitIp: probe.exitIp } : {}),
      ...(probe.exitCountry ? { exitCountry: probe.exitCountry } : {}),
      checkedAt: new Date().toISOString()
    };
  } finally {
    if (xray) await xrayModule.stopXray(xray.proc);
    xrayModule.cleanupConfig(configPath);
  }
}

function parseEntries(items, ctx) {
  const parsed = [];
  const seen = new Set();
  for (const item of items) {
    const uri = typeof item === 'string' ? item : item && item.uri;
    if (typeof uri !== 'string') continue;
    const result = ctx.parser.parseUri(uri);
    if (!result) {
      addError(`PARSE ${uri.slice(0, 60).replace(/[?#].*$/, '')}`);
      continue;
    }
    const key = ctx.parser.nodeKey(result);
    if (seen.has(key)) continue;
    seen.add(key);
    parsed.push({ uri, key, prev: typeof item === 'object' ? item : { uri }, ...result });
  }
  return parsed;
}

async function checkEntries(entries, ctx) {
  const passed = [];
  const failed = [];
  const skipped = [];
  const results = await ctx.util.mapLimit(entries, ctx.cfg.concurrency, async (entry) => {
    if (Date.now() > ctx.deadline) return { skipped: true };
    try {
      return { result: await checkNode(entry, ctx) };
    } catch (error) {
      addError(`WORKER ${cleanError(error.message || error)}`);
      return { result: null };
    }
  });

  results.forEach((outcome, index) => {
    const entry = entries[index];
    if (outcome.skipped) skipped.push(entry);
    else if (outcome.result) passed.push({ ...outcome.result, key: entry.key });
    else failed.push(entry);
  });

  return { passed, failed, skipped };
}

function printFailureSummary() {
  if (errorStats.size === 0) return;
  console.log('\n========== FAILURE SUMMARY ==========');
  const sorted = [...errorStats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
  for (const [reason, count] of sorted) console.log(`${count}x ${reason}`);
  console.log('=====================================\n');
}

function stripKey(entry) {
  const { key, ...rest } = entry;
  return rest;
}

async function main() {
  const config = (await import('./config.js')).default;
  const { resolvePath } = await import('./config.js');
  const parser = await import('./parser.js');
  const xray = await import('./xray.js');
  const util = await import('./util.js');
  const { collectAll } = await import('./collector.js');

  const cfg = config.checker;
  maxErrorPrints = cfg.maxErrorLines;

  const ctx = {
    cfg,
    parser,
    xray,
    util,
    probe: probeThroughProxy,
    deadline: Date.now() + cfg.deadlineMinutes * 60000
  };

  const checkedPath = resolvePath(config.paths.checked);
  const failedPath = resolvePath(config.paths.failed);
  const retryMs = cfg.failedRetryMinutes * 60000;

  const stored = util.readJson(checkedPath, []);
  const existing = parseEntries(Array.isArray(stored) ? stored : [], ctx);
  const failedStore = util.readJson(failedPath, {});
  const failedMap = new Map(
    Object.entries(failedStore && typeof failedStore === 'object' ? failedStore : {})
      .filter(([, time]) => Date.now() - Number(time) < retryMs)
  );

  console.log(`Currently tracked working nodes: ${existing.length}`);
  let working = [];

  if (existing.length > 0) {
    console.log('Re-checking tracked nodes through Xray...');
    const rechecked = await checkEntries(existing, ctx);
    working = [...rechecked.passed, ...rechecked.skipped.map((entry) => ({ ...entry.prev, key: entry.key }))];
    for (const entry of rechecked.failed) failedMap.set(entry.key, Date.now());
    console.log(`Still working: ${working.length}/${existing.length}`);
  }

  const deadCount = existing.length - working.length;
  console.log(`Dead/failed nodes: ${deadCount}`);

  const known = new Set([...working.map((node) => node.key), ...failedMap.keys()]);
  let added = 0;
  const wanted = Math.max(0, cfg.targetNodes - working.length);

  if (wanted > 0) {
    console.log(`Need ${wanted} more node(s) to reach the target of ${cfg.targetNodes}.`);
    console.log('Collecting fresh server sources...');
    let uris = [];
    try {
      uris = (await collectAll()).uris;
    } catch (error) {
      console.error('Collect failed:', cleanError(error.message || error));
      uris = util.readJson(resolvePath(config.paths.raw), []);
    }

    const candidates = parseEntries(uris, ctx).filter((node) => !known.has(node.key));
    console.log(`Fresh unique candidates: ${candidates.length}`);

    for (let round = 1; round <= cfg.maxRounds && candidates.length > 0; round++) {
      if (Date.now() > ctx.deadline) {
        console.log('Deadline reached, stopping the search.');
        break;
      }
      const batch = candidates.splice(0, cfg.batchSize);
      console.log(`Replacement search round ${round}/${cfg.maxRounds}: checking ${batch.length} candidate(s)`);
      const outcome = await checkEntries(batch, ctx);
      console.log(`STRICT CHECK PASSED: ${outcome.passed.length}/${batch.length}`);

      for (const node of outcome.passed) {
        working.push(node);
        known.add(node.key);
        added++;
      }
      for (const entry of outcome.failed) failedMap.set(entry.key, Date.now());
      if (working.length >= cfg.targetNodes) break;
    }
  }

  working.sort((a, b) => (a.latency || Infinity) - (b.latency || Infinity));
  if (working.length > cfg.maxTrackedNodes) working = working.slice(0, cfg.maxTrackedNodes);
  working.sort((a, b) => a.uri.localeCompare(b.uri));

  util.writeJson(checkedPath, working.map(stripKey));
  util.writeJson(failedPath, Object.fromEntries([...failedMap.entries()].sort()));

  console.log(`Final strictly verified nodes: ${working.length}`);
  console.log(`Removed dead nodes: ${deadCount}`);
  console.log(`Added nodes: ${added}`);
  printFailureSummary();
}

module.exports = { curlOnce, probeThroughProxy, tcpProbe, parseTrace, isTcpBased };

if (require.main === module) {
  main().catch((error) => {
    console.error('CHECKER FATAL:', error);
    process.exit(1);
  });
    }
