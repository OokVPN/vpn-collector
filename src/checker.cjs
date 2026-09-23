const fs = require("fs");
const os = require("os");
const net = require("net");
const tls = require("tls");
const crypto = require("crypto");
const { spawn } = require("child_process");

const {
  uriToOutbound,
  protocolOf
} = require("./xray.js");

const INPUT = "./data/raw.json";
const OUTPUT = "./data/checked.json";

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

const TARGET_HOST =
  "www.gstatic.com";

const TARGET_PORT =
  443;

const TARGET_PATH =
  "/generate_204";

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}

function randomPort() {
  return (
    20000 +
    Math.floor(
      Math.random() * 30000
    )
  );
}

function protocol(uri) {
  return protocolOf(uri);
}

function decodeVmess(uri) {
  try {
    let value =
      uri.slice("vmess://".length)
        .replace(/-/g, "+")
        .replace(/_/g, "/");

    value += "=".repeat(
      (4 - value.length % 4) % 4
    );

    return JSON.parse(
      Buffer
        .from(value, "base64")
        .toString("utf8")
    );
  } catch {
    return null;
  }
}

function parseHostPort(uri) {
  const p =
    protocol(uri);

  if (p === "vmess") {
    const data =
      decodeVmess(uri);

    if (!data?.add) {
      throw new Error(
        "VMess host missing"
      );
    }

    return {
      host:
        data.add,

      port:
        Number(data.port || 443)
    };
  }

  const u =
    new URL(uri);

  if (!u.hostname) {
    throw new Error(
      "Host missing"
    );
  }

  return {
    host:
      u.hostname,

    port:
      Number(
        u.port ||
        (
          p === "ss" ||
          p === "socks" ||
          p === "socks5"
            ? 1080
            : 443
        )
      )
  };
}

function tcpCheck(
  host,
  port
) {
  return new Promise(
    resolve => {
      const started =
        Date.now();

      const socket =
        net.connect({
          host,
          port
        });

      let done = false;

      const finish = value => {
        if (done) return;

        done = true;

        socket.destroy();

        resolve(value);
      };

      socket.setTimeout(
        TCP_TIMEOUT
      );

      socket.once(
        "connect",
        () => {
          finish(
            Date.now() -
            started
          );
        }
      );

      socket.once(
        "timeout",
        () => finish(null)
      );

      socket.once(
        "error",
        () => finish(null)
      );
    }
  );
}

function waitForPort(
  port,
  timeout = 5000
) {
  return new Promise(
    resolve => {
      const started =
        Date.now();

      const loop = () => {
        const socket =
          net.connect({
            host:
              "127.0.0.1",

            port
          });

        socket.once(
          "connect",
          () => {
            socket.destroy();
            resolve(true);
          }
        );

        socket.once(
          "error",
          () => {
            socket.destroy();

            if (
              Date.now() -
                started >=
              timeout
            ) {
              resolve(false);
            } else {
              setTimeout(
                loop,
                50
              );
            }
          }
        );
      };

      loop();
    }
  );
}

function socks5Connect(
  port,
  host,
  targetPort
) {
  return new Promise(
    (resolve, reject) => {
      const socket =
        net.connect({
          host:
            "127.0.0.1",

          port
        });

      let buffer =
        Buffer.alloc(0);

      let stage =
        "greeting";

      let timer;

      const fail = error => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };

      const succeed = () => {
        clearTimeout(timer);
        resolve(socket);
      };

      timer =
        setTimeout(
          () => fail(
            new Error(
              "SOCKS timeout"
            )
          ),
          HTTP_TIMEOUT
        );

      socket.on(
        "error",
        fail
      );

      socket.on(
        "data",
        chunk => {
          buffer =
            Buffer.concat([
              buffer,
              chunk
            ]);

          while (true) {
            if (
              stage ===
              "greeting"
            ) {
              if (
                buffer.length <
                2
              ) {
                return;
              }

              if (
                buffer[0] !==
                  0x05 ||
                buffer[1] !==
                  0x00
              ) {
                return fail(
                  new Error(
                    "SOCKS auth failed"
                  )
                );
              }

              buffer =
                buffer.slice(2);

              const hostBuffer =
                Buffer.from(
                  host
                );

              const request =
                Buffer.concat([
                  Buffer.from([
                    0x05,
                    0x01,
                    0x00,
                    0x03,
                    hostBuffer.length
                  ]),

                  hostBuffer,

                  Buffer.from([
                    (targetPort >> 8) &
                      0xff,

                    targetPort &
                      0xff
                  ])
                ]);

              socket.write(
                request
              );

              stage =
                "connect";

              continue;
            }

            if (
              stage ===
              "connect"
            ) {
              if (
                buffer.length <
                5
              ) {
                return;
              }

              if (
                buffer[0] !==
                  0x05 ||
                buffer[1] !==
                  0x00
              ) {
                return fail(
                  new Error(
                    `SOCKS REP ${buffer[1]}`
                  )
                );
              }

              const atyp =
                buffer[3];

              let required;

              if (
                atyp ===
                0x01
              ) {
                required =
                  10;
              } else if (
                atyp ===
                0x04
              ) {
                required =
                  22;
              } else if (
                atyp ===
                0x03
              ) {
                if (
                  buffer.length <
                  5
                ) {
                  return;
                }

                required =
                  7 +
                  buffer[4];
              } else {
                return fail(
                  new Error(
                    "Invalid SOCKS ATYP"
                  )
                );
              }

              if (
                buffer.length <
                required
              ) {
                return;
              }

              succeed();
              return;
            }
          }
        }
      );

      socket.once(
        "connect",
        () => {
          socket.write(
            Buffer.from([
              0x05,
              0x01,
              0x00
            ])
          );
        }
      );
    }
  );
}

