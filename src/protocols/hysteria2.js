export function parseHysteria2(uri) {
  try {
    const normalized = uri.replace(/^hy2:\/\//i, 'hysteria2://');
    const url = new URL(normalized);
    if (url.protocol !== 'hysteria2:') return null;

    const decode = (value) => {
      try {
        return decodeURIComponent(value || '');
      } catch {
        return value || '';
      }
    };

    const host = url.hostname.replace(/^\[|\]$/g, '');
    const port = Number.parseInt(url.port, 10);
    const username = decode(url.username);
    const password = decode(url.password);
    const queryAuth = url.searchParams.get('auth') || '';
    const auth = queryAuth || (password ? `${username}:${password}` : username);

    if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !auth) return null;

    const params = url.searchParams;
    const serverName = params.get('sni') || host;
    const alpnValue = params.get('alpn') || '';
    const alpn = alpnValue ? alpnValue.split(',').map((item) => item.trim()).filter(Boolean) : ['h3'];
    const fingerprint = params.get('fp') || '';
    const allowInsecure = ['1', 'true', 'yes'].includes(String(params.get('insecure') || '').toLowerCase());

    const hysteriaSettings = {
      version: 2,
      auth
    };

    const streamSettings = {
      network: 'hysteria',
      security: 'tls',
      tlsSettings: {
        serverName,
        alpn,
        ...(fingerprint ? { fingerprint } : {}),
        ...(allowInsecure ? { allowInsecure: true } : {})
      },
      hysteriaSettings
    };

    const obfs = params.get('obfs') || '';
    const obfsPassword = params.get('obfs-password') || '';
    if (obfs) {
      if (obfs.toLowerCase() !== 'salamander' || !obfsPassword) return null;
      streamSettings.udpmasks = [
        {
          type: 'salamander',
          settings: { password: obfsPassword }
        }
      ];
    }

    return {
      host,
      port,
      outbound: {
        protocol: 'hysteria',
        settings: {
          version: 2,
          address: host,
          port
        },
        streamSettings
      }
    };
  } catch {
    return null;
  }
}
