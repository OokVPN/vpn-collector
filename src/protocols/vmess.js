function b64decode(str) {
  let s = str.trim().replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

export function parseVmess(uri) {
  try {
    if (!uri.startsWith('vmess://')) return null;
    const b64 = uri.slice(8).split('#')[0];
    const json = JSON.parse(b64decode(b64));

    const host = json.add;
    const port = parseInt(json.port, 10);
    const id = json.id;
    if (!host || !port || !id) return null;

    const aid = parseInt(json.aid || '0', 10);
    const scy = json.scy || 'auto';
    let network = json.net || 'tcp';
    const tlsOn = json.tls === 'tls' || json.tls === true;

    const streamSettings = { network, security: tlsOn ? 'tls' : 'none' };

    if (network === 'ws') {
      streamSettings.wsSettings = {
        path: json.path || '/',
        headers: json.host ? { Host: json.host } : undefined
      };
    } else if (network === 'grpc') {
      streamSettings.grpcSettings = {
        serviceName: json.path || '',
        multiMode: json.type === 'multi'
      };
    } else if (network === 'h2' || network === 'xhttp') {
      streamSettings.network = 'xhttp';
      streamSettings.xhttpSettings = {
        path: json.path || '/',
        host: json.host || host,
        mode: 'auto'
      };
    } else if (network === 'httpupgrade') {
      streamSettings.httpupgradeSettings = {
        path: json.path || '/',
        host: json.host || host
      };
    } else if (network === 'kcp') {
      streamSettings.kcpSettings = { header: { type: json.type || 'none' } };
    }

    if (tlsOn) {
      streamSettings.tlsSettings = {
        serverName: json.sni || json.host || host,
        fingerprint: json.fp || undefined,
        alpn: json.alpn ? String(json.alpn).split(',') : undefined
      };
    }

    const outbound = {
      protocol: 'vmess',
      settings: {
        vnext: [
          {
            address: host,
            port,
            users: [{ id, alterId: aid, security: scy }]
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
