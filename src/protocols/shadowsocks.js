function b64decode(str) {
  let s = str.trim().replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

export function parseShadowsocks(uri) {
  try {
    if (!uri.startsWith('ss://')) return null;
    let rest = uri.slice(5);

    const hashIdx = rest.indexOf('#');
    if (hashIdx !== -1) {
      rest = rest.slice(0, hashIdx);
    }

    let method, password, host, port;

    if (rest.includes('@')) {
      // ss://BASE64(method:password)@host:port
      const atIdx = rest.lastIndexOf('@');
      const userInfo = rest.slice(0, atIdx);
      const hostPort = rest.slice(atIdx + 1).split('?')[0].split('/')[0];

      let decodedUser;
      try {
        decodedUser = b64decode(userInfo);
        if (!decodedUser.includes(':')) decodedUser = decodeURIComponent(userInfo);
      } catch {
        decodedUser = decodeURIComponent(userInfo);
      }
      const colonIdx = decodedUser.indexOf(':');
      if (colonIdx === -1) return null;
      method = decodedUser.slice(0, colonIdx);
      password = decodedUser.slice(colonIdx + 1);

      const lastColon = hostPort.lastIndexOf(':');
      if (lastColon === -1) return null;
      host = hostPort.slice(0, lastColon);
      port = parseInt(hostPort.slice(lastColon + 1), 10);
    } else {
      // legacy: ss://BASE64(method:password@host:port)
      const decoded = b64decode(rest.split('?')[0]);
      const m = decoded.match(/^(.+?):(.+)@(.+):(\d+)$/);
      if (!m) return null;
      method = m[1];
      password = m[2];
      host = m[3];
      port = parseInt(m[4], 10);
    }

    if (!method || !password || !host || !port) return null;

    const outbound = {
      protocol: 'shadowsocks',
      settings: {
        servers: [{ address: host, port, method, password }]
      }
    };

    return { host, port, outbound };
  } catch {
    return null;
  }
}
