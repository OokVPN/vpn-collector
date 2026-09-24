export function parseSocks(uri) {
  try {
    const u = new URL(uri);
    if (u.protocol !== 'socks:' && u.protocol !== 'socks5:') return null;

    const host = u.hostname;
    const port = parseInt(u.port, 10);
    if (!host || !port) return null;

    const users = [];
    if (u.username) {
      users.push({
        user: decodeURIComponent(u.username),
        pass: decodeURIComponent(u.password || '')
      });
    }

    const outbound = {
      protocol: 'socks',
      settings: {
        servers: [{ address: host, port, users }]
      }
    };

    return { host, port, outbound };
  } catch {
    return null;
  }
}
