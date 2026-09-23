const fs = require("fs");
const net = require("net");
const tls = require("tls");
const { spawn } = require("child_process");

const RAW_FILE = "data/raw.json";
const OUT_FILE = "data/checked.json";

const BATCH_SIZE =
  Number(process.env.BATCH_SIZE || 200);

const BATCH_INDEX =
  Number(process.env.BATCH_INDEX || 0);

const MAX_LATENCY =
  Number(process.env.MAX_LATENCY || 150);

const TCP_TIMEOUT =
  Number(process.env.TCP_TIMEOUT || 5000);

const HTTP_TIMEOUT =
  Number(process.env.HTTP_TIMEOUT || 7000);

const CONCURRENCY =
  Number(process.env.CONCURRENCY || 200);

const XRAY_CONCURRENCY =
  Number(process.env.XRAY_CONCURRENCY || 20);

const TEST_HOST =
  "www.gstatic.com";

const TEST_PORT =
  443;

const TEST_PATH =
  "/generate_204";

let uriToOutbound;
let protocolOf;

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

function protocol(uri) {
  return protocolOf(uri);
}

function parseHostPort(uri) {
  try {
    if (protocol(uri) === "vmess") {
      let value =
        uri
          .slice(8)
          .replace(/-/g, "+")
          .replace(/_/g, "/");

      value += "=".repeat(
        (4 - value.length % 4) % 4
      );

      const data =
        JSON.parse(
          Buffer
            .from(value, "base64")
            .toString("utf8")
        );

      if (!data.add) {
        return null;
      }

      const port =
        Number(data.port);

      if (
        !Number.isFinite(port) ||
        port <= 0 ||
        port > 65535
      ) {
        return null;
      }

      return {
        host: data.add,
        port
      };
    }

    const u =
      new URL(uri);

    let port =
      Number(u.port);

    if (!port) {
      port =
        protocol(uri) === "ss" ||
        protocol(uri) === "socks" ||
        protocol(uri) === "socks5"
          ? 1080
          : 443;
    }

    if (
      !u.hostname ||
      !Number.isFinite(port) ||
      port <= 0 ||
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
    const started =
      Date.now();

    const socket =
      net.createConnection({
        host,
        port
      });

    let finished = false;

    const finish =
      (ok, latency = null) => {
        if (finished) {
          return;
        }

        finished = true;

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
      () => {
        finish(
          true,
          Date.now() - started
        );
      }
    );

    socket.once(
      "timeout",
      () => {
        finish(false);
      }
    );

    socket.once(
      "error",
      () => {
        finish(false);
      }
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

function startXray(
  outbound,
  port
) {
  const config = {
    log: {
      loglevel: "warning"
    },

    inbounds: [
      {
        tag: "check",
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
      rules: [
        {
          type: "field",
          inboundTag: ["check"],
          outboundTag: outbound.tag
        }
      ]
    }
  };

  const file =
    `/tmp/xray-${process.pid}-${port}.json`;

  fs.writeFileSync(
    file,
    JSON.stringify(config)
  );

  const child =
    spawn(
      "xray",
      [
        "run",
        "-config",
        file
      ],
      {
        stdio: [
          "ignore",
          "ignore",
          "pipe"
        ]
      }
    );

  child.stderr.on(
    "data",
    () => {}
  );

  return {
    child,
    file
  };
}

function waitForPort(
  port,
  timeout = 5000
) {
  return new Promise(resolve => {
    const started =
      Date.now();

    const loop = () => {
      const socket =
        net.createConnection({
          host: "127.0.0.1",
          port
        });

      let done = false;

      const finish =
        ok => {
          if (done) {
            return;
          }

          done = true;

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
            loop,
            100
          );
        };

      socket.once(
        "connect",
        () => finish(true)
      );

      socket.once(
        "error",
        () => finish(false)
      );

      socket.setTimeout(
        500,
        () => finish(false)
      );
    };

    loop();
  });
}

function socks5Connect(
  port,
  host,
  targetPort
) {
  return new Promise(
    (resolve, reject) => {
      const socket =
        net.createConnection({
          host: "127.0.0.1",
          port
        });

      let stage = 0;
      let buffer =
        Buffer.alloc(0);

      const timeout =
        setTimeout(() => {
          socket.destroy();
          reject(
            new Error(
              "SOCKS timeout"
            )
          );
        }, HTTP_TIMEOUT);

      const cleanup = () => {
        clearTimeout(timeout);
      };

      socket.on(
        "error",
        err => {
          cleanup();
          reject(err);
        }
      );

      socket.on(
        "data",
        chunk => {
          buffer =
            Buffer.concat([
              buffer,
              chunk
            ]);

          if (stage === 0) {
            if (
              buffer.length < 2
            ) {
              return;
            }

            if (
              buffer[0] !== 0x05 ||
              buffer[1] !== 0x00
            ) {
              cleanup();
              socket.destroy();

              reject(
                new Error(
                  "SOCKS auth failed"
                )
              );

              return;
            }

            stage = 1;
            buffer =
              Buffer.alloc(0);

            socket.write(
              Buffer.from([
                0x05,
                0x01,
                0x00,
                0x03,
                Buffer.byteLength(host),
                ...Buffer.from(host),
                (targetPort >> 8) & 0xff,
                targetPort & 0xff
              ])
            );

            return;
          }

          if (stage === 1) {
            if (
              buffer.length < 5
            ) {
              return;
            }

            const atyp =
              buffer[3];

            let needed = 0;

            if (atyp === 0x01) {
              needed = 10;
            } else if (
              atyp === 0x03
            ) {
              if (
                buffer.length < 5
              ) {
                return;
              }

              needed =
                7 + buffer[4];
            } else if (
              atyp === 0x04
            ) {
              needed = 22;
            } else {
              cleanup();
              socket.destroy();

              reject(
                new Error(
                  "Invalid SOCKS reply"
                )
              );

              return;
            }

            if (
              buffer.length < needed
            ) {
              return;
            }

            if (
              buffer[1] !== 0x00
            ) {
              cleanup();
              socket.destroy();

              reject(
                new Error(
                  `SOCKS connect failed: ${buffer[1]}`
                )
              );

              return;
            }

            stage = 2;

            const rest =
              buffer.slice(needed);

            buffer =
              Buffer.alloc(0);

            cleanup();

            resolve({
              socket,
              initial: rest
            });
          }
        }
      );
    }
  );
}

function httpsCheck(
  socksPort
) {
  return new Promise(
    async resolve => {
      let connection;

      try {
        connection =
          await socks5Connect(
            socksPort,
            TEST_HOST,
            TEST_PORT
          );
      } catch {
        resolve(false);
        return;
      }

      const {
        socket,
        initial
      } = connection;

      const tlsSocket =
        tls.connect({
          socket,
          servername: TEST_HOST,
          rejectUnauthorized: true,
          ALPNProtocols: [
            "http/1.1"
          ]
        });

      let settled =
        false;

      const finish =
        ok => {
          if (settled) {
            return;
          }

          settled = true;

          tlsSocket.destroy();

          resolve(ok);
        };

      const timer =
        setTimeout(
          () => finish(false),
          HTTP_TIMEOUT
        );

      let response =
        initial.length
          ? initial.toString(
              "utf8"
            )
          : "";

      tlsSocket.on(
        "secureConnect",
        () => {
          tlsSocket.write(
            [
              `GET ${TEST_PATH} HTTP/1.1`,
              `Host: ${TEST_HOST}`,
              "Connection: close",
              "User-Agent: vpn-collector/1.0",
              "Accept: */*",
              "",
              ""
            ].join("\r\n")
          );
        }
      );

      tlsSocket.on(
        "data",
        chunk => {
          response +=
            chunk.toString(
              "utf8"
            );

          const match =
            response.match(
              /^HTTP\/\d(?:\.\d)?\s+(\d{3})/
            );

          if (!match) {
            return;
          }

          clearTimeout(timer);

          const status =
            Number(match[1]);

          finish(
            status >= 200 &&
            status < 400
          );
        }
      );

      tlsSocket.on(
        "error",
        () => {
          clearTimeout(timer);
          finish(false);
        }
      );

      tlsSocket.on(
        "close",
        () => {
          clearTimeout(timer);
        }
      );
    }
  );
}

async function checkNode(
  uri,
  tcpLatency
) {
  let outbound;

  try {
    outbound =
      uriToOutbound(
        uri,
        "node"
      );
  } catch {
    return null;
  }

  const port =
    randomPort();

  let xray;

  try {
    xray =
      startXray(
        outbound,
        port
      );

    const ready =
      await waitForPort(
        port,
        5000
      );

    if (!ready) {
      return null;
    }

    const ok =
      await httpsCheck(
        port
      );

    if (!ok) {
      return null;
    }

    return {
      uri,
      latency: tcpLatency,
      tcpLatency,
      checkedAt:
        new Date().toISOString()
    };
  } catch {
    return null;
  } finally {
    if (xray) {
      xray.child.kill(
        "SIGTERM"
      );

      try {
        fs.unlinkSync(
          xray.file
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
      } catch {
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
      { length: workers },
      worker
    )
  );

  return results;
}

function uniqueNodes(
  input
) {
  const map =
    new Map();

  for (const uri of input) {
    if (
      typeof uri !==
      "string"
    ) {
      continue;
    }

    const key =
      uri.trim();

    if (!key) {
      continue;
    }

    const hp =
      parseHostPort(key);

    if (!hp) {
      continue;
    }

    const identity =
      `${protocol(key)}:${hp.host}:${hp.port}`;

    if (
      !map.has(identity)
    ) {
      map.set(
        identity,
        key
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
    uniqueNodes(raw);

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
          parseHostPort(uri);

        if (!hp) {
          return null;
        }

        const result =
          await tcpCheck(
            hp.host,
            hp.port
          );

        if (
          !result.ok ||
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
    tcpResults.filter(Boolean);

  console.log(
    `TCP alive: ${alive.length}/${batch.length}`
  );

  const checked =
    await mapLimit(
      alive,
      XRAY_CONCURRENCY,
      async node => {
        const result =
          await checkNode(
            node.uri,
            node.latency
          );

        if (!result) {
          return null;
        }

        console.log(
          `PASS ${node.latency}ms ${protocol(node.uri)}`
        );

        return result;
      }
    );

  const success =
    checked.filter(Boolean);

  console.log(
    `REAL VPN alive: ${success.length}/${alive.length}`
  );

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

main().catch(err => {
  console.error(err);
  process.exit(1);
});
