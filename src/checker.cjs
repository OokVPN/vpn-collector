const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { execFile, execFileSync } = require('node:child_process');

const RAW_PATH = path.resolve('data/raw.json');
const CHECKED_PATH = path.resolve('data/checked.json');

const MAX_LATENCY = Math.min(
  Number(process.env.MAX_LATENCY || 700),
  1000
);

const TCP_TIMEOUT = Number(
  process.env.TCP_TIMEOUT || 5000
);

const XRAY_TIMEOUT = Number(
  process.env.XRAY_TIMEOUT ||
  process.env.XRAY_START_TIMEOUT ||
  10000
);

const CURL_TIMEOUT = Number(
  process.env.CURL_TIMEOUT ||
  process.env.HTTP_TIMEOUT ||
  10000
);

const PROBE_ROUNDS = Math.max(
  3,
  Number(process.env.PROBE_ROUNDS || 3)
);

const PROBE_DELAY_MS = Math.max(
  100,
  Number(process.env.PROBE_DELAY_MS || 400)
);

const CONCURRENCY = Number(
  process.env.CONCURRENCY || 60
);

const XRAY_CONCURRENCY = Number(
  process.env.XRAY_CONCURRENCY || 6
);

const NEW_SERVER_BATCH = Number(
  process.env.NEW_SERVER_BATCH || 300
);

const MAX_REPLACEMENT_ROUNDS = Number(
  process.env.MAX_REPLACEMENT_ROUNDS || 8
);

const INTERNET_TEST_URLS = [
  'https://www.gstatic.com/generate_204',
  'https://cp.cloudflare.com/generate_204'
];

const errorStats = new Map();

let printedErrors = 0;

const MAX_ERROR_PRINTS = 50;

function addError(reason) {
  errorStats.set(
    reason,
    (errorStats.get(reason) || 0) + 1
  );

  if (printedErrors < MAX_ERROR_PRINTS) {
    console.log(`FAIL ${reason}`);
    printedErrors++;
  }
}

function cleanError(error) {
  return String(error || '')
    .replace(/\r/g, ' ')
    .replace(/\n+/g, ' ')
    .replace(
      /[0-9a-f]{8}-[0-9a-f-]{27,}/gi,
      '<uuid>'
    )
    .slice(0, 500);
}

function tcpCheck(host, port) {
  return new Promise((resolve) => {
    const started = Date.now();

    const socket = net.createConnection({
      host,
      port
    });

    let done = false;

    const finish = (ok, latency = null) => {
      if (done) return;

      done = true;

      socket.destroy();

      resolve({
        ok,
        latency
      });
    };

    socket.setTimeout(TCP_TIMEOUT);

    socket.once('connect', () => {
      finish(
        true,
        Date.now() - started
      );
    });

    socket.once('timeout', () => {
      finish(false);
    });

    socket.once('error', () => {
      finish(false);
    });
  });
}

function randomPort() {
  return (
    20000 +
    Math.floor(
      Math.random() * 20000
    )
  );
}

function curlThroughProxy(port, url) {
  return new Promise((resolve) => {
    const args = [
      '--silent',
      '--show-error',
      '--max-redirs',
      '0',

      '--connect-timeout',
      String(
        Math.max(
          3,
          Math.ceil(
            CURL_TIMEOUT / 1000
          )
        )
      ),

      '--max-time',
      String(
        Math.max(
          5,
          Math.ceil(
            CURL_TIMEOUT / 1000
          )
        )
      ),

      '--proxy',
      `socks5h://127.0.0.1:${port}`,

      '--noproxy',
      '',

      '--output',
      '/dev/null',

      '--write-out',
      '%{http_code} %{time_total}',

      url
    ];

    execFile(
      'curl',
      args,
      {
        timeout:
          CURL_TIMEOUT + 3000,

        maxBuffer:
          1024 * 1024,

        env: {
          ...process.env,

          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',

          http_proxy: '',
          https_proxy: '',
          all_proxy: ''
        }
      },
      (
        error,
        stdout,
        stderr
      ) => {
        if (error) {
          resolve({
            ok: false,

            error:
              cleanError(
                (stderr || '').trim() ||
                error.message ||
                'curl failed'
              )
          });

          return;
        }

        const parts =
          String(stdout)
            .trim()
            .split(/\s+/);

        const status =
          Number(parts[0]);

        const timeTotal =
          Number(parts[1]);

        if (status !== 204) {
          resolve({
            ok: false,

            error:
              `HTTP ${status || 'unknown'}`
          });

          return;
        }

        if (
          !Number.isFinite(
            timeTotal
          )
        ) {
          resolve({
            ok: false,

            error:
              'invalid latency'
          });

          return;
        }

        resolve({
          ok: true,

          status,

          latency:
            Math.round(
              timeTotal * 1000
            )
        });
      }
    );
  });
}

