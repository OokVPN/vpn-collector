import { cleanHost, decodeBase64, parsePort, safeDecode } from './common.js';

function splitUserInfo(userInfo) {
  const decoded = safeDecode(userInfo);
  if (/^[^:]+:.+$/.test(decoded) && !/^[A-Za-z0-9+/_-]+=*$/.test(decoded)) return decoded;
  try {
    const value = decodeBase64(decoded);
    if (value.includes(':')) return value;
  } catch {}
  return decoded.includes(':') ? decoded : null;
}

export function parseShadowsocks(uri) {
  try {
    if (!uri.startsWith('ss://')) return null;
    let rest = uri.slice(5);

    const hashIndex = rest.indexOf('#');
    if (hashIndex !== -1) rest = rest.slice(0, hashIndex);

    const queryIndex = rest.indexOf('?');
    const query = queryIndex === -1 ? '' : rest.slice(queryIndex + 1);
    if (queryIndex !== -1) rest = rest.slice(0, queryIndex);
    rest = rest.replace(/\/+$/, '');

    const plugin = new URLSearchParams(query).get('plugin');
    if (plugin && plugin.toLowerCase() !== 'none') return null;

    let method;
    let password;
    let host;
    let port;

    if (rest.includes('@')) {
      const at = rest.lastIndexOf('@');
      const credentials = splitUserInfo(rest.slice(0, at));
      if (!credentials) return null;
      const colon = credentials.indexOf(':');
      method = credentials.slice(0, colon);
      password = credentials.slice(colon + 1);

      const hostPort = rest.slice(at + 1);
      const lastColon = hostPort.lastIndexOf(':');
      if (lastColon === -1) return null;
      host = cleanHost(hostPort.slice(0, lastColon));
      port = parsePort(hostPort.slice(lastColon + 1));
    } else {
      const match = decodeBase64(rest).match(/^(.+?):(.+)@(.+):(\d+)$/s);
      if (!match) return null;
      method = match[1];
      password = match[2];
      host = cleanHost(match[3]);
      port = parsePort(match[4]);
    }

    if (!method || !password || !host || !port) return null;

    return {
      host,
      port,
      id: password,
      outbound: {
        protocol: 'shadowsocks',
        settings: { servers: [{ address: host, port, method, password }] }
      }
    };
  } catch {
    return null;
  }
}
