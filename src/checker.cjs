const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

const RAW_PATH = path.resolve('data/raw.json');
const CHECKED_PATH = path.resolve('data/checked.json');
const MAX_LATENCY = Math.min(Number(process.env.MAX_LATENCY || 700), 1000);
const XRAY_TIMEOUT = Number(process.env.XRAY_TIMEOUT || process.env.XRAY_START_TIMEOUT || 10000);
const CURL_TIMEOUT = Number(process.env.CURL_TIMEOUT || process.env.HTTP_TIMEOUT || 10000);
const XRAY_CONCURRENCY = Math.max(1, Number(process.env.XRAY_CONCURRENCY || 6));
const NEW_SERVER_BATCH = Math.max(1, Number(process.env.NEW_SERVER_BATCH || 300));
const MAX_REPLACEMENT_ROUNDS = Math.max(1, Number(process.env.MAX_REPLACEMENT_ROUNDS || 8));
const PROBE_ROUNDS = Math.max(1, Math.min(5, Number(process.env.PROBE_ROUNDS || 3)));
const PROBE_DELAY_MS = Math.max(0, Number(process.env.PROBE_DELAY_MS || 250));
const INTERNET_TEST_URLS = (process.env.CHECK_URLS || 'https://cp.cloudflare.com/generate_204,https://www.gstatic.com/generate_204')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => /^https:\/\//i.test(value));

const errorStats = new Map();
let printedErrors = 0;
const MAX_ERROR_PRINTS = 50;

function addError(reason) {
  errorStats.set(reason, (errorStats.get(reason) || 0) + 1);
  if (printedErrors < MAX_ERROR_PRINTS) {
    console.log(`FAIL ${reason}`);
    printedErrors++;
  }
}

function cleanError(error) {
  return String(error || '')
    .replace(/\r/g, ' ')
    .replace(/\n+/g, ' ')
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<uuid>')
    .slice(0, 500);
}

function randomPort() {
  return 20000 + Math.floor(Math.random() * 20000);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function proxyGetKeepAlive(port, url) {
  return new Promise((resolve) => {
    const timeoutSeconds = Math.max(2, Math.ceil(CURL_TIMEOUT / 1000));
    const marker = '__GET_RESULT__';
    const writeOut = '\\n' + marker + '%{http_code}|%{time_total}|%{num_connects}\\n';
    const args = [
      '--silent',
      '--show-error',
      '--http1.1',
      '--connect-timeout', String(timeoutSeconds),
      '--max-time', String(timeoutSeconds),
      '--proxy', 'http://127.0.0.1:' + port,
      '--noproxy', '',
      '--header', 'Connection: keep-alive',
      '--output', '/dev/null',
      '--write-out', writeOut,
      url,
      url
    ];

    execFile('curl', args, {
      timeout: CURL_TIMEOUT * 2 + 5000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
        http_proxy: '',
        https_proxy: '',
        all_proxy: ''
      }
    }, (error, stdout, stderr) => {
      const output = String(stdout || '');
      const matcher = new RegExp(marker + '(\\d{3})\\|([0-9.]+)\\|(\\d+)', 'g');
      const records = [...output.matchAll(matcher)].map((match) => ({
        status: Number(match[1]),
        seconds: Number(match[2]),
        connections: Number(match[3])
      }));

      const validStatus = (status) =>
        Number.isInteger(status) && status >= 200 && status < 600;
      const validTiming = (record) =>
        record && Number.isFinite(record.seconds) && record.seconds >= 0;

      if (records.length === 0) {
        resolve({
          ok: false,
          reachable: false,
          error: cleanError(String(stderr || '').trim() || (error && error.message) || 'curl returned no HTTP response')
        });
        return;
      }

      const [first, second] = records;
      const firstValid = validStatus(first.status) && validTiming(first);
      const secondValid = validStatus(second && second.status) && validTiming(second);

      if (!firstValid && !secondValid) {
        resolve({
          ok: false,
          reachable: false,
          error: 'No valid HTTP response; statuses ' +
            (first ? first.status : 'missing') + '/' +
            (second ? second.status : 'missing') +
            (error ? '; ' + cleanError(String(stderr || '').trim() || error.message) : '')
        });
        return;
      }

      const usable = [first, second].filter((record) =>
        validStatus(record && record.status) && validTiming(record)
      );
      const latestResponse = usable[usable.length - 1];
      const firstLatency = firstValid ? Math.round(first.seconds * 1000) : null;
      const latency = Math.round(latestResponse.seconds * 1000);
      const firstStatus = first ? first.status : 0;
      const secondStatus = second ? second.status : 0;

      if (firstValid && secondValid && second.connections === 0) {
        resolve({
          ok: true,
          reachable: true,
          keepAlive: true,
          firstStatus,
          secondStatus,
          firstLatency,
          latency,
          firstConnections: first.connections,
          secondConnections: second.connections
        });
        return;
      }

      resolve({
        ok: false,
        reachable: true,
        keepAlive: false,
        firstStatus,
        secondStatus,
        firstLatency,
        latency,
        error: records.length < 2
          ? 'Only one HTTP response received; Keep-Alive could not be measured'
          : 'HTTP response received, but the second GET did not reuse the connection (opened ' +
            second.connections + ' new connection(s))'
      });
    });
  });
}

