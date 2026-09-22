const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const BATCH_SIZE = Number(process.env.BATCH_SIZE || 200);
const CONCURRENCY = Number(process.env.CONCURRENCY || 200);
const HY2_CONCURRENCY = Number(process.env.HY2_CONCURRENCY || 20);

const MAX_LATENCY = Number(process.env.MAX_LATENCY || 150);
const TCP_TIMEOUT = Number(process.env.TCP_TIMEOUT || 5000);
const HTTP_TIMEOUT = Number(process.env.HTTP_TIMEOUT || 7000);

const XRAY = process.env.XRAY_PATH || "/usr/local/bin/xray";

const input = JSON.parse(
  fs.readFileSync("data/raw.json", "utf8")
);

let xrayModule;

async function loadXrayModule() {
  if (!xrayModule) {
    xrayModule = await import("./xray.js");
  }

  return xrayModule;
}

function protocolOf(uri) {
  return uri.split("://", 1)[0].toLowerCase();
}

function parseHostPort(uri) {
  try {
    const url = new URL(uri);

    if (!url.hostname || !url.port) {
      return null;
    }

    return {
      host: url.hostname,
      port: Number(url.port)
    };
  } catch {
    return null;
  }
}

function tcpPing(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const start = performance.now();
    let finished = false;

    const done = (result) => {
      if (finished) return;

      finished = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(TCP_TIMEOUT);

    socket.once("connect", () => {
      const latency = Math.round(
        performance.now() - start
      );

      done({
        ok: latency <= MAX_LATENCY,
        latency
      });
    });

    socket.once("timeout", () => {
      done({
        ok: false,
        latency: null
      });
    });

    socket.once("error", () => {
      done({
        ok: false,
        latency: null
      });
    });

    socket.connect(port, host);
  });
}

function waitPort(port, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();

    const check = () => {
      const socket = net.createConnection({
        host: "127.0.0.1",
        port
      });

      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });

      socket.once("error", () => {
        socket.destroy();

        if (Date.now() - started >= timeout) {
          reject(new Error("xray_start_timeout"));
          return;
        }

        setTimeout(check, 30);
      });
    };

    check();
  });
}

function socks5Connect(port, host, targetPort) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: "127.0.0.1",
      port
    });

    let stage = 0;
    let buffer = Buffer.alloc(0);

    const started = performance.now();

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("socks_timeout"));
    }, TCP_TIMEOUT);

    const fail = (error = "socks_error") => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(error));
    };

    socket.once("error", () => {
      fail();
    });

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([
        buffer,
        chunk
      ]);

      if (stage === 0) {
        if (buffer.length < 2) {
          return;
        }

        if (
          buffer[0] !== 0x05 ||
          buffer[1] !== 0x00
        ) {
          fail("socks_auth_failed");
          return;
        }

        buffer = buffer.subarray(2);

        const hostBuffer =
          Buffer.from(host);

        socket.write(
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
              (targetPort >> 8) & 0xff,
              targetPort & 0xff
            ])
          ])
        );

        stage = 1;
        return;
      }

      if (stage === 1) {
        if (buffer.length < 5) {
          return;
        }

        if (
          buffer[0] !== 0x05 ||
          buffer[1] !== 0x00
        ) {
          fail("socks_connect_failed");
          return;
        }

        clearTimeout(timer);

        const latency = Math.round(
          performance.now() - started
        );

        socket.destroy();

        resolve(latency);
      }
    });

    socket.write(
      Buffer.from([
        0x05,
        0x01,
        0x00
      ])
    );
  });
}

async function httpThroughSocks(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({
      host: "127.0.0.1",
      port
    });

    let stage = 0;
    let buffer = Buffer.alloc(0);

    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, HTTP_TIMEOUT);

    const finish = (ok) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };

    socket.once("error", () => {
      finish(false);
    });

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([
        buffer,
        chunk
      ]);

      if (stage === 0) {
        if (buffer.length < 2) {
          return;
        }

        if (
          buffer[0] !== 0x05 ||
          buffer[1] !== 0x00
        ) {
          finish(false);
          return;
        }

        buffer = buffer.subarray(2);

        const host = Buffer.from(
          "www.youtube.com"
        );

        socket.write(
          Buffer.concat([
            Buffer.from([
              0x05,
              0x01,
              0x00,
              0x03,
              host.length
            ]),
            host,
            Buffer.from([
              0x01,
              0xbb
            ])
          ])
        );

        stage = 1;
        return;
      }

      if (stage === 1) {
        if (buffer.length < 5) {
          return;
        }

        if (
          buffer[0] !== 0x05 ||
          buffer[1] !== 0x00
        ) {
          finish(false);
          return;
        }

        buffer = Buffer.alloc(0);

        socket.write(
          Buffer.from(
            "GET /generate_204 HTTP/1.1\r\n" +
            "Host: www.youtube.com\r\n" +
            "Connection: close\r\n" +
            "User-Agent: Mozilla/5.0\r\n" +
            "\r\n"
          )
        );

        stage = 2;
        return;
      }

      if (stage === 2) {
        const text =
          buffer.toString("utf8");

        if (
          text.includes("HTTP/1.1 204") ||
          text.includes("HTTP/2 204") ||
          text.includes("HTTP/1.1 200") ||
          text.includes("HTTP/1.1 301") ||
          text.includes("HTTP/1.1 302")
        ) {
          finish(true);
        }
      }
    });

    socket.write(
      Buffer.from([
        0x05,
        0x01,
        0x00
      ])
    );
  });
}

