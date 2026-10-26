import config from './config.js';
import { sha1, isPublicIp } from './util.js';
import net from 'node:net';
import { parseVless } from './protocols/vless.js';
import { parseVmess } from './protocols/vmess.js';
import { parseTrojan } from './protocols/trojan.js';
import { parseShadowsocks } from './protocols/shadowsocks.js';
import { parseSocks } from './protocols/socks.js';
import { parseHysteria2 } from './protocols/hysteria2.js';

const SCHEMES = 'vless|vmess|trojan|ss|socks5?|hysteria2|hy2';
const SCHEME_START = new RegExp(`^(?:${SCHEMES})://`, 'i');
const EMBEDDED = new RegExp(`(?:${SCHEMES})://[^\\s"'<>\`]+`, 'gi');
const BASE64_BODY = /^[A-Za-z0-9+/_-]+={0,2}$/;
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;

function unescapeText(text) {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/');
}

function stripPunctuation(value) {
  return value.replace(/[.,;:!?)\]}'"]+$/, '');
}

function unwrapLine(line) {
  const cleaned = line
    .trim()
    .replace(/^[\s"'`\-*•>]+/, '')
    .replace(/[\s"'`,]+$/, '');
  return SCHEME_START.test(cleaned) ? cleaned : null;
}

function decodeBase64Text(value) {
  if (value.length < 16 || !BASE64_BODY.test(value)) return null;
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  if (!decoded || decoded.includes('\uFFFD')) return null;
  return decoded;
}

function walkJson(node, visit) {
  if (typeof node === 'string') visit(node);
  else if (Array.isArray(node)) node.forEach((item) => walkJson(item, visit));
  else if (node && typeof node === 'object') Object.values(node).forEach((item) => walkJson(item, visit));
}

function collect(text, depth, found) {
  const input = unescapeText(String(text || '').replace(INVISIBLE, '').replace(/\r/g, '')).trim();
  if (!input) return;

  if (input[0] === '[' || input[0] === '{') {
    try {
      walkJson(JSON.parse(input), (value) => collect(value, depth + 1, found));
      return;
    } catch {}
  }

  const rest = [];
  for (const line of input.split('\n')) {
    const uri = unwrapLine(line);
    if (uri) found.add(uri);
    else rest.push(line);
  }

  const restText = rest.join('\n');
  for (const match of restText.matchAll(EMBEDDED)) found.add(stripPunctuation(match[0]));

  if (depth >= config.parser.maxDecodeDepth) return;

  const before = found.size;
  const whole = decodeBase64Text(restText.replace(/\s+/g, ''));
  if (whole) collect(whole, depth + 1, found);
  if (found.size > before) return;

  for (const line of rest) {
    const decoded = decodeBase64Text(line.trim());
    if (decoded) collect(decoded, depth + 1, found);
  }
}

export function extractUris(text) {
  if (!text || typeof text !== 'string') return [];
  const found = new Set();
  collect(text, 0, found);
  return [...found];
}

function hostPattern(pattern) {
  const escaped = pattern.toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

const REJECT_HOSTS = (config.parser.rejectHosts || []).map(hostPattern);
const REJECT_IDS = new Set((config.parser.rejectIds || []).map((value) => value.toLowerCase()));

function isPlaceholder(host, id) {
  const normalized = String(host).toLowerCase();
  if (REJECT_HOSTS.some((regex) => regex.test(normalized))) return true;
  if (id && REJECT_IDS.has(String(id).toLowerCase())) return true;
  if (config.parser.rejectPrivateAddresses && net.isIP(normalized) && !isPublicIp(normalized)) return true;
  return false;
}

export function getRemark(uri) {
  if (typeof uri !== 'string') return '';
  const index = uri.indexOf('#');
  if (index === -1) return '';
  const remark = uri.slice(index + 1);
  try {
    return decodeURIComponent(remark);
  } catch {
    return remark;
  }
}

const PARSERS = [
  [/^vless:\/\//i, 'VLESS', parseVless],
  [/^vmess:\/\//i, 'VMess', parseVmess],
  [/^trojan:\/\//i, 'Trojan', parseTrojan],
  [/^ss:\/\//i, 'SS', parseShadowsocks],
  [/^socks5?:\/\//i, 'SOCKS', parseSocks],
  [/^(?:hysteria2|hy2):\/\//i, 'HY2', parseHysteria2]
];

export function parseUri(uri) {
  if (typeof uri !== 'string') return null;
  const value = uri.trim().replace(/^\uFEFF/, '');

  for (const [pattern, type, parse] of PARSERS) {
    if (!pattern.test(value)) continue;
    const normalized = value.replace(pattern, (prefix) => prefix.toLowerCase());
    const result = parse(normalized);
    if (!result || !result.outbound || !result.host || !result.port) return null;
    if (isPlaceholder(result.host, result.id)) return null;
    return {
      type,
      host: result.host,
      port: result.port,
      outbound: result.outbound,
      remark: result.remark || getRemark(value)
    };
  }
  return null;
}

export function nodeKey(parsed) {
  return sha1(JSON.stringify([parsed.type, parsed.host, parsed.port, parsed.outbound]));
}
