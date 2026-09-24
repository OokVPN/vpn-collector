const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');

const RAW_PATH = path.resolve('data/raw.json');
const CHECKED_PATH = path.resolve('data/checked.json');

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '200', 10);
const BATCH_INDEX = parseInt(process.env.BATCH_INDEX || '0', 10);
const MAX_LATENCY = parseInt(process.env.MAX_LATENCY || '150', 10);
const TCP_TIMEOUT = parseInt(process.env.TCP_TIMEOUT || '5000', 10);
const HTTP_TIMEOUT = parseInt(process.env.HTTP_TIMEOUT || '7000', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '100', 10);
const XRAY_CONCURRENCY = parseInt(process.env.XRAY_CONCURRENCY || '10', 10);

const CHECK_TARGET_HOST = 'www.gstatic.com';
const CHECK_TARGET_PORT = 443;
const CHECK_TARGET_PATH = '/generate_204';

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

// Minimal no-auth SOCKS5 CONNECT handshake, implemented directly on top of net.Socket.
// This is the tunnel the HTTPS check is sent through — there is no "direct" fallback.
function socks5Connect(socksPort, targetHost, targetPort, timeout) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: socksPort });
    let stage = 0;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('SOCKS_TIMEOUT'));
    }, timeout);

    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    socket.on('connect', () => {
      socket.write(Buffer.from([0x05, 0x01, 0x00])); // ver 5, 1 method, no-auth
    });

    socket.on('data', (data) => {
      if (stage === 0) {
        if (data[0] !== 0x05 || data[1] !== 0x00) {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error('SOCKS_AUTH_FAIL'));
          return;
        }
        const hostBuf = Buffer.from(targetHost, 'utf8');
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
          hostBuf,
          Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff])
        ]);
        stage = 1;
        socket.write(req);
      } else if (stage === 1) {
        if (data[0] !== 0x05 || data[1] !== 0x00) {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error('SOCKS_CONNECT_FAIL_' + data[1]));
          return;
        }
        clearTimeout(timer);
        socket.removeAllListeners('data');
        resolve(socket);
      }
    });
  });
}

function httpsThroughSocks(socksPort, targetHost, targetPort, timeout) {
  return new Promise((resolve, reject) => {
    socks5Connect(socksPort, targetHost, targetPort, timeout)
      .then((rawSocket) => {
        const timer = setTimeout(() => {
          rawSocket.destroy();
          reject(new Error('PROXY_REQUEST_TIMEOUT'));
        }, timeout);

        let settled = false;
        const tlsSocket = tls.connect({ socket: rawSocket, servername: targetHost, timeout }, () => {
          const req =
            `GET ${CHECK_TARGET_PATH} HTTP/1.1\r\n` +
            `Host: ${targetHost}\r\n` +
            `User-Agent: vpn-collector\r\n` +
            `Connection: close\r\n\r\n`;
          tlsSocket.write(req);
        });

        let buffer = '';
        tlsSocket.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          const match = buffer.match(/^HTTP\/\d\.\d (\d{3})/);
          if (match && !settled) {
            settled = true;
            clearTimeout(timer);
            const status = parseInt(match[1], 10);
            tlsSocket.destroy();
            resolve(status);
          }
        });
        tlsSocket.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
        tlsSocket.on('close', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error('PROXY_REQUEST_CLOSED'));
        });
      })
      .catch(reject);
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
    const ready = await xrayModule.waitForPort(localPort, 4000);
    if (!ready || !xray.isAlive()) {
      console.log(`${label} XRAY START FAIL`);
      return { status: 'XRAY_START_FAIL' };
    }
    console.log(`${label} XRAY PASS`);
    console.log(`${label} SOCKS PASS`);

    const start = Date.now();
    let httpStatus;
    try {
      httpStatus = await httpsThroughSocks(localPort, CHECK_TARGET_HOST, CHECK_TARGET_PORT, HTTP_TIMEOUT);
    } catch (err) {
      console.log(`${label} PROXY HTTPS FAIL (${err.message})`);
      return { status: 'PROXY_REQUEST_FAIL' };
    }
    const latency = Date.now() - start;

    if (httpStatus < 200 || httpStatus >= 300) {
      console.log(`${label} PROXY HTTPS FAIL (HTTP ${httpStatus})`);
      return { status: 'HTTP_FAIL' };
    }
    console.log(`${label} PROXY HTTPS PASS`);

    if (latency > MAX_LATENCY) {
      console.log(`${label} LATENCY ${latency} ms FAIL (> ${MAX_LATENCY})`);
      return { status: 'LATENCY_FAIL' };
    }
    console.log(`${label} LATENCY ${latency} ms`);
    console.log(`${label} PASS`);
    return { status: 'PASS', latency };
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
  const passed = [];
  let liveCount = 0;
  const basePort = 20000;
  let portCounter = 0;

  await pool(tcpPassed, XRAY_CONCURRENCY, async (entry) => {
    const localPort = basePort + (portCounter++ % (XRAY_CONCURRENCY * 4));
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
