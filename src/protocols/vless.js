export function parseVless(uri) {
  try {
    const u = new URL(uri);
    if (u.protocol !== 'vless:') return null;

    const uuid = decodeURIComponent(u.username || '');
    const host = u.hostname;
    const port = parseInt(u.port, 10);
    if (!uuid || !host || !port) return null;

    const p = u.searchParams;
    const security = p.get('security') || 'none';
    const network = p.get('type') || 'tcp';
    const flow = p.get('flow') || undefined;
    const encryption = p.get('encryption') || 'none';

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
        serverName: p.get('sni') || p.get('serverName') || host,
        fingerprint: p.get('fp') || p.get('fingerprint') || undefined,
        alpn: p.get('alpn') ? p.get('alpn').split(',') : undefined
      };
    } else if (security === 'reality') {
      streamSettings.realitySettings = {
        serverName: p.get('sni') || p.get('serverName') || host,
        fingerprint: p.get('fp') || p.get('fingerprint') || 'chrome',
        publicKey: p.get('pbk') || p.get('publicKey') || '',
        shortId: p.get('sid') || p.get('shortId') || '',
        spiderX: p.get('spx') || p.get('spiderX') || ''
      };
    }

    const user = { id: uuid, encryption };
    if (flow) user.flow = flow;

    const outbound = {
      protocol: 'vless',
      settings: {
        vnext: [
          {
            address: host,
            port,
            users: [user]
          }
        ]
      },
      streamSettings
    };

    return { host, port, outbound };
  } catch {
    return null;
  }
}
