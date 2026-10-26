import { buildStream, decodeBase64, parsePort } from './common.js';

export function parseVmess(uri) {
  try {
    if (!uri.startsWith('vmess://')) return null;
    const payload = uri.slice(8).split('#')[0];
    const json = JSON.parse(decodeBase64(payload));

    const host = String(json.add || '').trim();
    const port = parsePort(json.port);
    const id = String(json.id || '').trim();
    if (!host || !port || !id) return null;

    const tls = json.tls === true ? 'tls' : String(json.tls || 'none').toLowerCase();
    const values = {
      type: json.net,
      security: tls,
      path: json.path,
      host: json.host,
      sni: json.sni,
      fp: json.fp,
      alpn: json.alpn,
      headerType: json.type,
      serviceName: json.path,
      mode: json.type === 'multi' ? 'multi' : undefined,
      authority: json.authority,
      allowInsecure: json.allowInsecure ?? json.insecure
    };
    const get = (name) => {
      const value = values[name];
      return value === undefined || value === null || value === '' ? undefined : String(value);
    };

    const stream = buildStream(get, host);
    if (!stream) return null;

    const alterId = Number.parseInt(json.aid || '0', 10) || 0;

    return {
      host,
      port,
      id,
      remark: json.ps ? String(json.ps) : '',
      outbound: {
        protocol: 'vmess',
        settings: {
          vnext: [{ address: host, port, users: [{ id, alterId, security: json.scy || 'auto' }] }]
        },
        streamSettings: stream
      }
    };
  } catch {
    return null;
  }
}
