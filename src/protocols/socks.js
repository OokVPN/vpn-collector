herefunction number(value, fallback) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

export function parseSocks(
  uri,
  tag
) {
  const url =
    new URL(uri);

  const protocol =
    url.protocol
      .replace(":", "")
      .toLowerCase();

  if (
    protocol !== "socks" &&
    protocol !== "socks5"
  ) {
    throw new Error(
      "Invalid SOCKS URI"
    );
  }

  const host =
    url.hostname;

  const port =
    number(
      url.port,
      1080
    );

  if (!host) {
    throw new Error(
      "SOCKS host missing"
    );
  }

  const settings = {
    servers: [
      {
        address:
          host,

        port,

        users: []
      }
    ]
  };

  /*
   * SOCKS URI:
   *
   * socks://username:password@host:port
   */

  if (
    url.username ||
    url.password
  ) {
    settings.servers[0].users.push({
      user:
        decodeURIComponent(
          url.username || ""
        ),

      pass:
        decodeURIComponent(
          url.password || ""
        )
    });
  }

  return {
    tag,

    protocol:
      "socks",

    settings
  };
}
