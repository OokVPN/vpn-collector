const fs = require("fs");
const net = require("net");
const { spawn, execFile } = require("child_process");

const RAW_FILE = "data/raw.json";
const OUT_FILE = "data/checked.json";

const TARGET = Number(process.env.TARGET_NODES || 200);
const BATCH_SIZE = Number(process.env.CHECK_BATCH_SIZE || 200);

const MAX_PROXY_LATENCY = Number(
  process.env.MAX_PROXY_LATENCY || 200
);

const TCP_TIMEOUT = Number(
  process.env.TCP_TIMEOUT || 5000
);

const XRAY_TIMEOUT = Number(
  process.env.XRAY_TIMEOUT || 10000
);

const CURL_TIMEOUT = Number(
  process.env.CURL_TIMEOUT || 7000
);

const CONCURRENCY = Number(
  process.env.CONCURRENCY || 100
);

const GEO_CONCURRENCY = Number(
  process.env.GEO_CONCURRENCY || 10
);

const XRAY_CONCURRENCY = Number(
  process.env.XRAY_CONCURRENCY || 10
);

const PING_URL =
  "https://www.gstatic.com/generate_204";

const IP_URL =
  "https://api.ipify.org";

let uriToOutbound;
let protocolOf;
let resolveGeo;

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
  return String(error || "")
    .replace(/\r/g, " ")
    .replace(/\n+/g, " ")
    .slice(0, 500);
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
        Buffer
          .from(value, "base64")
          .toString("utf8")
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
        Buffer
          .from(value, "base64")
          .toString("utf8")
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

    const finish = (
      ok,
      latency = null
    ) => {
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

    socket.setTimeout(
      TCP_TIMEOUT
    );

    socket.once(
      "connect",
      () =>
        finish(
          true,
          Date.now() - started
        )
    );

    socket.once(
      "timeout",
      () => finish(false)
    );

    socket.once(
      "error",
      () => finish(false)
    );
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

function buildConfig(
  outbound,
  port
) {
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
          udp: true
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

          outboundTag:
            outbound.tag
        }
      ]
    }
  };
}

