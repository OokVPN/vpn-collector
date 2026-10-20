import { parseVless } from './protocols/vless.js';
import { parseVmess } from './protocols/vmess.js';
import { parseTrojan } from './protocols/trojan.js';
import { parseShadowsocks } from './protocols/shadowsocks.js';
import { parseSocks } from './protocols/socks.js';
import { parseHysteria2 } from './protocols/hysteria2.js';

const PREFIXES = [
  'vless://',
  'vmess://',
  'trojan://',
  'ss://',
  'socks://',
  'socks5://',
  'hysteria2://',
  'hy2://'
];

const URI_PATTERN =
  /(?:vless|vmess|trojan|ss|socks5?|hysteria2|hy2):\/\/[^\s"'<>`]+/gi;

function normalizeUri(uri) {
  return uri
    .replace(/&amp;/gi, '&')
    .replace(/[),\]}]+$/g, '')
    .replace(/[.!?;]+$/g, '')
    .trim();
}

function looksLikeUri(value) {
  const line = value.trim().replace(/^\uFEFF/, '').toLowerCase();
  return PREFIXES.some((prefix) => line.startsWith(prefix));
}

function b64decodeSafe(str) {
  try {
    let value = str
      .trim()
      .replace(/-/g, '+')
      .replace(/_/g, '/');

    while (value.length % 4 !== 0) {
      value += '=';
    }

    const decoded = Buffer.from(value, 'base64').toString('utf8');

    if (!decoded || decoded.includes('\uFFFD')) {
      return null;
    }

    return decoded;
  } catch {
    return null;
  }
}

function dedupe(values) {
  return [...new Set(values)];
}

function extractFromText(text) {
  const matches = text.match(URI_PATTERN) || [];

  return matches
    .map(normalizeUri)
    .filter(looksLikeUri);
}

export function extractUris(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const input = text
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, '')
    .trim();

  if (!input) {
    return [];
  }

  // 1. Extract links from raw text, HTML, JSON, or embedded content.
  const directUris = extractFromText(input);

  if (directUris.length > 0) {
    return dedupe(directUris);
  }

  // 2. Try decoding the entire response as a Base64 subscription.
  const joined = input
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('');

  if (joined) {
    const decoded = b64decodeSafe(joined);

    if (decoded) {
      const decodedUris = extractFromText(decoded);

      if (decodedUris.length > 0) {
        return dedupe(decodedUris);
      }
    }
  }

  // 3. Try decoding individual lines.
  const decodedUris = [];

  for (const line of input.split('\n')) {
    const decoded = b64decodeSafe(line.trim());

    if (!decoded) {
      continue;
    }

    decodedUris.push(...extractFromText(decoded));
  }

  return dedupe(decodedUris);
}

function wrap(result) {
  if (!result) {
    return {
      host: null,
      port: null,
      outbound: null
    };
  }

  return result;
}

export function parseUri(uri) {
  if (typeof uri !== 'string') {
    return null;
  }

  const value = uri.trim().replace(/^\uFEFF/, '');

  if (value.startsWith('vless://')) {
    return {
      type: 'VLESS',
      ...wrap(parseVless(value))
    };
  }

  if (value.startsWith('vmess://')) {
    return {
      type: 'VMess',
      ...wrap(parseVmess(value))
    };
  }

  if (value.startsWith('trojan://')) {
    return {
      type: 'Trojan',
      ...wrap(parseTrojan(value))
    };
  }

  if (value.startsWith('ss://')) {
    return {
      type: 'SS',
      ...wrap(parseShadowsocks(value))
    };
  }

  if (
    value.startsWith('socks://') ||
    value.startsWith('socks5://')
  ) {
    return {
      type: 'SOCKS',
      ...wrap(parseSocks(value))
    };
  }

  if (
    value.startsWith('hysteria2://') ||
    value.startsWith('hy2://')
  ) {
    return {
      type: 'HY2',
      ...wrap(parseHysteria2(value))
    };
  }

  return null;
}

export function getRemark(uri) {
  if (typeof uri !== 'string') {
    return '';
  }

  const hashIndex = uri.indexOf('#');

  if (hashIndex === -1) {
    return '';
  }

  const remark = uri.slice(hashIndex + 1);

  try {
    return decodeURIComponent(remark);
  } catch {
    return remark;
  }
}