async function hysteria2Check(uri) {
  const {
    uriToOutbound,
    buildCheckConfig
  } = await loadXrayModule();

  const localPort =
    20000 +
    Math.floor(Math.random() * 20000);

  const outbound =
    uriToOutbound(
      uri,
      "check-hy2"
    );

  const config =
    buildCheckConfig(
      outbound,
      localPort
    );

  const dir =
    fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        "hy2-check-"
      )
    );

  const configPath =
    path.join(
      dir,
      "config.json"
    );

  fs.writeFileSync(
    configPath,
    JSON.stringify(config)
  );

  const proc =
    spawn(
      XRAY,
      [
        "run",
        "-c",
        configPath
      ],
      {
        stdio: "ignore"
      }
    );

  try {
    await waitPort(
      localPort,
      4000
    );

    const tcp =
      await socks5Connect(
        localPort,
        "www.youtube.com",
        443
      );

    if (
      tcp > MAX_LATENCY
    ) {
      return {
        ok: false,
        latency: tcp
      };
    }

    const internet =
      await httpThroughSocks(
        localPort
      );

    if (!internet) {
      return {
        ok: false,
        latency: tcp
      };
    }

    return {
      ok: true,
      latency: tcp
    };
  } catch {
    return {
      ok: false,
      latency: null
    };
  } finally {
    proc.kill("SIGKILL");

    try {
      fs.rmSync(
        dir,
        {
          recursive: true,
          force: true
        }
      );
    } catch {}
  }
}

async function normalCheck(uri) {
  const server =
    parseHostPort(uri);

  if (!server) {
    return {
      ok: false,
      latency: null
    };
  }

  const tcp =
    await tcpPing(
      server.host,
      server.port
    );

  if (!tcp.ok) {
    return tcp;
  }

  return {
    ok: true,
    latency: tcp.latency
  };
}

async function checkNode(uri) {
  const protocol =
    protocolOf(uri);

  if (
    protocol === "hy2" ||
    protocol === "hysteria2"
  ) {
    return hysteria2Check(uri);
  }

  return normalCheck(uri);
}

function uniqueNodes(list) {
  const map = new Map();

  for (const uri of list) {
    if (
      typeof uri !== "string"
    ) {
      continue;
    }

    const server =
      parseHostPort(uri);

    if (!server) {
      continue;
    }

    const protocol =
      protocolOf(uri);

    const key =
      `${protocol}:${server.host}:${server.port}`;

    if (!map.has(key)) {
      map.set(key, uri);
    }
  }

  return [...map.values()];
}

async function runWorkers(nodes) {
  const results = [];

  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (true) {
      const index =
        nextIndex++;

      if (
        index >= nodes.length
      ) {
        return;
      }

      const uri =
        nodes[index];

      try {
        const result =
          await checkNode(uri);

        completed++;

        if (result.ok) {
          results.push({
            uri,
            latency: result.latency
          });

          console.log(
            `✅ ${protocolOf(uri)} ${result.latency} ms`
          );
        } else {
          console.log(
            `❌ ${protocolOf(uri)}`
          );
        }

        if (
          completed % 25 === 0 ||
          completed === nodes.length
        ) {
          console.log(
            `Progress: ${completed}/${nodes.length} | Working: ${results.length}`
          );
        }
      } catch {
        completed++;
      }
    }
  }

  const workers = [];

  for (
    let i = 0;
    i <
    Math.min(
      CONCURRENCY,
      nodes.length
    );
    i++
  ) {
    workers.push(worker());
  }

  await Promise.all(workers);

  return results;
}

async function main() {
  const nodes =
    uniqueNodes(input);

  const batchIndex =
    Number(
      process.env.BATCH_INDEX || 0
    );

  const start =
    batchIndex * BATCH_SIZE;

  const batch =
    nodes.slice(
      start,
      start + BATCH_SIZE
    );

  console.log(
    `Raw configs: ${input.length}`
  );

  console.log(
    `Unique servers: ${nodes.length}`
  );

  console.log(
    `Batch: ${batchIndex + 1}`
  );

  console.log(
    `Batch size: ${batch.length}`
  );

  console.log(
    `Range: ${start + 1}-${start + batch.length}`
  );

  console.log(
    `Max latency: ${MAX_LATENCY} ms`
  );

  console.log("");

  if (!batch.length) {
    console.log(
      "No servers in this batch"
    );

    fs.writeFileSync(
      "data/checked.json",
      "[]"
    );

    return;
  }

  const results =
    await runWorkers(batch);

  results.sort(
    (a, b) =>
      a.latency - b.latency
  );

  fs.writeFileSync(
    "data/checked.json",
    JSON.stringify(
      results,
      null,
      2
    )
  );

  console.log("");
  console.log(
    "============================"
  );
  console.log(
    `Batch checked: ${batch.length}`
  );
  console.log(
    `Working: ${results.length}`
  );
  console.log(
    "============================"
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
