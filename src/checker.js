import fs from "fs";
import os from "os";
import path from "path";
import {
  spawn
} from "child_process";

import {
  uriToOutbound,
  buildCheckConfig
} from "./xray.js";

const XRAY =
  process.env.XRAY_PATH ||
  "/usr/local/bin/xray";

const TEST_URL =
  process.env.TEST_URL ||
  "https://www.gstatic.com/generate_204";

const MAX_LATENCY =
  Number(
    process.env.MAX_LATENCY || 150
  );

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}

function run(
  command,
  args,
  timeout
) {
  return new Promise(resolve => {
    const child =
      spawn(
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

    const timer =
      setTimeout(() => {
        child.kill(
          "SIGKILL"
        );

        resolve({
          code: -1,
          stdout,
          stderr,
          timeout: true
        });
      }, timeout);

    child.stdout.on(
      "data",
      data => {
        stdout +=
          data.toString();
      }
    );

    child.stderr.on(
      "data",
      data => {
        stderr +=
          data.toString();
      }
    );

    child.on(
      "close",
      code => {
        clearTimeout(timer);

        resolve({
          code,
          stdout,
          stderr,
          timeout: false
        });
      }
    );

    child.on(
      "error",
      error => {
        clearTimeout(timer);

        resolve({
          code: -1,
          stdout,
          stderr:
            stderr +
            "\n" +
            error.message,

          timeout: false
        });
      }
    );
  });
}

function freePort() {
  return (
    20000 +
    Math.floor(
      Math.random() *
      20000
    )
  );
}

async function request(
  method,
  port
) {
  const result =
    await run(
      "curl",
      [
        "--silent",
        "--show-error",

        "--output",
        "/dev/null",

        "--connect-timeout",
        "5",

        "--max-time",
        "10",

        "--socks5-hostname",
        `127.0.0.1:${port}`,

        "-X",
        method,

        "-w",
        "%{time_total}",

        TEST_URL
      ],
      12000
    );

  if (
    result.code !== 0
  ) {
    return null;
  }

  const seconds =
    Number(
      result.stdout.trim()
    );

  if (
    !Number.isFinite(seconds)
  ) {
    return null;
  }

  return Math.round(
    seconds * 1000
  );
}

async function check(uri) {
  const port =
    freePort();

  const filename =
    path.join(
      os.tmpdir(),
      `xray-${process.pid}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.json`
    );

  let xray = null;

  try {
    const outbound =
      uriToOutbound(
        uri,
        `node-${Date.now()}`
      );

    const config =
      buildCheckConfig(
        outbound,
        port
      );

    fs.writeFileSync(
      filename,
      JSON.stringify(
        config
      )
    );

    const validation =
      await run(
        XRAY,
        [
          "run",
          "-test",
          "-config",
          filename
        ],
        10000
      );

    if (
      validation.code !== 0
    ) {
      return {
        ok: false,
        reason: "invalid-xray",
        get: null,
        head: null,
        latency: null
      };
    }

    xray =
      spawn(
        XRAY,
        [
          "run",
          "-config",
          filename
        ],
        {
          stdio: "ignore"
        }
      );

    await sleep(800);

    const get =
      await request(
        "GET",
        port
      );

    const head =
      await request(
        "HEAD",
        port
      );

    if (
      get === null ||
      head === null
    ) {
      return {
        ok: false,
        reason: "request-failed",
        get,
        head,
        latency: null
      };
    }

    const latency =
      Math.max(
        get,
        head
      );

    return {
      ok:
        latency <=
        MAX_LATENCY,

      reason:
        latency <= MAX_LATENCY
          ? "ok"
          : "slow",

      get,
      head,
      latency
    };
  } catch (error) {
    return {
      ok: false,

      reason:
        error.message ||
        "exception",

      get: null,
      head: null,
      latency: null
    };
  } finally {
    if (xray) {
      try {
        xray.kill(
          "SIGKILL"
        );
      } catch {}
    }

    try {
      fs.unlinkSync(
        filename
      );
    } catch {}
  }
}

async function main() {
  const configs =
    JSON.parse(
      fs.readFileSync(
        "./data/raw.json",
        "utf8"
      )
    );

  const results = [];

  for (
    let i = 0;
    i < configs.length;
    i++
  ) {
    const uri =
      configs[i];

    console.log(
      `[${i + 1}/${configs.length}] checking`
    );

    const result =
      await check(uri);

    console.log(
      result
    );

    results.push({
      uri,
      ...result
    });
  }

  fs.writeFileSync(
    "./data/checked.json",
    JSON.stringify(
      results,
      null,
      2
    )
  );

  console.log(
    "CHECK FINISHED"
  );
}

main();
