const fs = require("fs");
const net = require("net");

const MAX_LATENCY = Number(process.env.MAX_LATENCY || 150);
const TIMEOUT = Number(process.env.TCP_TIMEOUT || 5000);

const input = JSON.parse(
  fs.readFileSync("data/raw.json", "utf8")
);

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

    socket.setTimeout(TIMEOUT);

    socket.once("connect", () => {
      const latency = Math.round(performance.now() - start);

      done({
        ok: latency <= MAX_LATENCY,
        latency
      });
    });

    socket.once("timeout", () => {
      done({
        ok: false,
        latency: null,
        error: "timeout"
      });
    });

    socket.once("error", (err) => {
      done({
        ok: false,
        latency: null,
        error: err.code || "connection_error"
      });
    });

    socket.connect(Number(port), host);
  });
}

async function main() {
  const results = [];

  for (const node of input) {
    try {
      const host = node.host;
      const port = Number(node.port);

      if (!host || !port) continue;

      const result = await tcpPing(host, port);

      console.log(
        `${result.ok ? "✅" : "❌"} ${host}:${port} ${
          result.latency !== null
            ? result.latency + " ms"
            : result.error
        }`
      );

      if (result.ok) {
        results.push({
          ...node,
          latency: result.latency
        });
      }
    } catch {
      // skip broken node
    }
  }

  fs.writeFileSync(
    "data/checked.json",
    JSON.stringify(results, null, 2)
  );

  console.log(`\nWorking: ${results.length}`);
}

main();
