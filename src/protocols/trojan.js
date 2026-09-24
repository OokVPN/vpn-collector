export function parseTrojan(uri) {
  try {
    const u = new URL(uri);
    if (u.protocol !== 'trojan:') return null;

    const password = decodeURIComponent(u.username || '');
    const host = u.hostname;
    const port = parseInt(u.port, 10);
    if (!password || !host || !port) return null;

    const p = u.searchParams;
    const security = p.get('security') || 'tls';
    const network = p.get('type') || 'tcp';

    const streamSettings = { network, security };

    if (network === 'ws') {
      streamSettings.wsSettings = {
        path: p.get('path') || '/',
        headers: p.get('host') ? { Host: p.get('host') } : undefined
      };
    } else if (network === 'grpc') {
      streamSettings.grpcSettings = {
        serviceName: p.get('serviceName') || '',
        multiMode: (p.get('mode') || 'gun') === 'multi'
      };
    } else if (network === 'xhttp') {
      streamSettings.xhttpSettings = {
        path: p.get('path') || '/',
        host: p.get('host') || host,
        mode: p.get('mode') || 'auto'
      };
    } else if (network === 'httpupgrade') {
      streamSettings.httpupgradeSettings = {
        path: p.get('path') || '/',
        host: p.get('host') || host
      };
    }

    if (security === 'tls') {
      streamSettings.tlsSettings = {
        serverName: p.get('sni') || host,
        fingerprint: p.get('fp') || undefined
      };
    }

    const outbound = {
      protocol: 'trojan',
      settings: {
        servers: [{ address: host, port, password }]
      },
      streamSettings
    };

    return { host, port, outbound };
  } catch {
    return null;
  }
}
