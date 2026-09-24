import { parseVless } from './protocols/vless.js';
import { parseVmess } from './protocols/vmess.js';
import { parseTrojan } from './protocols/trojan.js';
import { parseShadowsocks } from './protocols/shadowsocks.js';
import { parseSocks } from './protocols/socks.js';
import { parseHysteria2 } from './protocols/hysteria2.js';

const PREFIXES = ['vless://', 'vmess://', 'trojan://', 'ss://', 'socks://', 'socks5://', 'hysteria2://', 'hy2://'];

function looksLikeUri(line) {
  return PREFIXES.some((p) => line.startsWith(p));
}

function b64decodeSafe(str) {
  try {
    let s = str.trim().replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const decoded = Buffer.from(s, 'base64').toString('utf8');
    // sanity check: base64 round-trip should be plausible text
    if (/[\uFFFD]/.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function dedupe(arr) {
  return Array.from(new Set(arr));
}

/**
 * Extract a list of raw VPN URIs from arbitrary source text.
 * Handles plain text lists, and whole-body Base64 (including URL-safe) subscriptions.
 */
export function extractUris(text) {
  if (!text) return [];

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^['"]+|['"]+$/g, ''))
    .filter(Boolean);

  const uriLines = lines.filter(looksLikeUri);
  if (uriLines.length > 0) {
    return dedupe(uriLines);
  }

  // Whole content might be a single Base64-encoded subscription blob
  const joined = lines.join('');
  if (joined.length > 0) {
    const decoded = b64decodeSafe(joined);
    if (decoded) {
      const decodedLines = decoded
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .filter(looksLikeUri);
      if (decodedLines.length > 0) return dedupe(decodedLines);
    }
  }

  // Otherwise, each line might individually be Base64
  const perLineDecoded = [];
  for (const line of lines) {
    const d = b64decodeSafe(line);
    if (d && looksLikeUri(d.trim())) perLineDecoded.push(d.trim());
  }
  if (perLineDecoded.length > 0) return dedupe(perLineDecoded);

  return [];
}

function wrap(result) {
  if (!result) return { host: null, port: null, outbound: null };
  return result;
}

/**
 * Parse a single URI into { type, host, port, outbound } using the matching protocol module.
 */
export function parseUri(uri) {
  if (uri.startsWith('vless://')) return { type: 'VLESS', ...wrap(parseVless(uri)) };
  if (uri.startsWith('vmess://')) return { type: 'VMess', ...wrap(parseVmess(uri)) };
  if (uri.startsWith('trojan://')) return { type: 'Trojan', ...wrap(parseTrojan(uri)) };
  if (uri.startsWith('ss://')) return { type: 'SS', ...wrap(parseShadowsocks(uri)) };
  if (uri.startsWith('socks://') || uri.startsWith('socks5://')) return { type: 'SOCKS', ...wrap(parseSocks(uri)) };
  if (uri.startsWith('hysteria2://') || uri.startsWith('hy2://')) return { type: 'HY2', ...wrap(parseHysteria2(uri)) };
  return null;
}

export function getRemark(uri) {
  const hashIdx = uri.indexOf('#');
  if (hashIdx === -1) return '';
  try {
    return decodeURIComponent(uri.slice(hashIdx + 1));
  } catch {
    return uri.slice(hashIdx + 1);
  }
}
