const fs = require("fs");
const net = require("net");
const { spawn, execFile } = require("child_process");

const RAW_FILE = "data/raw.json";
const OUT_FILE = "data/checked.json";

const BATCH_SIZE = Number(process.env.BATCH_SIZE || 200);
const BATCH_INDEX = Number(process.env.BATCH_INDEX || 0);

const MAX_LATENCY = Number(process.env.MAX_LATENCY || 150);
const TCP_TIMEOUT = Number(process.env.TCP_TIMEOUT || 5000);
const XRAY_TIMEOUT = Number(process.env.XRAY_TIMEOUT || 10000);
const CURL_TIMEOUT = Number(process.env.CURL_TIMEOUT || 12000);

const CONCURRENCY = Number(process.env.CONCURRENCY || 100);
const XRAY_CONCURRENCY = Number(process.env.XRAY_CONCURRENCY || 10);

const TEST_URL = "https://www.gstatic.com/generate_204";

let uriToOutbound;
let protocolOf;

const errorStats = new Map();
let printedErrors = 0;

const MAX_ERROR_PRINTS = 20;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

function protocol(uri) {
  return protocolOf(uri);
}

function safeNodeInfo(uri) {
  try {
    if (protocol(uri) === "vmess") {
      let value = uri
        .slice(8)
        .replace(/-/g, "+")
        .replace(/_/g, "/");

      value += "=".repeat(
        (4 - value.length % 4) % 4
      );

      const data = JSON.parse(
        Buffer.from(value, "base64").toString("utf8")
      );

      return `${protocol(uri)}://${data.add}:${data.port}`;
    }

    const u = new URL(uri);

    return `${protocol(uri)}://${u.hostname}:${u.port || 443}`;
  } catch {
    return protocol(uri);
  }
}

function parseHostPort(uri) {
  try {
    if (protocol(uri) === "vmess") {
      let value = uri
        .slice(8)
        .replace(/-/g, "+")
        .replace(/_/g, "/");

      value += "=".repeat(
        (4 - value.length % 4) % 4
      );

      const data = JSON.parse(
        Buffer.from(value, "base64").toString("utf8")
      );

      if (!data.add) {
        return null;
      }

      const port = Number(data.port);

      if (
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
      ) {
        return null;
      }

      return {
        host: data.add,
        port
      };
    }

    const u = new URL(uri);

    let port = Number(u.port);

    if (!port) {
      const p = protocol(uri);

      port =
        p === "ss" ||
        p === "socks" ||
        p === "socks5"
          ? 1080
          : 443;
    }

    if (
      !u.hostname ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      return null;
    }

    return {
      host: u.hostname,
      port
    };
  } catch {
    return null;
  }
}

function tcpCheck(host, port) {
  return new Promise(resolve => {
    const started = Date.now();

    const socket = net.createConnection({
      host,
      port
    });

    let done = false;

    const finish = (ok, latency = null) => {
      if (done) {
        return;
      }

      done = true;

      socket.destroy();

      resolve({
        ok,
        latency
      });
    };

    socket.setTimeout(TCP_TIMEOUT);

    socket.once("connect", () => {
      finish(
        true,
        Date.now() - started
      );
    });

    socket.once("timeout", () => {
      finish(false);
    });

    socket.once("error", () => {
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

function buildConfig(outbound, port) {
  return {
    log: {
      loglevel: "warning"
    },

    inbounds: [
      {
        tag: "proxy-in",
        listen: "127.0.0.1",
        port,
        protocol: "socks",
        settings: {
          auth: "noauth",
          udp: false
        }
      }
    ],

    outbounds: [
      outbound,
      {
        tag: "direct",
        protocol: "freedom"
      }
    ],

    routing: {
      domainStrategy: "AsIs",

      rules: [
        {
          type: "field",
          inboundTag: [
            "proxy-in"
          ],
          outboundTag: outbound.tag
        }
      ]
    }
  };
}

function runCommand(command, args, timeout) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      stdio: [
        "ignore",
        "pipe",
        "pipe"
      ]
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) {
        return;
      }

      finished = true;

      child.kill("SIGKILL");

      resolve({
        ok: false,
        code: null,
        stdout,
        stderr: "Command timeout"
      });
    }, timeout);

    child.stdout.on("data", data => {
      stdout += data.toString();

      if (stdout.length > 12000) {
        stdout = stdout.slice(-12000);
      }
    });

    child.stderr.on("data", data => {
      stderr += data.toString();

      if (stderr.length > 12000) {
        stderr = stderr.slice(-12000);
      }
    });

    child.once("error", error => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timer);

      resolve({
        ok: false,
        code: null,
        stdout,
        stderr: error.message
      });
    });

    child.once("close", code => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timer);

      resolve({
        ok: code === 0,
        code,
        stdout,
        stderr
      });
    });
  });
}

