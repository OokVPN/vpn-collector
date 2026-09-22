import fs from "fs";
import { parseConfigs } from "./parser.js";

const sources = JSON.parse(
  fs.readFileSync(
    "./sources.json",
    "utf8"
  )
);

async function download(url) {
  try {
    const response = await fetch(
      url,
      {
        signal:
          AbortSignal.timeout(20000),

        headers: {
          "User-Agent":
            "VPN-Collector/1.0"
        }
      }
    );

    if (!response.ok) {
      console.log(
        `FAILED ${response.status}: ${url}`
      );

      return [];
    }

    const text =
      await response.text();

    return parseConfigs(text);
  } catch {
    console.log(
      `FAILED: ${url}`
    );

    return [];
  }
}

async function main() {
  const all = [];

  for (const source of sources) {
    console.log(
      `SOURCE: ${source}`
    );

    const configs =
      await download(source);

    console.log(
      `FOUND: ${configs.length}`
    );

    all.push(...configs);
  }

  const unique =
    [...new Set(all)];

  fs.writeFileSync(
    "./data/raw.json",
    JSON.stringify(
      unique,
      null,
      2
    )
  );

  console.log(
    `TOTAL: ${unique.length}`
  );
}

main();