async function internetProbe(
  port,
  url
) {
  const result =
    await curlThroughProxy(
      port,
      url
    );

  if (!result.ok) {
    return {
      ok: false,
      url,
      error: result.error
    };
  }

  if (
    result.status !== 204
  ) {
    return {
      ok: false,
      url,
      error:
        `unexpected HTTP ${result.status}`
    };
  }

  return {
    ok: true,
    url,
    status: result.status,
    latency: result.latency
  };
}

async function strictInternetCheck(
  port,
  label,
  xray
) {
  const latencies = [];

  for (
    let round = 1;
    round <= PROBE_ROUNDS;
    round++
  ) {
    if (
      !xray.isAlive()
    ) {
      return {
        ok: false,
        round,
        error:
          'Xray process died'
      };
    }

    console.log(
      `PROBE ${round}/${PROBE_ROUNDS} ${label}`
    );

    for (
      const url of INTERNET_TEST_URLS
    ) {
      if (
        !xray.isAlive()
      ) {
        return {
          ok: false,
          round,
          url,
          error:
            'Xray process died during probe'
        };
      }

      const result =
        await internetProbe(
          port,
          url
        );

      if (!result.ok) {
        return {
          ok: false,
          round,
          url,
          error: result.error
        };
      }

      if (
        result.latency >
        MAX_LATENCY
      ) {
        return {
          ok: false,
          round,
          url,
          error:
            `latency ${result.latency}ms > ${MAX_LATENCY}ms`
        };
      }

      latencies.push(
        result.latency
      );

      console.log(
        `  OK ${result.latency}ms ${url}`
      );
    }

    if (
      round <
      PROBE_ROUNDS
    ) {
      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            PROBE_DELAY_MS
          )
      );
    }
  }

  if (
    latencies.length === 0
  ) {
    return {
      ok: false,
      error:
        'no successful probes'
    };
  }

  const maxLatency =
    Math.max(
      ...latencies
    );

  const averageLatency =
    Math.round(
      latencies.reduce(
        (sum, value) =>
          sum + value,
        0
      ) /
      latencies.length
    );

  return {
    ok: true,
    latency: maxLatency,
    averageLatency,
    probes: latencies.length
  };
}

async function checkNode(
  entry,
  xrayModule
) {
  const {
    uri,
    type,
    host,
    port,
    outbound
  } = entry;

  const label =
    `${type} ${host}:${port}`;

  const localPort =
    randomPort();

  const config =
    xrayModule.buildCheckConfig(
      outbound,
      localPort
    );

  const configPath =
    xrayModule.writeTempConfig(
      config
    );

  let xray;

  try {
    const valid =
      await xrayModule.testConfig(
        configPath,
        XRAY_TIMEOUT
      );

    if (!valid.ok) {
      addError(
        `${label} XRAY CONFIG ${cleanError(
          valid.output
        )}`
      );

      return null;
    }

    xray =
      xrayModule.startXray(
        configPath
      );

    const ready =
      await xrayModule.waitForPort(
        localPort,
        XRAY_TIMEOUT
      );

    if (
      !ready ||
      !xray.isAlive()
    ) {
      const out =
        xray.getOutput();

      addError(
        `${label} XRAY START ${cleanError(
          out.stderr ||
          out.stdout ||
          'SOCKS inbound did not start'
        )}`
      );

      return null;
    }

    const internet =
      await strictInternetCheck(
        localPort,
        label,
        xray
      );

    if (!internet.ok) {
      addError(
        `${label} ` +
        `PROBE ${internet.round || '?'} ` +
        `${internet.url || ''} ` +
        `${internet.error || 'failed'}`
      );

      return null;
    }

    if (
      internet.latency >
      MAX_LATENCY
    ) {
      addError(
        `${label} ` +
        `LATENCY ${internet.latency}ms ` +
        `(> ${MAX_LATENCY})`
      );

      return null;
    }

    console.log(
      `PASS ${internet.latency}ms ` +
      `(avg ${internet.averageLatency}ms) ` +
      `${label} ` +
      `${internet.probes} probes`
    );

    return {
      uri,
      latency:
        internet.latency
    };
  } finally {
    if (xray) {
      await xrayModule.stopXray(
        xray.proc
      );
    }

    xrayModule.cleanupConfig(
      configPath
    );
  }
}

