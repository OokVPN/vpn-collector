import { cleanHost, parsePort, safeDecode } from './common.js';

export function parseSocks(uri) {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'socks:' && url.protocol !== 'socks5:') return null;

    const host = cleanHost(url.hostname);
    const port = parsePort(url.port, 1080);
    if (!host || !port) return null;

    const users = url.username
      ? [{ user: safeDecode(url.username), pass: safeDecode(url.password || '') }]
      : [];

    return {
      host,
      port,
      id: url.username || '',
      outbound: {
        protocol: 'socks',
        settings: { servers: [{ address: host, port, users }] }
      }
    };
  } catch {
    return null;
  }
}
