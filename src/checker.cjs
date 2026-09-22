const fs = require("fs");
const net = require("net");

const MAX_LATENCY = Number(process.env.MAX_LATENCY || 150);
const TIMEOUT = Number(process.env.TCP_TIMEOUT || 5000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 200);

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
        latency: null
      });
    });

    socket.once("error", () => {
      done({
        ok: false,
        latency: null
      });
    });

    socket.connect(Number(port), host);
  });
}

async function main() {
  const unique = new Map();

  for (const node of input) {
    const host = node.host;
    const port = Number(node.port);

    if (!host || !port) continue;

    const key = `${host}:${port}`;

    if (!unique.has(key)) {
      unique.set(key, node);
    }
  }

  const nodes = [...unique.values()];

  console.log(`Raw: ${input.length}`);
  console.log(`Unique: ${nodes.length}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Max latency: ${MAX_LATENCY} ms\n`);

  const results = [];
  let completed = 0;

  async function worker() {
    while (true) {
      const index = completed++;

      if (index >= nodes.length) return;

      const node = nodes[index];

      try {
        const result = await tcpPing(
          node.host,
          Number(node.port)
        );

        if (result.ok) {
          results.push({
            ...node,
            latency: result.latency
          });

          console.log(
            `✅ ${node.host}:${node.port} ${result.latency} ms`
          );
        }
      } catch {}

      if ((index + 1) % 1000 === 0) {
        console.log(
          `Progress: ${index + 1}/${nodes.length} | Working: ${results.length}`
        );
      }
    }
  }

  const workers = [];

  for (
    let i = 0;
    i < Math.min(CONCURRENCY, nodes.length);
    i++
  ) {
    workers.push(worker());
  }

  await Promise.all(workers);

  results.sort((a, b) => a.latency - b.latency);

  fs.writeFileSync(
    "data/checked.json",
    JSON.stringify(results, null, 2)
  );

  console.log("\n============================");
  console.log(`Checked: ${nodes.length}`);
  console.log(`Working: ${results.length}`);
  console.log("============================");
}

main();