async function mapLimit(
  items,
  limit,
  fn
) {
  const results =
    new Array(items.length);

  let index = 0;

  async function worker() {
    while (true) {
      const i =
        index++;

      if (
        i >= items.length
      ) {
        return;
      }

      try {
        results[i] =
          await fn(
            items[i],
            i
          );
      } catch (error) {
        addError(
          `WORKER ${cleanError(
            error.message ||
            error
          )}`
        );

        results[i] = null;
      }
    }
  }

  const workers =
    Math.max(
      1,
      Math.min(
        limit,
        items.length
      )
    );

  await Promise.all(
    Array.from(
      {
        length: workers
      },
      worker
    )
  );

  return results;
}

function uniqueByUri(
  entries
) {
  const map =
    new Map();

  for (
    const entry of entries
  ) {
    if (
      !entry ||
      !entry.uri
    ) {
      continue;
    }

    if (
      !map.has(
        entry.uri
      )
    ) {
      map.set(
        entry.uri,
        entry
      );
    }
  }

  return [
    ...map.values()
  ];
}

function readJsonArray(
  file
) {
  if (
    !fs.existsSync(file)
  ) {
    return [];
  }

  try {
    const data =
      JSON.parse(
        fs.readFileSync(
          file,
          'utf8'
        )
      );

    return Array.isArray(data)
      ? data
      : [];
  } catch {
    return [];
  }
}

function writeChecked(
  nodes
) {
  const finalNodes =
    uniqueByUri(
      nodes
    );

  finalNodes.sort(
    (a, b) =>
      a.uri.localeCompare(
        b.uri
      )
  );

  fs.mkdirSync(
    path.dirname(
      CHECKED_PATH
    ),
    {
      recursive: true
    }
  );

  fs.writeFileSync(
    CHECKED_PATH,
    JSON.stringify(
      finalNodes,
      null,
      2
    )
  );

  return finalNodes;
}

function parseNodes(
  rawUris,
  parseUri
) {
  const parsed = [];

  for (
    const uri of rawUris
  ) {
    try {
      const item =
        parseUri(uri);

      if (
        !item ||
        !item.outbound ||
        !item.host ||
        !item.port
      ) {
        continue;
      }

      parsed.push({
        uri,
        ...item
      });
    } catch {
      continue;
    }
  }

  return uniqueByUri(
    parsed
  );
}

async function checkNodes(
  nodes,
  parseUri,
  xrayModule
) {
  if (
    nodes.length === 0
  ) {
    return [];
  }

  const parsed = [];

  for (
    const entry of nodes
  ) {
    try {
      const uri =
        entry.uri ||
        entry;

      const item =
        parseUri(uri);

      if (
        !item ||
        !item.outbound ||
        !item.host ||
        !item.port
      ) {
        addError(
          `PARSE ${String(uri).slice(0, 100)}`
        );

        continue;
      }

      parsed.push({
        uri,
        ...item
      });
    } catch (error) {
      addError(
        `PARSE ${cleanError(
          error.message ||
          error
        )}`
      );
    }
  }

  const unique =
    uniqueByUri(
      parsed
    );

  console.log(
    `Parsed unique nodes: ${unique.length}`
  );

  const tcpResults =
    await mapLimit(
      unique,
      CONCURRENCY,
      async (entry) => {
        const result =
          await tcpCheck(
            entry.host,
            entry.port
          );

        if (!result.ok) {
          addError(
            `TCP ${entry.host}:${entry.port}`
          );

          return null;
        }

        if (
          result.latency >
          MAX_LATENCY
        ) {
          addError(
            `TCP SLOW ` +
            `${entry.host}:${entry.port} ` +
            `${result.latency}ms`
          );

          return null;
        }

        return {
          ...entry,
          tcpLatency:
            result.latency
        };
      }
    );

  const alive =
    tcpResults.filter(
      Boolean
    );

  console.log(
    `TCP passed: ` +
    `${alive.length}/${unique.length}`
  );

  const checked =
    await mapLimit(
      alive,
      XRAY_CONCURRENCY,
      (entry) =>
        checkNode(
          entry,
          xrayModule
        )
    );

  const passed =
    checked.filter(
      Boolean
    );

  console.log(
    `STRICT CHECK PASSED: ` +
    `${passed.length}/${unique.length}`
  );

  return passed;
}