function httpsCheck(
  socket
) {
  return new Promise(
    (resolve, reject) => {
      const started =
        Date.now();

      const tlsSocket =
        tls.connect({
          socket,

          servername:
            TARGET_HOST,

          ALPNProtocols:
            ["http/1.1"],

          rejectUnauthorized:
            true
        });

      let data = "";

      let timer =
        setTimeout(
          () => {
            tlsSocket.destroy();

            reject(
              new Error(
                "HTTPS timeout"
              )
            );
          },
          HTTP_TIMEOUT
        );

      tlsSocket.once(
        "error",
        error => {
          clearTimeout(timer);

          tlsSocket.destroy();

          reject(error);
        }
      );

      tlsSocket.once(
        "secureConnect",
        () => {
          const request =
            [
              `GET ${TARGET_PATH} HTTP/1.1`,
              `Host: ${TARGET_HOST}`,
              "Connection: close",
              "User-Agent: vpn-collector/1.0",
              "Accept: */*",
              "",
              ""
            ].join("\r\n");

          tlsSocket.write(
            request
          );
        }
      );

      tlsSocket.on(
        "data",
        chunk => {
          data +=
            chunk.toString(
              "latin1"
            );

          if (
            data.length >
            8192
          ) {
            tlsSocket.destroy();
          }

          const match =
            data.match(
              /^HTTP\/1\.[01]\s+(\d{3})/
            );

          if (!match) {
            return;
          }

          const status =
            Number(match[1]);

          clearTimeout(timer);

          tlsSocket.destroy();

          if (
            status >= 200 &&
            status < 400
          ) {
            resolve(
              Date.now() -
              started
            );
          } else {
            reject(
              new Error(
                `HTTP ${status}`
              )
            );
          }
        }
      );
    }
  );
}

function startXray(
  uri,
  localPort
) {
  const tag =
    "check-" +
    crypto
      .randomBytes(6)
      .toString("hex");

  const outbound =
    uriToOutbound(
      uri,
      tag
    );

  const config = {
    log: {
      loglevel:
        "error"
    },

    inbounds: [
      {
        tag:
          "check",

        listen:
          "127.0.0.1",

        port:
          localPort,

        protocol:
          "socks",

        settings: {
          auth:
            "noauth",

          udp:
            false
        }
      }
    ],

    outbounds: [
      outbound
    ],

    routing: {
      rules: [
        {
          type:
            "field",

          inboundTag: [
            "check"
          ],

          outboundTag:
            tag
        }
      ]
    }
  };

  const dir =
    fs.mkdtempSync(
      `${os.tmpdir()}/vpn-check-`
    );

  const configPath =
    `${dir}/config.json`;

  fs.writeFileSync(
    configPath,
    JSON.stringify(
      config
    )
  );

  const child =
    spawn(
      "xray",
      [
        "run",
        "-config",
        configPath
      ],
      {
        stdio: [
          "ignore",
          "ignore",
          "pipe"
        ]
      }
    );

  let stderr = "";

  child.stderr.on(
    "data",
    chunk => {
      stderr +=
        chunk.toString();

      if (
        stderr.length >
        4000
      ) {
        stderr =
          stderr.slice(-4000);
      }
    }
  );

  const cleanup =
    () => {
      try {
        child.kill(
          "SIGKILL"
        );
      } catch {}

      try {
        fs.rmSync(
          dir,
          {
            recursive:
              true,

            force:
              true
          }
        );
      } catch {}
    };

  return {
    child,
    cleanup,

    getError() {
      return stderr.trim();
    }
  };
}