async function validateConfig(file) {
  const result = await runCommand(
    "xray",
    [
      "run",
      "-test",
      "-config",
      file
    ],
    XRAY_TIMEOUT
  );

  if (!result.ok) {
    const message =
      result.stderr.trim() ||
      result.stdout.trim() ||
      `exit ${result.code}`;

    return {
      ok: false,
      error: cleanError(message)
    };
  }

  return {
    ok: true
  };
}

function startXray(configFile) {
  const child = spawn(
    "xray",
    [
      "run",
      "-config",
      configFile
    ],
    {
      stdio: [
        "ignore",
        "pipe",
        "pipe"
      ]
    }
  );

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", data => {
    stdout += data.toString();

    if (stdout.length > 16000) {
      stdout = stdout.slice(-16000);
    }
  });

  child.stderr.on("data", data => {
    stderr += data.toString();

    if (stderr.length > 16000) {
      stderr = stderr.slice(-16000);
    }
  });

  return {
    child,
    getOutput() {
      return {
        stdout,
        stderr
      };
    }
  };
}

function waitForPort(port, timeout) {
  return new Promise(resolve => {
    const started = Date.now();

    const attempt = () => {
      const socket = net.createConnection({
        host: "127.0.0.1",
        port
      });

      let finished = false;

      const done = ok => {
        if (finished) {
          return;
        }

        finished = true;

        socket.destroy();

        if (ok) {
          resolve(true);
          return;
        }

        if (
          Date.now() - started >=
          timeout
        ) {
          resolve(false);
          return;
        }

        setTimeout(
          attempt,
          100
        );
      };

      socket.once(
        "connect",
        () => done(true)
      );

      socket.once(
        "error",
        () => done(false)
      );

      socket.setTimeout(
        500,
        () => done(false)
      );
    };

    attempt();
  });
}

function curlThroughProxy(port) {
  return new Promise(resolve => {
    const args = [
      "--silent",
      "--show-error",
      "--location",
      "--max-time",
      String(
        Math.ceil(
          CURL_TIMEOUT / 1000
        )
      ),
      "--connect-timeout",
      String(
        Math.min(
          8,
          Math.ceil(
            CURL_TIMEOUT / 1000
          )
        )
      ),

      "--proxy",
      `socks5h://127.0.0.1:${port}`,

      "--output",
      "/dev/null",

      "--write-out",
      "%{http_code}",

      TEST_URL
    ];

    execFile(
      "curl",
      args,
      {
        timeout: CURL_TIMEOUT + 2000,
        maxBuffer: 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          const message =
            stderr.trim() ||
            error.message ||
            "curl failed";

          resolve({
            ok: false,
            error: cleanError(message)
          });

          return;
        }

        const status =
          Number(
            String(stdout).trim()
          );

        if (
          status >= 200 &&
          status < 400
        ) {
          resolve({
            ok: true,
            status
          });

          return;
        }

        resolve({
          ok: false,
          error: `HTTP ${status || "unknown"}`
        });
      }
    );
  });
}

function cleanError(error) {
  return String(error)
    .replace(/\r/g, " ")
    .replace(/\n+/g, " ")
    .replace(
      /[0-9a-f]{8}-[0-9a-f-]{27,}/gi,
      "<uuid>"
    )
    .slice(0, 500);
}

