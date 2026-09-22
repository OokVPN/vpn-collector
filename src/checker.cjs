const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const MAX_LATENCY = Number(process.env.MAX_LATENCY || 150);
const TCP_TIMEOUT = Number(process.env.TCP_TIMEOUT || 5000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 200);
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

function waitPort(port, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();

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

        if (Date.now() - start >= timeout) {
          reject(new Error("xray_start_timeout"));
        } else {
          setTimeout(check, 30);
        }
      });
    };

    check();
  });
}

function socks5Connect(port, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: "127.0.0.1",
      port
    });

    let stage = 0;
    let buffer = Buffer.alloc(0);
    const start = performance.now();

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("proxy_timeout"));
    }, TCP_TIMEOUT);

    const fail = () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error("proxy_error"));
    };

    socket.on("error", fail);

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (stage === 0) {
        if (buffer.length < 2) return;

        if (
          buffer[0] !== 0x05 ||
          buffer[1] !== 0x00
        ) {
          fail();
          return;
        }

        buffer = buffer.subarray(2);

        const host = Buffer.from(targetHost);

        const request = Buffer.concat([
          Buffer.from([
            0x05,
            0x01,
            0x00,
            0x03,
            host.length
          ]),
          host,
          Buffer.from([
            (targetPort >> 8) & 0xff,
            targetPort & 0xff
          ])
        ]);

        socket.write(request);
        stage = 1;
      }

      if (stage === 1) {
        if (buffer.length < 5) return;

        if (
          buffer[0] !== 0x05 ||
          buffer[1] !== 0x00
        ) {
          fail();
          return;
        }

        clearTimeout(timer);

        const latency = Math.round(
          performance.now() - start
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

async function hysteria2Check(uri) {
  const { uriToOutbound, buildCheckConfig } =
    await loadXrayModule();

  const localPort =
    20000 +
    Math.floor(Math.random() * 20000);

  const tag = "check-hy2";

  const outbound =
    uriToOutbound(uri, tag);

  const config =
    buildCheckConfig(
      outbound,
      localPort
    );

  const dir = fs.mkdtempSync(
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

  const start = performance.now();

  const proc = spawn(
    XRAY,
    [
      "run",
      "-c",
      configPath
    ],
    {
      stdio: [
        "ignore",
        "ignore",
        "ignore"
      ]
    }
  );

  try {
    await waitPort(
      localPort,
      3000
    );

    const latency =
      await socks5Connect(
        localPort,
        "1.1.1.1",
        443
      );

    return {
      ok:
        latency <= MAX_LATENCY,
      latency
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

async function checkNode(uri) {
  const protocol =
    protocolOf(uri);

  if (
    protocol === "hy2" ||
    protocol === "hysteria2"
  ) {
    return hysteria2Check(uri);
  }

  const server =
    parseHostPort(uri);

  if (!server) {
    return {
      ok: false,
      latency: null
    };
  }

  return tcpPing(
    server.host,
    server.port
  );
}

async function main() {
  const unique = new Map();

  for (const uri of input) {
    if (
      typeof uri !== "string"
    ) {
      continue;
    }

    const protocol =
      protocolOf(uri);

    const server =
      parseHostPort(uri);

    if (!server) {
      continue;
    }

    const key =
      `${protocol}:${server.host}:${server.port}`;

    if (!unique.has(key)) {
      unique.set(key, uri);
    }
  }

  const nodes =
    [...unique.values()];

  console.log(
    `Raw configs: ${input.length}`
  );

  console.log(
    `Unique servers: ${nodes.length}`
  );

  console.log(
    `Concurrency: ${CONCURRENCY}`
  );

  console.log(
    `Max latency: ${MAX_LATENCY} ms`
  );

  console.log("");

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
        }

        if (
          completed % 1000 === 0
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
    `Checked: ${nodes.length}`
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
