const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { execFile } = require('node:child_process');

const RAW_PATH = path.resolve('data/raw.json');
const CHECKED_PATH = path.resolve('data/checked.json');

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '200', 10);
const BATCH_INDEX = parseInt(process.env.BATCH_INDEX || '0', 10);
const MAX_LATENCY = parseInt(process.env.MAX_LATENCY || '150', 10);
const TCP_TIMEOUT = parseInt(process.env.TCP_TIMEOUT || '5000', 10);
const HTTP_TIMEOUT = parseInt(process.env.HTTP_TIMEOUT || '7000', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '100', 10);
// Each xray process is a real OS process; keep this modest on shared 2-core CI runners
// or "XRAY START FAIL" starts showing up under contention even for good servers.
const XRAY_CONCURRENCY = parseInt(process.env.XRAY_CONCURRENCY || '5', 10);
const XRAY_START_TIMEOUT = parseInt(process.env.XRAY_START_TIMEOUT || '6000', 10);

const CHECK_TARGET_URL = 'https://www.gstatic.com/generate_204';

function tcpCheck(host, port, timeout) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

/**
 * The real "does this VPN actually work" check: a genuine HTTPS request routed through the
 * local SOCKS5 port that Xray is listening on. Uses curl (mature, well-tested SOCKS5+TLS
 * implementation) instead of a hand-rolled client — this is deliberately the simplest thing
 * that can prove traffic goes runner -> local SOCKS5 -> Xray -> VPN server -> internet.
 *
 * --socks5-hostname (not --socks5) is used on purpose: it makes curl send the hostname to the
 * proxy for it to resolve, so DNS resolution also happens through the VPN, not locally. There
 * is no "direct" fallback here — if the SOCKS5 tunnel or the outbound doesn't work, curl fails.
 */
function curlThroughSocks(localPort, timeoutMs) {
  return new Promise((resolve) => {
    const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
    const args = [
      '-s',
      '-o', '/dev/null',
      '-w', '%{http_code} %{time_total}',
      '--max-time', String(timeoutSec),
      '--socks5-hostname', `127.0.0.1:${localPort}`,
      CHECK_TARGET_URL
    ];

    execFile('curl', args, { timeout: timeoutMs + 2000 }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, error: err.message });
        return;
      }
      const parts = stdout.trim().split(/\s+/);
      const status = parseInt(parts[0], 10);
      const timeTotal = parseFloat(parts[1]);
      if (!Number.isFinite(status) || !Number.isFinite(timeTotal) || status === 0) {
        resolve({ ok: false, error: `unparsable curl output: "${stdout.trim()}"` });
        return;
      }
      resolve({ ok: true, status, latency: Math.round(timeTotal * 1000) });
    });
  });
}

async function checkOne(entry, localPort, xrayModule) {
  const { host, port, outbound, type } = entry;
  const label = `${type} ${host}:${port}`;

  const config = xrayModule.buildCheckConfig(outbound, localPort);
  const configPath = xrayModule.writeTempConfig(config);
  let xray;

  try {
    xray = xrayModule.startXray(configPath);
    const ready = await xrayModule.waitForPort(localPort, XRAY_START_TIMEOUT);
    if (!ready || !xray.isAlive()) {
      console.log(`${label} XRAY START FAIL`);
      return { status: 'XRAY_START_FAIL' };
    }
    console.log(`${label} XRAY PASS`);
    console.log(`${label} SOCKS PASS`);

    const result = await curlThroughSocks(localPort, HTTP_TIMEOUT);
    if (!result.ok) {
      console.log(`${label} PROXY HTTPS FAIL (${result.error})`);
      return { status: 'PROXY_REQUEST_FAIL' };
    }
    if (result.status < 200 || result.status >= 300) {
      console.log(`${label} PROXY HTTPS FAIL (HTTP ${result.status})`);
      return { status: 'HTTP_FAIL' };
    }
    console.log(`${label} PROXY HTTPS PASS`);

    if (result.latency > MAX_LATENCY) {
      console.log(`${label} LATENCY ${result.latency} ms FAIL (> ${MAX_LATENCY})`);
      return { status: 'LATENCY_FAIL' };
    }
    console.log(`${label} LATENCY ${result.latency} ms`);
    console.log(`${label} PASS`);
    return { status: 'PASS', latency: result.latency };
  } finally {
    if (xray) await xrayModule.stopXray(xray.proc);
    xrayModule.cleanupConfig(configPath);
  }
}

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  async function run() {
    while (idx < items.length) {
      const current = idx++;
      results[current] = await worker(items[current], current);
    }
  }
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => run());
  await Promise.all(runners);
  return results;
}

