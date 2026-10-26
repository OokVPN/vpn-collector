export function cleanHost(value) {
  return String(value || '').trim().replace(/^\[|\]$/g, '');
}

export function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parsePort(value, fallback = null) {
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

export function decodeBase64(value) {
  const normalized = String(value).trim().replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

export function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}

export function splitList(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const items = String(value).split(',').map((item) => item.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

const NETWORKS = {
  tcp: 'tcp',
  raw: 'tcp',
  ws: 'ws',
  websocket: 'ws',
  grpc: 'grpc',
  gun: 'grpc',
  xhttp: 'xhttp',
  splithttp: 'xhttp',
  httpupgrade: 'httpupgrade',
  kcp: 'kcp',
  mkcp: 'kcp',
  h2: 'h2',
  http: 'h2'
};

export function paramsGetter(searchParams) {
  return (name) => {
    const value = searchParams.get(name);
    return value === null || value === '' ? undefined : value;
  };
}

export function buildStream(get, host, defaults = {}) {
  const network = NETWORKS[String(get('type') ?? defaults.network ?? 'tcp').toLowerCase()];
  if (!network) return null;

  const security = String(get('security') ?? defaults.security ?? 'none').toLowerCase();
  if (!['none', 'tls', 'reality'].includes(security)) return null;

  const stream = { network, security };
  const path = get('path');
  const hostHeader = get('host');

  if (network === 'tcp') {
    if (String(get('headerType') || 'none').toLowerCase() === 'http') {
      stream.tcpSettings = {
        header: {
          type: 'http',
          request: {
            path: splitList(path) || ['/'],
            headers: hostHeader ? { Host: splitList(hostHeader) } : {}
          }
        }
      };
    }
  } else if (network === 'ws') {
    stream.wsSettings = { path: path || '/' };
    if (hostHeader) stream.wsSettings.headers = { Host: hostHeader };
  } else if (network === 'grpc') {
    stream.grpcSettings = {
      serviceName: get('serviceName') || path || '',
      multiMode: String(get('mode') || '').toLowerCase() === 'multi'
    };
    if (get('authority')) stream.grpcSettings.authority = get('authority');
  } else if (network === 'xhttp') {
    stream.xhttpSettings = { path: path || '/', mode: get('mode') || 'auto' };
    if (hostHeader) stream.xhttpSettings.host = hostHeader;
    if (get('extra')) {
      try {
        stream.xhttpSettings.extra = JSON.parse(get('extra'));
      } catch {
        return null;
      }
    }
  } else if (network === 'httpupgrade') {
    stream.httpupgradeSettings = { path: path || '/' };
    if (hostHeader) stream.httpupgradeSettings.host = hostHeader;
  } else if (network === 'kcp') {
    stream.kcpSettings = { header: { type: get('headerType') || 'none' } };
    if (get('seed')) stream.kcpSettings.seed = get('seed');
  } else if (network === 'h2') {
    stream.httpSettings = { path: path || '/' };
    if (hostHeader) stream.httpSettings.host = splitList(hostHeader);
  }

  const serverName = get('sni') || get('serverName') || (['ws', 'httpupgrade', 'xhttp', 'h2'].includes(network) ? hostHeader : undefined) || host;

  if (security === 'tls') {
    stream.tlsSettings = { serverName };
    const fingerprint = get('fp') || get('fingerprint');
    if (fingerprint) stream.tlsSettings.fingerprint = fingerprint;
    const alpn = splitList(get('alpn'));
    if (alpn) stream.tlsSettings.alpn = alpn;
    if (truthy(get('allowInsecure') ?? get('insecure'))) stream.tlsSettings.allowInsecure = true;
    if (get('ech')) stream.tlsSettings.echConfigList = get('ech');
  } else if (security === 'reality') {
    const publicKey = get('pbk') || get('publicKey');
    if (!publicKey) return null;
    stream.realitySettings = {
      serverName,
      fingerprint: get('fp') || get('fingerprint') || 'chrome',
      publicKey,
      shortId: get('sid') || get('shortId') || '',
      spiderX: get('spx') || get('spiderX') || ''
    };
    if (get('pqv')) stream.realitySettings.mldsa65Verify = get('pqv');
  }

  return stream;
}
