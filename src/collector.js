import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import config, { resolvePath } from './config.js';
import { extractUris } from './parser.js';
import { delay, mapLimit, readJson, redactSource, writeJson } from './util.js';

function loadSources() {
  const entries = [];

  for (const file of config.paths.sources) {
    const full = resolvePath(file);
    if (!fs.existsSync(full)) {
      console.log(`SOURCES FILE MISSING: ${file}`);
      continue;
    }
    const data = readJson(full, null);
    if (Array.isArray(data)) entries.push(...data);
    else console.log(`SOURCES FILE INVALID (array expected): ${file}`);
  }

  const envName = config.collector.extraSourcesEnv;
  if (envName && process.env[envName]) {
    entries.push(...process.env[envName].split(/\s+/).filter(Boolean));
  }

  const unique = new Map();
  for (const entry of entries) {
    const normalized = typeof entry === 'string' ? { url: entry } : entry;
    if (!normalized || typeof normalized.url !== 'string' || !/^https?:\/\//i.test(normalized.url)) continue;
    if (!unique.has(normalized.url)) unique.set(normalized.url, normalized);
  }
  return [...unique.values()];
}

async function fetchText(entry) {
  const { timeoutMs, retries, retryDelayMs, userAgent, maxBodyBytes } = config.collector;
  const label = redactSource(entry.url);

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(entry.url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': entry.userAgent || userAgent, Accept: '*/*', ...(entry.headers || {}) }
      });
      if (response.status === 429 || response.status >= 500) throw new Error(`HTTP ${response.status}`);
      if (!response.ok) {
        console.log(`SOURCE FAIL (HTTP ${response.status}): ${label}`);
        return null;
      }
      const body = Buffer.from(await response.arrayBuffer());
      return body.subarray(0, maxBodyBytes).toString('utf8');
    } catch (error) {
      if (attempt === retries) {
        console.log(`SOURCE ERROR: ${label} (${error.message})`);
        return null;
      }
      await delay(retryDelayMs * (attempt + 1));
    }
  }
  return null;
}

export async function collectAll() {
  const sources = loadSources();
  const rawPath = resolvePath(config.paths.raw);

  if (sources.length === 0) {
    console.log('No sources configured.');
    return { uris: readJson(rawPath, []), fetched: 0, failed: 0 };
  }

  const found = new Set();
  let fetched = 0;
  let failed = 0;

  await mapLimit(sources, config.collector.concurrency, async (entry) => {
    const label = redactSource(entry.url);
    const text = await fetchText(entry);
    if (text === null) {
      failed++;
      return;
    }
    fetched++;
    const uris = extractUris(text);
    console.log(`SOURCE ${label}: ${uris.length} URI`);
    for (const uri of uris) found.add(uri);
  });

  const uris = [...found];
  console.log(`TOTAL: ${uris.length} (sources ok ${fetched}, failed ${failed})`);

  if (uris.length > 0) {
    writeJson(rawPath, uris);
    console.log(`Saved to ${rawPath}`);
    return { uris, fetched, failed };
  }

  console.log('Nothing collected; keeping previous raw.json');
  return { uris: readJson(rawPath, []), fetched, failed };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  collectAll()
    .then((result) => {
      if (result.fetched === 0 && result.failed > 0) process.exit(1);
    })
    .catch((error) => {
      console.error('COLLECTOR FATAL:', error);
      process.exit(1);
    });
}
