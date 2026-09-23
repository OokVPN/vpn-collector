import fs from "fs";
import { parseConfigs } from "./parser.js";

const sources = JSON.parse(
  fs.readFileSync("./sources.json", "utf8")
);

async function download(url) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: {
        "User-Agent": "VPN-Collector/1.0"
      }
    });

    if (!response.ok) {
      console.log(`FAILED ${response.status}: ${url}`);
      return [];
    }

    const text = await response.text();
    const configs = parseConfigs(text);

    console.log(`SOURCE FOUND: ${configs.length}`);

    return configs;
  } catch (error) {
    console.log(
      `FAILED: ${url} ${error?.message || ""}`
    );

    return [];
  }
}

function interleave(groups) {
  const result = [];
  let index = 0;

  while (true) {
    let added = false;

    for (const group of groups) {
      if (index < group.length) {
        result.push(group[index]);
        added = true;
      }
    }

    if (!added) {
      break;
    }

    index++;
  }

  return result;
}

async function main() {
  const groups = [];

  for (const source of sources) {
    console.log(`SOURCE: ${source}`);

    const configs = await download(source);

    console.log(
      `FOUND: ${configs.length}: ${source}`
    );

    groups.push(configs);
  }

  const combined = interleave(groups);

  const unique = [
    ...new Set(combined)
  ];

  fs.writeFileSync(
    "./data/raw.json",
    JSON.stringify(unique, null, 2)
  );

  console.log(
    `TOTAL UNIQUE: ${unique.length}`
  );
}

main();
