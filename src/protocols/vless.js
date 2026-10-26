import { buildStream, cleanHost, paramsGetter, parsePort, safeDecode } from './common.js';

export function parseVless(uri) {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'vless:') return null;

    const id = safeDecode(url.username || '');
    const host = cleanHost(url.hostname);
    const port = parsePort(url.port);
    if (!id || !host || !port) return null;

    const get = paramsGetter(url.searchParams);
    const stream = buildStream(get, host);
    if (!stream) return null;

    const user = { id, encryption: get('encryption') || 'none' };
    if (get('flow')) user.flow = get('flow');

    return {
      host,
      port,
      id,
      outbound: {
        protocol: 'vless',
        settings: { vnext: [{ address: host, port, users: [user] }] },
        streamSettings: stream
      }
    };
  } catch {
    return null;
  }
}