async function main() {
  const { parseUri } = await import('./parser.js');
  const xrayModule = await import('./xray.js');

  if (!fs.existsSync(RAW_PATH)) {
    console.error('data/raw.json not found, run "npm run collect" first');
    process.exit(1);
  }

  const rawUris = JSON.parse(fs.readFileSync(RAW_PATH, 'utf8'));
  console.log(`Unique nodes: ${rawUris.length}`);

  if (rawUris.length === 0) {
    console.log('No sources collected yet — nothing to check.');
    fs.mkdirSync(path.dirname(CHECKED_PATH), { recursive: true });
    if (!fs.existsSync(CHECKED_PATH)) fs.writeFileSync(CHECKED_PATH, '[]');
    return;
  }

  const batchCount = Math.max(1, Math.ceil(rawUris.length / BATCH_SIZE));
  const safeIndex = ((BATCH_INDEX % batchCount) + batchCount) % batchCount;
  const batch = rawUris.slice(safeIndex * BATCH_SIZE, safeIndex * BATCH_SIZE + BATCH_SIZE);
  console.log(`Batch: ${safeIndex + 1}/${batchCount}`);
  console.log(`Batch size: ${batch.length}`);

  const entries = [];
  for (const uri of batch) {
    const parsed = parseUri(uri);
    if (!parsed || !parsed.outbound || !parsed.host || !parsed.port) {
      console.log(`SKIP (unparsable): ${uri.slice(0, 60)}`);
      continue;
    }
    entries.push({ uri, ...parsed });
  }

  // Stage 1: TCP reachability, high concurrency.
  const tcpPassed = [];
  let tcpAlive = 0;
  await pool(entries, CONCURRENCY, async (entry) => {
    const label = `${entry.type} ${entry.host}:${entry.port}`;
    const ok = await tcpCheck(entry.host, entry.port, TCP_TIMEOUT);
    if (ok) {
      console.log(`${label} TCP PASS`);
      tcpAlive++;
      tcpPassed.push(entry);
    } else {
      console.log(`${label} TCP FAIL`);
    }
  });
  console.log(`TCP alive: ${tcpAlive}`);

  // Stage 2: full Xray + local SOCKS5 + real HTTPS-through-proxy check, limited concurrency.
  // Every item in the batch gets its own local port (batch is capped at BATCH_SIZE, so a plain
  // running counter is enough — no modulo, no risk of two concurrent xray processes fighting
  // over the same port).
  const passed = [];
  let liveCount = 0;
  const basePort = 20000;
  let portCounter = 0;

  await pool(tcpPassed, XRAY_CONCURRENCY, async (entry) => {
    const localPort = basePort + portCounter++;
    try {
      const result = await checkOne(entry, localPort, xrayModule);
      if (result.status === 'PASS') {
        liveCount++;
        passed.push({ uri: entry.uri, latency: result.latency });
      }
    } catch (err) {
      console.log(`${entry.type} ${entry.host}:${entry.port} ERROR (${err.message})`);
    }
  });

  console.log(`REAL VPN alive: ${liveCount}`);
  console.log(`CHECKED: ${entries.length}`);
  console.log(`ALIVE: ${liveCount}`);

  // Merge with previously known-good nodes from earlier batches/runs.
  let existing = [];
  if (fs.existsSync(CHECKED_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(CHECKED_PATH, 'utf8'));
    } catch {
      existing = [];
    }
  }
  const merged = new Map();
  for (const e of existing) merged.set(e.uri, e);
  for (const p of passed) merged.set(p.uri, p);

  fs.mkdirSync(path.dirname(CHECKED_PATH), { recursive: true });
  fs.writeFileSync(CHECKED_PATH, JSON.stringify(Array.from(merged.values()), null, 2));
  console.log(`Saved ${merged.size} total checked nodes to ${CHECKED_PATH}`);
}

main().catch((err) => {
  console.error('CHECKER FATAL:', err);
  process.exit(1);
});
