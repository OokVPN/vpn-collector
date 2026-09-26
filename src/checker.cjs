const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { execFile, execFileSync } = require('node:child_process');

const RAW_PATH = path.resolve('data/raw.json');
const CHECKED_PATH = path.resolve('data/checked.json');

const MAX_LATENCY = Math.min(
  Number(process.env.MAX_LATENCY || 1000),
  1000
);

const TCP_TIMEOUT = Number(process.env.TCP_TIMEOUT || 5000);

const XRAY_TIMEOUT = Number(
  process.env.XRAY_TIMEOUT ||
  process.env.XRAY_START_TIMEOUT ||
  10000
);

const CURL_TIMEOUT = Number(
  process.env.CURL_TIMEOUT ||
  process.env.HTTP_TIMEOUT ||
  12000
);

const CONCURRENCY = Number(process.env.CONCURRENCY || 100);
const XRAY_CONCURRENCY = Number(process.env.XRAY_CONCURRENCY || 8);

const NEW_SERVER_BATCH = Number(
  process.env.NEW_SERVER_BATCH || 200
);

const MAX_REPLACEMENT_ROUNDS = Number(
  process.env.MAX_REPLACEMENT_ROUNDS || 5
);

const INTERNET_TEST_URLS = [
  'https://www.gstatic.com/generate_204',
  'https://cp.cloudflare.com/generate_204'
];

const errorStats = new Map();
let printedErrors = 0;

const MAX_ERROR_PRINTS = 30;

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
  return String(error)
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
    Math.floor(Math.random() * 20000)
  );
}

function curlThroughProxy(port, url) {
  return new Promise((resolve) => {
    const args = [
      '--silent',
      '--show-error',
      '--location',
      '--max-redirs',
      '3',
      '--max-time',
      String(
        Math.ceil(
          CURL_TIMEOUT / 1000
        )
      ),
      '--connect-timeout',
      String(
        Math.min(
          8,
          Math.ceil(
            CURL_TIMEOUT / 1000
          )
        )
      ),
      '--proxy',
      `socks5h://127.0.0.1:${port}`,
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
          CURL_TIMEOUT + 2000,

        maxBuffer:
          1024 * 1024
      },
      (
        error,
        stdout,
        stderr
      ) => {
        if (error) {
          const message =
            (stderr || '').trim() ||
            error.message ||
            'curl failed';

          resolve({
            ok: false,
            error: cleanError(message)
          });

          return;
        }

        const parts = String(stdout)
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

        resolve({
          ok: true,
          status,
          latency:
            Number.isFinite(timeTotal)
              ? Math.round(
                  timeTotal * 1000
                )
              : null
        });
      }
    );
  });
}

async function internetThroughProxy(port) {
  let lastError =
    'all internet tests failed';

  for (
    const url of INTERNET_TEST_URLS
  ) {
    const result =
      await curlThroughProxy(
        port,
        url
      );

    if (result.ok) {
      return {
        ...result,
        url
      };
    }

    lastError =
      `${url}: ${result.error}`;
  }

  return {
    ok: false,
    error: lastError
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

      const message =
        out.stderr ||
        out.stdout ||
        'SOCKS inbound did not start';

      addError(
        `${label} XRAY START ${cleanError(
          message
        )}`
      );

      return null;
    }

    const internet =
      await internetThroughProxy(
        localPort
      );

    if (!internet.ok) {
      addError(
        `${label} INTERNET ${internet.error}`
      );

      return null;
    }

    const latency =
      internet.latency ??
      entry.tcpLatency;

    if (
      typeof latency === 'number' &&
      latency > MAX_LATENCY
    ) {
      addError(
        `${label} LATENCY ${latency}ms (> ${MAX_LATENCY})`
      );

      return null;
    }

    console.log(
      `PASS ${latency}ms ${label} ` +
      `HTTP ${internet.status} ` +
      `${internet.url}`
    );

    return {
      uri,
      latency
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
      const i = index++;

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

function uniqueByUri(entries) {
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
      !map.has(entry.uri)
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

function readJsonArray(file) {
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

function writeChecked(nodes) {
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

  const parsed =
    [];

  for (
    const entry of nodes
  ) {
    const item =
      parseUri(entry.uri || entry);

    if (
      !item ||
      !item.outbound ||
      !item.host ||
      !item.port
    ) {
      continue;
    }

    parsed.push({
      uri:
        entry.uri || entry,
      ...item
    });
  }

  const unique =
    uniqueByUri(
      parsed
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
    `TCP alive: ${alive.length}/${unique.length}`
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

  return checked.filter(
    Boolean
  );
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
    `Currently tracked working nodes: ${existing.length}`
  );

  let workingExisting = [];

  if (
    existing.length > 0
  ) {
    console.log(
      'Re-checking ALL currently working nodes...'
    );

    workingExisting =
      await checkNodes(
        existing,
        parseUri,
        xrayModule
      );

    console.log(
      `Still working: ${workingExisting.length}/${existing.length}`
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
      `Saved ${workingExisting.length} working nodes.`
    );

    if (
      errorStats.size
    ) {
      console.log(
        '\nFailure summary:'
      );

      for (
        const [
          reason,
          count
        ] of errorStats
      ) {
        console.log(
          `${count}x ${reason}`
        );
      }
    }

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
        (node) => node.uri
      )
    );

  let allWorking =
    [...workingExisting];

  let replacements =
    0;

  for (
    let round = 1;
    round <= MAX_REPLACEMENT_ROUNDS;
    round++
  ) {
    console.log(
      `Replacement search round ${round}/${MAX_REPLACEMENT_ROUNDS}`
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
      `Fresh unique candidates: ${candidates.length}`
    );

    if (
      candidates.length === 0
    ) {
      console.log(
        'No new candidates found.'
      );

      break;
    }

    const limitedCandidates =
      candidates.slice(
        0,
        Math.max(
          NEW_SERVER_BATCH,
          needed * 10
        )
      );

    console.log(
      `Checking new candidates: ${limitedCandidates.length}`
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
      `Working replacements found: ${replacements}/${needed}`
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
    `Final working nodes: ${allWorking.length}`
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
      `Replacement deficit: ${needed - replacements}`
    );
  }

  if (
    errorStats.size
  ) {
    console.log(
      '\nFailure summary:'
    );

    for (
      const [
        reason,
        count
      ] of errorStats
    ) {
      console.log(
        `${count}x ${reason}`
      );
    }
  }
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