async function fullCheck(uri) {
  let endpoint;

  try {
    endpoint =
      parseHostPort(
        uri
      );
  } catch {
    return null;
  }

  const tcpLatency =
    await tcpCheck(
      endpoint.host,
      endpoint.port
    );

  if (
    tcpLatency === null
  ) {
    return null;
  }

  if (
    tcpLatency >
    MAX_LATENCY
  ) {
    return null;
  }

  const localPort =
    randomPort();

  let xray;

  try {
    xray =
      startXray(
        uri,
        localPort
      );

    const ready =
      await waitForPort(
        localPort,
        5000
      );

    if (!ready) {
      return null;
    }

    const socket =
      await socks5Connect(
        localPort,
        TARGET_HOST,
        TARGET_PORT
      );

    const httpsLatency =
      await httpsCheck(
        socket
      );

    const totalLatency =
      Date.now();

    return {
      uri,

      latency:
        httpsLatency,

      tcpLatency,

      checkedAt:
        new Date(
          totalLatency
        ).toISOString()
    };
  } catch {
    return null;
  } finally {
    if (xray) {
      xray.cleanup();
    }
  }
}

function uniqueNodes(
  list
) {
  const map =
    new Map();

  for (
    const uri of list
  ) {
    if (
      typeof uri !==
      "string"
    ) {
      continue;
    }

    try {
      const p =
        protocol(uri);

      const ep =
        parseHostPort(
          uri
        );

      const key =
        [
          p,
          ep.host
            .toLowerCase(),
          ep.port
        ].join(":");

      if (
        !map.has(key)
      ) {
        map.set(
          key,
          uri
        );
      }
    } catch {}
  }

  return [
    ...map.values()
  ];
}

async function mapLimit(
  items,
  limit,
  worker
) {
  const result =
    new Array(
      items.length
    );

  let index = 0;

  async function runner() {
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
        result[i] =
          await worker(
            items[i],
            i
          );
      } catch {
        result[i] =
          null;
      }
    }
  }

  const workers =
    Array.from(
      {
        length:
          Math.min(
            limit,
            items.length
          )
      },
      () =>
        runner()
    );

  await Promise.all(
    workers
  );

  return result;
}

async function main() {
  const raw =
    JSON.parse(
      fs.readFileSync(
        INPUT,
        "utf8"
      )
    );

  const unique =
    uniqueNodes(
      raw
    );

  const start =
    BATCH_INDEX *
    BATCH_SIZE;

  const batch =
    unique.slice(
      start,
      start +
        BATCH_SIZE
    );

  console.log(
    `RAW: ${raw.length}`
  );

  console.log(
    `UNIQUE: ${unique.length}`
  );

  console.log(
    `BATCH: ${BATCH_INDEX + 1}`
  );

  console.log(
    `BATCH SIZE: ${batch.length}`
  );

  console.log(
    `TCP CONCURRENCY: ${CONCURRENCY}`
  );

  console.log(
    `XRAY CONCURRENCY: ${XRAY_CONCURRENCY}`
  );

  /*
   * Stage 1:
   * TCP pre-filter.
   */

  const tcpAlive =
    await mapLimit(
      batch,
      CONCURRENCY,
      async uri => {
        try {
          const ep =
            parseHostPort(
              uri
            );

          const latency =
            await tcpCheck(
              ep.host,
              ep.port
            );

          if (
            latency === null ||
            latency >
              MAX_LATENCY
          ) {
            return null;
          }

          return {
            uri,
            tcpLatency:
              latency
          };
        } catch {
          return null;
        }
      }
    );

  const candidates =
    tcpAlive.filter(
      Boolean
    );

  console.log(
    `TCP ALIVE: ${candidates.length}`
  );

  /*
   * Stage 2:
   * Real Xray + SOCKS5 + TLS + HTTPS.
   */

  let checked =
    0;

  const alive =
    await mapLimit(
      candidates,
      XRAY_CONCURRENCY,
      async item => {
        const result =
          await fullCheck(
            item.uri
          );

        checked++;

        if (
          checked % 10 ===
          0
        ) {
          console.log(
            `REAL CHECK: ${checked}/${candidates.length}`
          );
        }

        return result;
      }
    );

  const working =
    alive
      .filter(Boolean)
      .filter(
        item =>
          Number.isFinite(
            Number(
              item.latency
            )
          ) &&
          Number(
            item.latency
          ) <=
            MAX_LATENCY
      );

  working.sort(
    (a, b) =>
      Number(a.latency) -
      Number(b.latency)
  );

  fs.writeFileSync(
    OUTPUT,
    JSON.stringify(
      working,
      null,
      2
    )
  );

  console.log(
    "--------------------------------"
  );

  console.log(
    `TCP ALIVE: ${candidates.length}`
  );

  console.log(
    `REAL HTTPS ALIVE: ${working.length}`
  );

  console.log(
    `REMOVED: ${
      candidates.length -
      working.length
    }`
  );

  console.log(
    "--------------------------------"
  );
}

main().catch(
  error => {
    console.error(
      error
    );

    process.exit(1);
  }
);