async function strictInternetCheck(port, label, xray) {
  let lastError = 'no test URLs configured';
  const fallbackSamples = [];

  for (const url of INTERNET_TEST_URLS) {
    const keepAliveSamples = [];
    const initialLatencies = [];
    let endpointFailedBeforeResponse = false;

    for (let attempt = 1; attempt <= PROBE_ROUNDS; attempt++) {
      if (!xray.isAlive()) {
        return { ok: false, url, error: 'Xray process died' };
      }

      console.log('GET+KEEPALIVE ' + label + ' ' + url + ' attempt ' +
        attempt + '/' + PROBE_ROUNDS);
      const result = await proxyGetKeepAlive(port, url);

      if (result.ok) {
        keepAliveSamples.push(result.latency);
        if (Number.isFinite(result.firstLatency)) {
          initialLatencies.push(result.firstLatency);
        }
        console.log('  GET 1 HTTP ' + result.firstStatus + ' ' +
          result.firstLatency + 'ms');
        console.log('  GET 2 HTTP ' + result.secondStatus + ' ' +
          result.latency + 'ms; connection reused');
      } else if (result.reachable) {
        fallbackSamples.push({ url, latency: result.latency });
        lastError = result.error;
        console.log('  HTTP response received, but Keep-Alive could not be confirmed: ' +
          result.error);
        break;
      } else {
        lastError = result.error;
        endpointFailedBeforeResponse = true;
        console.log('  FAIL ' + url + ': ' + result.error);
        if (keepAliveSamples.length === 0) break;
      }

      if (attempt < PROBE_ROUNDS) await delay(PROBE_DELAY_MS);
    }

    if (keepAliveSamples.length > 0) {
      const latency = median(keepAliveSamples);
      if (latency <= MAX_LATENCY) {
        return {
          ok: true,
          url,
          latency,
          firstLatency: median(initialLatencies),
          keepAlive: true,
          samples: keepAliveSamples.length
        };
      }

      lastError = 'median keep-alive latency ' + latency + 'ms > ' + MAX_LATENCY + 'ms';
      console.log('  FAIL ' + url + ': ' + lastError +
        ' (samples: ' + keepAliveSamples.join(', ') + 'ms)');
    } else if (endpointFailedBeforeResponse) {
      console.log('  Moving to the next test URL.');
    }
  }

  if (fallbackSamples.length > 0) {
    const latency = median(fallbackSamples.map((sample) => sample.latency));
    if (latency <= MAX_LATENCY) {
      const fallback = fallbackSamples.find((sample) => sample.latency === latency) || fallbackSamples[0];
      console.log('  Keep-Alive was inconclusive; using successful GET response as fallback.');
      return {
        ok: true,
        url: fallback.url,
        latency,
        firstLatency: null,
        keepAlive: false,
        samples: fallbackSamples.length
      };
    }

    lastError = 'fallback GET latency ' + latency + 'ms > ' + MAX_LATENCY + 'ms';
  }

  return { ok: false, error: lastError };
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
      const output = xray.getOutput();
      addError(`${label} XRAY START ${cleanError(output.stderr || output.stdout || 'HTTP inbound did not start')}`);
      return null;
    }

    const internet = await strictInternetCheck(localPort, label, xray);
    if (!internet.ok) {
      addError(`${label} HTTP GET ${internet.url || ''} ${internet.error || 'failed'}`);
      return null;
    }

    console.log('PASS ' + internet.latency + 'ms ' + (internet.keepAlive ? 'keep-alive' : 'GET fallback (Keep-Alive inconclusive)') + (Number.isFinite(internet.firstLatency) ? ' (initial ' + internet.firstLatency + 'ms)' : '') + ' ' + label);
    return { uri, latency: internet.latency };
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
      const current = index++;
      if (current >= items.length) return;
      try {
        results[current] = await fn(items[current], current);
      } catch (error) {
        addError(`WORKER ${cleanError(error.message || error)}`);
        results[current] = null;
      }
    }
  }

  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

function uniqueByUri(entries) {
  const values = new Map();
  for (const entry of entries) {
    if (!entry || !entry.uri || values.has(entry.uri)) continue;
    values.set(entry.uri, entry);
  }
  return [...values.values()];
}

