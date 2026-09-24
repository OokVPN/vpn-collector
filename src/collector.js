import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { extractUris } from './parser.js';

const SOURCES_PATH = path.resolve('sources.json');
const OUTPUT_PATH = path.resolve('data/raw.json');
const TIMEOUT = parseInt(process.env.HTTP_TIMEOUT || '10000', 10);
const USER_AGENT = 'vpn-collector/1.0';

function fetchUrl(url) {
  return new Promise((resolve) => {
    let lib;
    try {
      lib = url.startsWith('https://') ? https : http;
    } catch {
      resolve('');
      return;
    }

    const req = lib.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout: TIMEOUT }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        console.log(`SOURCE FAIL (HTTP ${res.statusCode}): ${url}`);
        res.resume();
        resolve('');
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
      res.on('error', () => resolve(data));
    });

    req.on('timeout', () => {
      req.destroy();
      console.log(`SOURCE TIMEOUT: ${url}`);
      resolve('');
    });
    req.on('error', (err) => {
      console.log(`SOURCE ERROR: ${url} (${err.message})`);
      resolve('');
    });
  });
}

async function main() {
  if (!fs.existsSync(SOURCES_PATH)) {
    console.error('sources.json not found');
    process.exit(1);
  }

  const sources = JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf8'));
  if (!Array.isArray(sources)) {
    console.error('sources.json must be an array');
    process.exit(1);
  }
  if (sources.length === 0) {
    console.log('sources.json is empty — nothing to collect. Add source URLs and re-run.');
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    if (!fs.existsSync(OUTPUT_PATH)) fs.writeFileSync(OUTPUT_PATH, '[]');
    return;
  }

  const CONCURRENCY = parseInt(process.env.SOURCE_CONCURRENCY || '10', 10);
  const all = new Set();
  let idx = 0;

  async function worker() {
    while (idx < sources.length) {
      const current = idx++;
      const entry = sources[current];
      const url = typeof entry === 'string' ? entry : entry.url;
      if (!url) continue;
      console.log(`SOURCE: ${url}`);
      const text = await fetchUrl(url);
      const found = extractUris(text);
      console.log(`FOUND: ${found.length}`);
      for (const uri of found) all.add(uri);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(CONCURRENCY, sources.length)) }, () => worker());
  await Promise.all(workers);

  const result = Array.from(all);
  console.log(`TOTAL: ${result.length}`);

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));
  console.log(`Saved to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error('COLLECTOR FATAL:', err);
  process.exit(1);
});
