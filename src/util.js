import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sha1(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (true) {
      const current = index++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  }
  const count = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: count }, worker));
  return results;
}

export function redactSource(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.host} #${sha1(url).slice(0, 6)}`;
  } catch {
    return `source #${sha1(url).slice(0, 6)}`;
  }
}

const PRIVATE = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) PRIVATE.addSubnet(address, prefix, 'ipv4');
PRIVATE.addAddress('::', 'ipv6');
PRIVATE.addAddress('::1', 'ipv6');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');
PRIVATE.addSubnet('fe80::', 10, 'ipv6');

export function isPublicIp(ip) {
  const family = net.isIP(ip);
  if (!family) return false;
  return !PRIVATE.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

export function flagFromCode(code) {
  const value = String(code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(value) || value === 'UN') return '';
  return [...value].map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join('');
}

export function codeFromFlag(text) {
  const match = String(text || '').match(/[\u{1F1E6}-\u{1F1FF}]{2}/u);
  if (!match) return null;
  return [...match[0]].map((c) => String.fromCharCode(c.codePointAt(0) - 0x1f1e6 + 65)).join('');
}
