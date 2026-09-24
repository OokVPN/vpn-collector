export function parseHysteria2(uri) {
  try {
    const normalized = uri.replace(/^hy2:\/\//, 'hysteria2://');
    const u = new URL(normalized);
    if (u.protocol !== 'hysteria2:') return null;

    const password = decodeURIComponent(u.username || '') || decodeURIComponent(u.searchParams.get('auth') || '');
    const host = u.hostname;
    const port = parseInt(u.port, 10);
    if (!host || !port || !password) return null;

    const p = u.searchParams;
    const obfsType = p.get('obfs');

    const outbound = {
      protocol: 'hysteria2',
      settings: {
        servers: [
          {
            address: host,
            port,
            password
          }
        ]
      },
      streamSettings: {
        network: 'hysteria2',
        security: 'tls',
        hysteria2Settings: {
          password,
          obfs: obfsType
            ? { type: obfsType, password: p.get('obfs-password') || '' }
            : undefined
        },
        tlsSettings: {
          serverName: p.get('sni') || host
        }
      }
    };

    return { host, port, outbound };
  } catch {
    return null;
  }
}
