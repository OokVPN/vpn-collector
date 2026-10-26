import { cleanHost, parsePort, safeDecode, splitList, truthy } from './common.js';

export function parseHysteria2(uri) {
  try {
    const url = new URL(uri.replace(/^hy2:\/\//i, 'hysteria2://'));
    if (url.protocol !== 'hysteria2:') return null;

    const host = cleanHost(url.hostname);
    const port = parsePort(url.port, 443);
    const username = safeDecode(url.username || '');
    const password = safeDecode(url.password || '');
    const params = url.searchParams;
    const auth = params.get('auth') || (password ? `${username}:${password}` : username);
    if (!host || !port || !auth) return null;

    const tlsSettings = {
      serverName: params.get('sni') || host,
      alpn: splitList(params.get('alpn')) || ['h3']
    };
    if (params.get('fp')) tlsSettings.fingerprint = params.get('fp');
    if (truthy(params.get('insecure') ?? params.get('allowInsecure'))) tlsSettings.allowInsecure = true;

    const streamSettings = {
      network: 'hysteria',
      security: 'tls',
      tlsSettings,
      hysteriaSettings: { version: 2, auth }
    };

    const obfs = params.get('obfs') || '';
    if (obfs) {
      const obfsPassword = params.get('obfs-password') || '';
      if (obfs.toLowerCase() !== 'salamander' || !obfsPassword) return null;
      streamSettings.udpmasks = [{ type: 'salamander', settings: { password: obfsPassword } }];
    }

    return {
      host,
      port,
      id: auth,
      outbound: {
        protocol: 'hysteria',
        settings: { version: 2, address: host, port },
        streamSettings
      }
    };
  } catch {
    return null;
  }
}
