function decodeBase64(value) {
  let input = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/\s+/g, "");

  input += "=".repeat(
    (4 - input.length % 4) % 4
  );

  return Buffer
    .from(input, "base64")
    .toString("utf8");
}

function number(value, fallback) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

export function parseShadowsocks(
  uri,
  tag
) {
  const raw =
    uri.slice("ss://".length);

  /*
   * Legacy / SIP002:
   *
   * ss://BASE64@host:port
   */

  let url;

  try {
    url =
      new URL(uri);
  } catch {
    throw new Error(
      "Invalid Shadowsocks URI"
    );
  }

  let userInfo =
    url.username;

  let host =
    url.hostname;

  let port =
    number(
      url.port,
      0
    );

  /*
   * Если username полностью
   * закодирован в base64.
   */

  if (
    userInfo &&
    !userInfo.includes(":")
  ) {
    try {
      const decoded =
        decodeBase64(
          userInfo
        );

      if (
        decoded.includes(":")
      ) {
        userInfo =
          decoded;
      }
    } catch {}
  }

  /*
   * Иногда весь authority
   * находится в base64:
   *
   * ss://BASE64
   */

  if (
    (!host || !port) &&
    raw &&
    !raw.includes("@")
  ) {
    try {
      const decoded =
        decodeBase64(
          raw.split("#")[0]
        );

      const match =
        decoded.match(
          /^([^:]+):([^@]+)@(.+):(\d+)$/
        );

      if (match) {
        userInfo =
          `${match[1]}:${match[2]}`;

        host =
          match[3];

        port =
          Number(match[4]);
      }
    } catch {}
  }

  if (
    !userInfo ||
    !host ||
    !port
  ) {
    throw new Error(
      "Invalid Shadowsocks URI"
    );
  }

  const separator =
    userInfo.indexOf(":");

  if (
    separator <= 0
  ) {
    throw new Error(
      "Invalid Shadowsocks credentials"
    );
  }

  const method =
    userInfo.slice(
      0,
      separator
    );

  const password =
    userInfo.slice(
      separator + 1
    );

  if (
    !method ||
    !password
  ) {
    throw new Error(
      "Shadowsocks method/password missing"
    );
  }

  return {
    tag,

    protocol:
      "shadowsocks",

    settings: {
      address:
        host,

      port,

      method,

      password,

      uot: true
    }
  };
}
