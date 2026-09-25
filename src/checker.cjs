const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { execFile } = require('node:child_process');

const RAW_PATH = path.resolve('data/raw.json');
const CHECKED_PATH = path.resolve('data/checked.json');

const BATCH_SIZE = Number(process.env.BATCH_SIZE || 200);
const BATCH_INDEX = Number(process.env.BATCH_INDEX || 0);

const MAX_LATENCY = Math.min(
 Number(process.env.MAX_LATENCY || 1000),
  1000
  );

const TCP_TIMEOUT = Number(process.env.TCP_TIMEOUT || 5000);
const XRAY_TIMEOUT = Number(process.env.XRAY_TIMEOUT || process.env.XRAY_START_TIMEOUT || 10000);
const CURL_TIMEOUT = Number(process.env.CURL_TIMEOUT || process.env.HTTP_TIMEOUT || 12000);

const CONCURRENCY = Number(process.env.CONCURRENCY || 100);
const XRAY_CONCURRENCY = Number(process.env.XRAY_CONCURRENCY || 10);

const TEST_URL = 'https://www.gstatic.com/generate_204';

const errorStats = new Map();
let printedErrors = 0;
const MAX_ERROR_PRINTS = 20;

function addError(reason) {
  errorStats.set(reason, (errorStats.get(reason) || 0) + 1);
  if (printedErrors < MAX_ERROR_PRINTS) {
    console.log(`FAIL ${reason}`);
    printedErrors++;
  }
}

function cleanError(error) {
  return String(error)
    .replace(/\r/g, ' ')
    .replace(/\n+/g, ' ')
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<uuid>')
    .slice(0, 500);
}

/**
 * TCP reachability + raw handshake latency. This is a cheap prefilter only — it decides
 * whether a server is even worth spending a whole Xray process on, and whether it's cheaply
 * disqualified for being slow at the network level. The number saved to checked.json is the
 * REAL proxied latency measured later through curl, not this one — see checkNode().
 */
function tcpCheck(host, port) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.createConnection({ host, port });
    let done = false;
    const finish = (ok, latency = null) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ ok, latency });
    };
    socket.setTimeout(TCP_TIMEOUT);
    socket.once('connect', () => finish(true, Date.now() - started));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function randomPort() {
  return 20000 + Math.floor(Math.random() * 20000);
}

/**
 * Real HTTPS request routed through the local SOCKS5 port Xray is listening on, via curl's
 * own SOCKS5+TLS implementation (mature and well-tested, rather than a hand-rolled client).
 * socks5h:// makes curl hand the hostname to the proxy to resolve, so DNS also goes through
 * the tunnel. No "direct" fallback exists anywhere in this path — if the tunnel doesn't work,
 * curl fails.
 */
function curlThroughProxy(port) {
  return new Promise((resolve) => {
    const args = [
      '--silent',
      '--show-error',
      '--location',
      '--max-time', String(Math.ceil(CURL_TIMEOUT / 1000)),
      '--connect-timeout', String(Math.min(8, Math.ceil(CURL_TIMEOUT / 1000))),
      '--proxy', `socks5h://127.0.0.1:${port}`,
      '--output', '/dev/null',
      '--write-out', '%{http_code} %{time_total}',
      TEST_URL
    ];

    execFile('curl', args, { timeout: CURL_TIMEOUT + 2000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const message = (stderr || '').trim() || error.message || 'curl failed';
        resolve({ ok: false, error: cleanError(message) });
        return;
      }

      const parts = String(stdout).trim().split(/\s+/);
      const status = Number(parts[0]);
      const timeTotal = Number(parts[1]);

      if (status >= 200 && status < 400) {
        resolve({
          ok: true,
          status,
          latency: Number.isFinite(timeTotal) ? Math.round(timeTotal * 1000) : null
        });
        return;
      }

      resolve({ ok: false, error: `HTTP ${status || 'unknown'}` });
    });
  });
}

