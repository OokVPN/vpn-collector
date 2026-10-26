import { buildStream, cleanHost, paramsGetter, parsePort, safeDecode } from './common.js';

export function parseTrojan(uri) {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'trojan:') return null;

    const password = safeDecode(url.username || '');
    const host = cleanHost(url.hostname);
    const port = parsePort(url.port);
    if (!password || !host || !port) return null;

    const stream = buildStream(paramsGetter(url.searchParams), host, { security: 'tls' });
    if (!stream) return null;

    return {
      host,
      port,
      id: password,
      outbound: {
        protocol: 'trojan',
        settings: { servers: [{ address: host, port, password }] },
        streamSettings: stream
      }
    };
  } catch {
    return null;
  }
}