async function checkNode(uri, tcpLatency) {
  let outbound;
  let configFile;
  let xrayProcess;

  try {
    try {
      outbound =
        uriToOutbound(
          uri,
          "proxy"
        );
    } catch (error) {
      const reason =
        `PARSE ${error.message}`;

      addError(reason);

      return null;
    }

    const port = randomPort();

    const config =
      buildConfig(
        outbound,
        port
      );

    configFile =
      `/tmp/xray-check-${process.pid}-${port}.json`;

    fs.writeFileSync(
      configFile,
      JSON.stringify(
        config
      )
    );

    const valid =
      await validateConfig(
        configFile
      );

    if (!valid.ok) {
      addError(
        `XRAY CONFIG ${valid.error}`
      );

      return null;
    }

    const started =
      startXray(
        configFile
      );

    xrayProcess =
      started.child;

    const ready =
      await waitForPort(
        port,
        XRAY_TIMEOUT
      );

    if (!ready) {
      const output =
        started.getOutput();

      const error =
        output.stderr.trim() ||
        output.stdout.trim() ||
        "SOCKS inbound did not start";

      addError(
        `XRAY START ${cleanError(error)}`
      );

      return null;
    }

    const result =
      await curlThroughProxy(
        port
      );

    if (!result.ok) {
      addError(
        `TRAFFIC ${result.error}`
      );

      return null;
    }

    console.log(
      `PASS ${tcpLatency}ms ${safeNodeInfo(uri)} HTTP ${result.status}`
    );

    return {
      uri,
      latency: tcpLatency,
      tcpLatency,
      checkedAt:
        new Date().toISOString()
    };
  } finally {
    if (xrayProcess) {
      try {
        xrayProcess.kill(
          "SIGTERM"
        );
      } catch {}
    }

    if (configFile) {
      try {
        fs.unlinkSync(
          configFile
        );
      } catch {}
    }
  }
}

async function mapLimit(
  items,
  limit,
  fn
) {
  const results =
    new Array(
      items.length
    );

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
          `WORKER ${cleanError(error.message)}`
        );

        results[i] =
          null;
      }
    }
  }

  const workers =
    Math.min(
      limit,
      items.length
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

function uniqueNodes(input) {
  const map =
    new Map();

  for (const uri of input) {
    if (
      typeof uri !==
      "string"
    ) {
      continue;
    }

    const value =
      uri.trim();

    if (!value) {
      continue;
    }

    const hp =
      parseHostPort(
        value
      );

    if (!hp) {
      continue;
    }

    const identity =
      `${protocol(value)}:${hp.host}:${hp.port}`;

    if (
      !map.has(identity)
    ) {
      map.set(
        identity,
        value
      );
    }
  }

  return [
    ...map.values()
  ];
}

async function main() {
  const xray =
    await import(
      "./xray.js"
    );

  uriToOutbound =
    xray.uriToOutbound;

  protocolOf =
    xray.protocolOf;

  const raw =
    JSON.parse(
      fs.readFileSync(
        RAW_FILE,
        "utf8"
      )
    );

  const nodes =
    uniqueNodes(
      raw
    );

  const start =
    BATCH_INDEX *
    BATCH_SIZE;

  const batch =
    nodes.slice(
      start,
      start + BATCH_SIZE
    );

  console.log(
    `Unique nodes: ${nodes.length}`
  );

  console.log(
    `Batch: ${BATCH_INDEX + 1}`
  );

  console.log(
    `Batch size: ${batch.length}`
  );

  const tcpResults =
    await mapLimit(
      batch,
      CONCURRENCY,
      async uri => {
        const hp =
          parseHostPort(
            uri
          );

        if (!hp) {
          return null;
        }

        const result =
          await tcpCheck(
            hp.host,
            hp.port
          );

        if (
          !result.ok
        ) {
          return null;
        }

        if (
          result.latency >
          MAX_LATENCY
        ) {
          return null;
        }

        return {
          uri,
          latency:
            result.latency
        };
      }
    );

  const alive =
    tcpResults.filter(
      Boolean
    );

  console.log(
    `TCP alive: ${alive.length}/${batch.length}`
  );

  const checked =
    await mapLimit(
      alive,
      XRAY_CONCURRENCY,
      async node =>
        checkNode(
          node.uri,
          node.latency
        )
    );

  const success =
    checked.filter(
      Boolean
    );

  console.log(
    `REAL VPN alive: ${success.length}/${alive.length}`
  );

  if (errorStats.size) {
    console.log(
      "\nFailure summary:"
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

  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify(
      success,
      null,
      2
    )
  );

  console.log(
    `Saved ${success.length} nodes`
  );
}

main().catch(error => {
  console.error(
    error
  );

  process.exit(1);
});