async function checkNode(entry, xrayModule) {
  const { uri, type, host, port, outbound } = entry;
  const label = `${type} ${host}:${port}`;
  const localPort = randomPort();

  const config = xrayModule.buildCheckConfig(outbound, localPort);
  const configPath = xrayModule.writeTempConfig(config);
  let xray;

  try {
    const valid = await xrayModule.testConfig(configPath, XRAY_TIMEOUT);
    if (!valid.ok) {
      addError(`${label} XRAY CONFIG ${cleanError(valid.output)}`);
      return null;
    }

    xray = xrayModule.startXray(configPath);
    const ready = await xrayModule.waitForPort(localPort, XRAY_TIMEOUT);
    if (!ready || !xray.isAlive()) {
      const out = xray.getOutput();
      const message = out.stderr || out.stdout || 'SOCKS inbound did not start';
      addError(`${label} XRAY START ${cleanError(message)}`);
      return null;
    }

    const result = await curlThroughProxy(localPort);
    if (!result.ok) {
      addError(`${label} TRAFFIC ${result.error}`);
      return null;
    }

    const latency = result.latency ?? entry.tcpLatency;
    if (latency > MAX_LATENCY) {
      addError(`${label} LATENCY ${latency}ms (> ${MAX_LATENCY})`);
      return null;
    }

    console.log(`PASS ${latency}ms ${label} HTTP ${result.status}`);
    return { uri, latency };
  } finally {
    if (xray) await xrayModule.stopXray(xray.proc);
    xrayModule.cleanupConfig(configPath);
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (error) {
        addError(`WORKER ${cleanError(error.message)}`);
        results[i] = null;
      }
    }
  }
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

/** Dedupe by protocol:host:port identity, on top of the collector's exact-URI dedupe. */
function uniqueNodes(entries) {
  const map = new Map();
  for (const entry of entries) {
    const identity = `${entry.type}:${entry.host}:${entry.port}`;
    if (!map.has(identity)) map.set(identity, entry);
  }
  return [...map.values()];
}

async function main() {
  const { parseUri } = await import('./parser.js');
  const xrayModule = await import('./xray.js');

  if (!fs.existsSync(RAW_PATH)) {
    console.error('data/raw.json not found, run "npm run collect" first');
    process.exit(1);
  }

  const rawUris = JSON.parse(fs.readFileSync(RAW_PATH, 'utf8'));

  const parsedAll = [];
  for (const uri of rawUris) {
    const parsed = parseUri(uri);
    if (!parsed || !parsed.outbound || !parsed.host || !parsed.port) continue;
    parsedAll.push({ uri, ...parsed });
  }
  const nodes = uniqueNodes(parsedAll);
  console.log(`Unique nodes: ${nodes.length}`);

  if (nodes.length === 0) {
    console.log('No parsable sources yet — nothing to check.');
    fs.mkdirSync(path.dirname(CHECKED_PATH), { recursive: true });
    if (!fs.existsSync(CHECKED_PATH)) fs.writeFileSync(CHECKED_PATH, '[]');
    return;
  }

  const batchCount = Math.max(1, Math.ceil(nodes.length / BATCH_SIZE));
  const safeIndex = ((BATCH_INDEX % batchCount) + batchCount) % batchCount;
  const start = safeIndex * BATCH_SIZE;
  const batch = nodes.slice(start, start + BATCH_SIZE);
  console.log(`Batch: ${safeIndex + 1}/${batchCount}`);
  console.log(`Batch size: ${batch.length}`);

  const tcpResults = await mapLimit(batch, CONCURRENCY, async (entry) => {
    const result = await tcpCheck(entry.host, entry.port);
    if (!result.ok) return null;
    return { ...entry, tcpLatency: result.latency };
  });
  const alive = tcpResults.filter(Boolean);
  console.log(`TCP alive: ${alive.length}/${batch.length}`);

  const checked = await mapLimit(alive, XRAY_CONCURRENCY, (entry) => checkNode(entry, xrayModule));
  const success = checked.filter(Boolean);
  console.log(`REAL VPN alive: ${success.length}/${alive.length}`);

  if (errorStats.size) {
    console.log('\nFailure summary:');
    for (const [reason, count] of errorStats) {
      console.log(`${count}x ${reason}`);
    }
  }

  // Merge with previously known-good nodes from earlier batches/runs — with BATCH_SIZE much
  // smaller than the total node count, each run only ever re-checks a slice, so without this
  // merge the subscription would lose everything found in previous runs.
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
  for (const s of success) merged.set(s.uri, s);

  fs.mkdirSync(path.dirname(CHECKED_PATH), { recursive: true });
  fs.writeFileSync(CHECKED_PATH, JSON.stringify(Array.from(merged.values()), null, 2));
  console.log(`Saved ${merged.size} total checked nodes to ${CHECKED_PATH}`);
}

main().catch((err) => {
  console.error('CHECKER FATAL:', err);
  process.exit(1);
});