function runCommand(
  command,
  args,
  timeout
) {
  return new Promise(resolve => {
    const child = spawn(
      command,
      args,
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
    let finished = false;

    const timer = setTimeout(
      () => {
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
      },
      timeout
    );

    child.stdout.on(
      "data",
      data => {
        stdout += data.toString();

        if (stdout.length > 12000) {
          stdout =
            stdout.slice(-12000);
        }
      }
    );

    child.stderr.on(
      "data",
      data => {
        stderr += data.toString();

        if (stderr.length > 12000) {
          stderr =
            stderr.slice(-12000);
        }
      }
    );

    child.once(
      "error",
      error => {
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
      }
    );

    child.once(
      "close",
      code => {
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
      }
    );
  });
}

async function validateConfig(file) {
  const result =
    await runCommand(
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
    return {
      ok: false,

      error: cleanError(
        result.stderr.trim() ||
        result.stdout.trim() ||
        `exit ${result.code}`
      )
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

  child.stdout.on(
    "data",
    data => {
      stdout += data.toString();

      if (stdout.length > 16000) {
        stdout =
          stdout.slice(-16000);
      }
    }
  );

  child.stderr.on(
    "data",
    data => {
      stderr += data.toString();

      if (stderr.length > 16000) {
        stderr =
          stderr.slice(-16000);
      }
    }
  );

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

function waitForPort(
  port,
  timeout
) {
  return new Promise(resolve => {
    const started = Date.now();

    const attempt = () => {
      const socket =
        net.createConnection({
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

function curlProxy(
  port,
  url,
  extra = []
) {
  return new Promise(resolve => {
    const args = [
      "--silent",
      "--show-error",

      "--proxy",
      `socks5h://127.0.0.1:${port}`,

      "--noproxy",
      "",

      "--connect-timeout",
      String(
        Math.ceil(
          CURL_TIMEOUT / 1000
        )
      ),

      "--max-time",
      String(
        Math.ceil(
          CURL_TIMEOUT / 1000
        )
      ),

      ...extra,

      url
    ];

    const started = Date.now();

    execFile(
      "curl",
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
        const latency =
          Date.now() -
          started;

        if (error) {
          resolve({
            ok: false,

            latency: null,

            body: stdout || "",

            error:
              cleanError(
                stderr ||
                error.message
              )
          });

          return;
        }

        resolve({
          ok: true,

          latency,

          body:
            String(
              stdout || ""
            ).trim(),

          error: null
        });
      }
    );
  });
}

async function proxyPing(
  port
) {
  const first =
    await curlProxy(
      port,
      PING_URL,
      [
        "--output",
        "/dev/null",

        "--write-out",
        "%{http_code}"
      ]
    );

  const second =
    await curlProxy(
      port,
      PING_URL,
      [
        "--output",
        "/dev/null",

        "--write-out",
        "%{http_code}"
      ]
    );

  const firstCode =
    Number(first.body);

  const secondCode =
    Number(second.body);

  const firstOk =
    first.ok &&
    firstCode >= 200 &&
    firstCode < 400;

  const secondOk =
    second.ok &&
    secondCode >= 200 &&
    secondCode < 400;

  const values = [];

  if (firstOk) {
    values.push(
      first.latency
    );
  }

  if (secondOk) {
    values.push(
      second.latency
    );
  }

  if (!values.length) {
    return {
      ok: false,

      latency: null,

      firstLatency:
        first.latency,

      secondLatency:
        second.latency,

      error:
        first.error ||
        second.error ||
        "generate_204 failed"
    };
  }

  return {
    ok: true,

    latency:
      Math.min(...values),

    firstLatency:
      firstOk
        ? first.latency
        : null,

    secondLatency:
      secondOk
        ? second.latency
        : null
  };
}

async function internetCheck(
  port
) {
  /*
   * Проверяем интернет именно
   * через запущенный SOCKS.
   */

  const result =
    await curlProxy(
      port,
      IP_URL
    );

  const ip =
    String(
      result.body || ""
    ).trim();

  /*
   * ipify должен вернуть
   * реальный внешний IP.
   */
  const validIp =
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) ||
    /^[0-9a-f:]+$/i.test(ip);

  if (
    !result.ok ||
    !validIp
  ) {
    return {
      ok: false,

      ip: null,

      error:
        result.error ||
        `Invalid external IP: ${ip}`
    };
  }

  return {
    ok: true,

    ip
  };
}

async function checkNode(
  uri,
  tcpLatency,
  countryCode
) {
  let configFile;
  let xrayProcess;

  try {
    let outbound;

    try {
      outbound =
        uriToOutbound(
          uri,
          "proxy"
        );
    } catch (error) {
      addError(
        `PARSE ${cleanError(
          error.message
        )}`
      );

      return null;
    }

    const port =
      randomPort();

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

      addError(
        `XRAY START ${
          cleanError(
            output.stderr ||
            output.stdout ||
            "SOCKS did not start"
          )
        }`
      );

      return null;
    }

    /*
     * Реальный интернет через proxy.
     */
    const internet =
      await internetCheck(
        port
      );

    if (!internet.ok) {
      addError(
        `NO INTERNET ${
          internet.error
        }`
      );

      return null;
    }

    /*
     * Happ Default:
     * два отдельных запроса,
     * лучший результат.
     */
    const ping =
      await proxyPing(
        port
      );

    if (!ping.ok) {
      addError(
        `PROXY PING ${
          ping.error
        }`
      );

      return null;
    }

    /*
     * Лимит применяется только
     * после успешной проверки
     * реального доступа в интернет.
     */
    if (
      ping.latency >
      MAX_PROXY_LATENCY
    ) {
      return null;
    }

    console.log(
      `PASS TCP=${tcpLatency}ms PROXY=${ping.latency}ms IP=${internet.ip} ${safeNodeInfo(uri)}`
    );

    return {
      uri,

      countryCode:
        String(
          countryCode ||
          "UN"
        ).toUpperCase(),

      latency:
        ping.latency,

      proxyLatency:
        ping.latency,

      tcpLatency,

      proxyPing1:
        ping.firstLatency,

      proxyPing2:
        ping.secondLatency,

      exitIp:
        internet.ip,

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
        i >=
        items.length
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
          `WORKER ${
            cleanError(
              error.message
            )
          }`
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
        length:
          workers
      },
      worker
    )
  );

  return results;
}

function uniqueNodes(input) {
  const map =
    new Map();

  for (
    const uri of input
  ) {
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

  const geo =
    await import(
      "./geoip.js"
    );

  uriToOutbound =
    xray.uriToOutbound;

  protocolOf =
    xray.protocolOf;

  resolveGeo =
    geo.resolveGeo;

  const raw =
    JSON.parse(
      fs.readFileSync(
        RAW_FILE,
        "utf8"
      )
    );

  const nodes =
    uniqueNodes(raw);

  console.log(
    `Unique nodes: ${nodes.length}`
  );

  const successful = [];

  for (
    let start = 0;
    start < nodes.length;
    start += BATCH_SIZE
  ) {
    if (
      successful.length >=
      TARGET
    ) {
      break;
    }

    const batch =
      nodes.slice(
        start,
        start +
          BATCH_SIZE
      );

    console.log(
      `\nCHECK BATCH ${
        Math.floor(
          start /
            BATCH_SIZE
        ) + 1
      }`
    );

    /*
     * TCP.
     */
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

          if (!result.ok) {
            return null;
          }

          return {
            uri,

            tcpLatency:
              result.latency
          };
        }
      );

    const tcpAlive =
      tcpResults.filter(
        Boolean
      );

    console.log(
      `TCP alive: ${tcpAlive.length}/${batch.length}`
    );

    /*
     * GeoIP.
     */
    const geoResults =
      await mapLimit(
        tcpAlive,
        GEO_CONCURRENCY,
        async node => {
          const hp =
            parseHostPort(
              node.uri
            );

          if (!hp) {
            return null;
          }

          try {
            const geo =
              await resolveGeo(
                hp.host
              );

            const code =
              String(
                geo?.countryCode ||
                "UN"
              ).toUpperCase();

            if (
              code === "RU"
            ) {
              return null;
            }

            return {
              ...node,

              countryCode:
                code
            };
          } catch {
            return {
              ...node,

              countryCode:
                "UN"
            };
          }
        }
      );

    const nonRu =
      geoResults.filter(
        Boolean
      );

    console.log(
      `NON-RU: ${nonRu.length}/${tcpAlive.length}`
    );

    /*
     * Xray + actual internet
     * + Default proxy ping.
     */
    const checked =
      await mapLimit(
        nonRu,
        XRAY_CONCURRENCY,
        async node =>
          checkNode(
            node.uri,
            node.tcpLatency,
            node.countryCode
          )
      );

    const passed =
      checked.filter(
        Boolean
      );

    successful.push(
      ...passed
    );

    console.log(
      `WORKING <= ${MAX_PROXY_LATENCY}ms: ${passed.length}/${nonRu.length}`
    );

    console.log(
      `TOTAL: ${successful.length}/${TARGET}`
    );
  }

  const finalNodes =
    successful.slice(
      0,
      TARGET
    );

  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify(
      finalNodes,
      null,
      2
    )
  );

  console.log(
    `FINAL: ${finalNodes.length}/${TARGET}`
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
}

main().catch(
  error => {
    console.error(
      error
    );

    process.exit(1);
  }
);