function collectSources() {
  console.log(
    'Collecting fresh server sources...'
  );

  try {
    execFileSync(
      process.platform === 'win32'
        ? 'npm.cmd'
        : 'npm',
      [
        'run',
        'collect'
      ],
      {
        stdio: 'inherit',
        timeout: 180000
      }
    );

    return true;
  } catch (error) {
    console.error(
      'Collect failed:',
      cleanError(
        error.message ||
        error
      )
    );

    return false;
  }
}

function printFailureSummary() {
  if (
    errorStats.size === 0
  ) {
    return;
  }

  console.log(
    '\n========== FAILURE SUMMARY =========='
  );

  const sorted =
    [...errorStats.entries()]
      .sort(
        (a, b) =>
          b[1] - a[1]
      );

  for (
    const [
      reason,
      count
    ] of sorted
  ) {
    console.log(
      `${count}x ${reason}`
    );
  }

  console.log(
    '=====================================\n'
  );
}

async function main() {
  const {
    parseUri
  } = await import(
    './parser.js'
  );

  const xrayModule =
    await import(
      './xray.js'
    );

  const existing =
    readJsonArray(
      CHECKED_PATH
    );

  console.log(
    `Currently tracked working nodes: ` +
    `${existing.length}`
  );

  let workingExisting = [];

  if (
    existing.length > 0
  ) {
    console.log(
      'Re-checking ALL existing nodes with strict probes...'
    );

    workingExisting =
      await checkNodes(
        existing,
        parseUri,
        xrayModule
      );

    console.log(
      `Still working: ` +
      `${workingExisting.length}/${existing.length}`
    );
  }

  const deadCount =
    Math.max(
      0,
      existing.length -
      workingExisting.length
    );

  console.log(
    `Dead/failed nodes: ${deadCount}`
  );

  if (
    deadCount === 0 &&
    existing.length > 0
  ) {
    writeChecked(
      workingExisting
    );

    console.log(
      'No dead nodes detected.'
    );

    console.log(
      `Saved ${workingExisting.length} strictly verified nodes.`
    );

    printFailureSummary();

    return;
  }

  const needed =
    Math.max(
      1,
      deadCount
    );

  console.log(
    `Need at least ${needed} replacement node(s).`
  );

  const knownUris =
    new Set(
      workingExisting.map(
        (node) =>
          node.uri
      )
    );

  let allWorking =
    [...workingExisting];

  let replacements = 0;

  for (
    let round = 1;
    round <= MAX_REPLACEMENT_ROUNDS;
    round++
  ) {
    console.log(
      `Replacement search round ` +
      `${round}/${MAX_REPLACEMENT_ROUNDS}`
    );

    const collected =
      collectSources();

    if (!collected) {
      break;
    }

    const rawUris =
      readJsonArray(
        RAW_PATH
      );

    const candidates =
      parseNodes(
        rawUris,
        parseUri
      ).filter(
        (node) =>
          !knownUris.has(
            node.uri
          )
      );

    console.log(
      `Fresh unique candidates: ` +
      `${candidates.length}`
    );

    if (
      candidates.length === 0
    ) {
      console.log(
        'No new candidates found.'
      );

      break;
    }

    const batchSize =
      Math.max(
        NEW_SERVER_BATCH,
        needed * 20
      );

    const limitedCandidates =
      candidates.slice(
        0,
        batchSize
      );

    console.log(
      `Checking new candidates: ` +
      `${limitedCandidates.length}`
    );

    const newWorking =
      await checkNodes(
        limitedCandidates,
        parseUri,
        xrayModule
      );

    for (
      const node of newWorking
    ) {
      if (
        knownUris.has(
          node.uri
        )
      ) {
        continue;
      }

      knownUris.add(
        node.uri
      );

      allWorking.push(
        node
      );

      replacements++;
    }

    console.log(
      `Strictly verified replacements: ` +
      `${replacements}/${needed}`
    );

    if (
      replacements >= needed
    ) {
      break;
    }
  }

  allWorking =
    uniqueByUri(
      allWorking
    );

  writeChecked(
    allWorking
  );

  console.log(
    `Final strictly verified nodes: ` +
    `${allWorking.length}`
  );

  console.log(
    `Removed dead nodes: ${deadCount}`
  );

  console.log(
    `Added replacements: ${replacements}`
  );

  if (
    replacements < needed
  ) {
    console.log(
      `Replacement deficit: ` +
      `${needed - replacements}`
    );
  }

  printFailureSummary();
}

main().catch(
  (err) => {
    console.error(
      'CHECKER FATAL:',
      err
    );

    process.exit(1);
  }
);
