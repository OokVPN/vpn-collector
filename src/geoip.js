import dns from 'node:dns/promises';
import net from 'node:net';
import config, { resolvePath } from './config.js';
import { codeFromFlag, isPublicIp, mapLimit, readJson, writeJson, delay } from './util.js';

const UNKNOWN = { countryCode: 'UN', source: 'none' };

function validCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) && !['XX', 'T1', 'UN', 'ZZ'].includes(code) ? code : null;
}

function readPath(object, dotted) {
  return dotted.split('.').reduce((node, key) => (node === null || node === undefined ? undefined : node[key]), object);
}

export function createGeoResolver(options = config.geoip, cacheFile = resolvePath(config.paths.geoipCache), fetchImpl = (...args) => fetch(...args)) {
  const ttlMs = options.ttlDays * 86400000;
  const now = Date.now();
  const stored = readJson(cacheFile, {});
  const cache = new Map(
    Object.entries(stored && typeof stored === 'object' ? stored : {})
      .filter(([, value]) => value && validCode(value.c) && now - value.t < ttlMs)
  );
  const failures = new Map();
  const hostCache = new Map();
  let dirty = false;

  async function queryProvider(provider, ip) {
    if ((failures.get(provider.name) || 0) >= options.maxFailuresPerProvider) return null;
    const url = provider.url.replace('{ip}', encodeURIComponent(ip));

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetchImpl(url, {
          redirect: 'follow',
          signal: AbortSignal.timeout(options.timeoutMs),
          headers: { Accept: 'application/json', 'User-Agent': config.collector.userAgent }
        });
        if (response.status === 429) {
          await delay(1000 * (attempt + 1));
          continue;
        }
        if (!response.ok) break;
        const data = await response.json();
        if (provider.failIf && readPath(data, provider.failIf)) break;
        if (provider.ok && !Object.entries(provider.ok).every(([key, expected]) => readPath(data, key) === expected)) break;
        const code = validCode(readPath(data, provider.code));
        if (code) {
          failures.set(provider.name, 0);
          return code;
        }
        break;
      } catch {
        await delay(300);
      }
    }
    failures.set(provider.name, (failures.get(provider.name) || 0) + 1);
    return null;
  }

  async function lookupIp(ip) {
    const cached = cache.get(ip);
    if (cached) return cached.c;
    if (!isPublicIp(ip)) return null;

    const tally = new Map();
    const order = [];
    const providers = options.providers;
    let asked = 0;
    let next = 0;

    const ask = async (provider) => {
      asked++;
      const code = await queryProvider(provider, ip);
      if (!code) return;
      tally.set(code, (tally.get(code) || 0) + 1);
      if (!order.includes(code)) order.push(code);
    };
    const best = () => Math.max(0, ...tally.values());

    const first = providers.slice(0, options.quorum);
    next = first.length;
    await Promise.all(first.map(ask));

    while (best() < options.quorum && next < providers.length && asked < options.maxQueriesPerIp) {
      await ask(providers[next++]);
    }

    if (tally.size === 0) return null;
    const top = best();
    const code = order.find((candidate) => tally.get(candidate) === top);
    cache.set(ip, { c: code, t: Date.now() });
    dirty = true;
    return code;
  }

  async function resolveAddresses(host) {
    if (net.isIP(host)) return [host];
    try {
      const addresses = await dns.lookup(host, { all: true, verbatim: true });
      const sorted = [...addresses].sort((a, b) => a.family - b.family).map((item) => item.address);
      return sorted.slice(0, options.maxIpsPerHost);
    } catch {
      return [];
    }
  }

  async function lookup(host, remark = '') {
    const key = String(host || '').trim().toLowerCase();
    if (!key) return UNKNOWN;
    if (hostCache.has(key)) return hostCache.get(key);

    const task = (async () => {
      const addresses = await resolveAddresses(key);
      const votes = new Map();
      for (const address of addresses) {
        const code = await lookupIp(address);
        if (code) votes.set(code, (votes.get(code) || 0) + 1);
      }
      if (votes.size > 0) {
        const [code] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
        return { countryCode: code, source: 'geoip' };
      }
      if (options.useRemarkFlagHint) {
        const hint = validCode(codeFromFlag(remark));
        if (hint) return { countryCode: hint, source: 'remark' };
      }
      return UNKNOWN;
    })();

    hostCache.set(key, task);
    return task;
  }

  async function resolveAll(items, getHost, getRemark, concurrency = options.concurrency) {
    return mapLimit(items, concurrency, (item) => lookup(getHost(item), getRemark ? getRemark(item) : ''));
  }

  function save() {
    if (!dirty) return;
    const data = Object.fromEntries([...cache.entries()].sort(([a], [b]) => a.localeCompare(b)));
    writeJson(cacheFile, data);
    dirty = false;
  }

  return { lookup, resolveAll, save };
}