function readJsonArray(file) {
  if (!fs.existsSync(file)) return [];
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeChecked(nodes) {
  const finalNodes = uniqueByUri(nodes).sort((a, b) => a.uri.localeCompare(b.uri));
  fs.mkdirSync(path.dirname(CHECKED_PATH), { recursive: true });
  fs.writeFileSync(CHECKED_PATH, JSON.stringify(finalNodes, null, 2));
  return finalNodes;
}

function parseNodes(rawUris, parseUri) {
  const parsed = [];
  for (const uri of rawUris) {
    try {
      const item = parseUri(uri);
      if (!item || !item.outbound || !item.host || !item.port) continue;
      parsed.push({ uri, ...item });
    } catch {}
  }
  return uniqueByUri(parsed);
}

async function checkNodes(nodes, parseUri, xrayModule) {
  if (nodes.length === 0) return [];
  const parsed = [];

  for (const entry of nodes) {
    try {
      const uri = entry.uri || entry;
      const item = parseUri(uri);
      if (!item || !item.outbound || !item.host || !item.port) {
        addError(`PARSE ${String(uri).slice(0, 100)}`);
        continue;
      }
      parsed.push({ uri, ...item });
    } catch (error) {
      addError(`PARSE ${cleanError(error.message || error)}`);
    }
  }

  const unique = uniqueByUri(parsed);
  console.log(`Parsed unique nodes: ${unique.length}`);

  const checked = await mapLimit(unique, XRAY_CONCURRENCY, (entry) => checkNode(entry, xrayModule));
  const passed = checked.filter(Boolean);
  console.log(`STRICT CHECK PASSED: ${passed.length}/${unique.length}`);
  return passed;
}

function collectSources() {
  console.log('Collecting fresh server sources...');
  try {
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'collect'], {
      stdio: 'inherit',
      timeout: 180000
    });
    return true;
  } catch (error) {
    console.error('Collect failed:', cleanError(error.message || error));
    return false;
  }
}

function printFailureSummary() {
  if (errorStats.size === 0) return;
  console.log('\n========== FAILURE SUMMARY ==========');
  const sorted = [...errorStats.entries()].sort((a, b) => b[1] - a[1]);
  for (const [reason, count] of sorted) console.log(`${count}x ${reason}`);
  console.log('=====================================\n');
}

async function main() {
  const { parseUri } = await import('./parser.js');
  const xrayModule = await import('./xray.js');
  const existing = readJsonArray(CHECKED_PATH);

  console.log(`Currently tracked working nodes: ${existing.length}`);
  let workingExisting = [];

  if (existing.length > 0) {
    console.log('Re-checking all existing nodes with HTTP GET + Keep-Alive...');
    workingExisting = await checkNodes(existing, parseUri, xrayModule);
    console.log(`Still working: ${workingExisting.length}/${existing.length}`);
  }

  const deadCount = Math.max(0, existing.length - workingExisting.length);
  console.log(`Dead/failed nodes: ${deadCount}`);

  if (deadCount === 0 && existing.length > 0) {
    writeChecked(workingExisting);
    console.log('No dead nodes detected.');
    console.log(`Saved ${workingExisting.length} strictly verified nodes.`);
    printFailureSummary();
    return;
  }

  const needed = Math.max(1, deadCount);
  console.log(`Need at least ${needed} replacement node(s).`);
  const knownUris = new Set(
    [...existing, ...workingExisting]
      .map((node) => (node && typeof node === 'object' ? node.uri : node))
      .filter((uri) => typeof uri === 'string' && uri.length > 0)
  );
  let allWorking = [...workingExisting];
  let replacements = 0;

  for (let round = 1; round <= MAX_REPLACEMENT_ROUNDS; round++) {
    console.log(`Replacement search round ${round}/${MAX_REPLACEMENT_ROUNDS}`);
    if (!collectSources()) break;

    const rawUris = readJsonArray(RAW_PATH);
    const candidates = parseNodes(rawUris, parseUri).filter((node) => !knownUris.has(node.uri));
    console.log(`Fresh unique candidates: ${candidates.length}`);
    if (candidates.length === 0) {
      console.log('No new candidates found.');
      break;
    }

    const batchSize = Math.max(NEW_SERVER_BATCH, needed * 20);
    const limitedCandidates = candidates.slice(0, batchSize);
    console.log(`Checking new candidates: ${limitedCandidates.length}`);
    for (const candidate of limitedCandidates) knownUris.add(candidate.uri);

    const newWorking = await checkNodes(limitedCandidates, parseUri, xrayModule);
    const workingUris = new Set(allWorking.map((node) => node.uri));

    for (const node of newWorking) {
      if (workingUris.has(node.uri)) continue;
      workingUris.add(node.uri);
      allWorking.push(node);
      replacements++;
    }

    console.log(`Strictly verified replacements: ${replacements}/${needed}`);
    if (replacements >= needed) break;
  }

  allWorking = uniqueByUri(allWorking);
  writeChecked(allWorking);
  console.log(`Final strictly verified nodes: ${allWorking.length}`);
  console.log(`Removed dead nodes: ${deadCount}`);
  console.log(`Added replacements: ${replacements}`);
  if (replacements < needed) console.log(`Replacement deficit: ${needed - replacements}`);
  printFailureSummary();
}

main().catch((error) => {
  console.error('CHECKER FATAL:', error);
  process.exit(1);
});
