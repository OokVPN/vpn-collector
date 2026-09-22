function decode(value) {
  let input =
    decodeURIComponent(value)
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

export function parseShadowsocks(
  uri,
  tag
) {
  const raw =
    uri.slice(
      "ss://".length
    );

  const hash =
    raw.indexOf("#");

  const value =
    hash >= 0
      ? raw.slice(0, hash)
      : raw;

  let credentials;
  let host;
  let port;

  if (value.includes("@")) {
    const index =
      value.lastIndexOf("@");

    credentials =
      decode(
        value.slice(
          0,
          index
        )
      );

    const server =
      value.slice(
        index + 1
      );

    const match =
      server.match(
        /^\[?([^\]]+)\]?:([0-9]+)$/
      );

    if (!match) {
      throw new Error(
        "Invalid SS server"
      );
    }

    host =
      match[1];

    port =
      Number(match[2]);
  } else {
    const decoded =
      decode(value);

    const at =
      decoded.lastIndexOf("@");

    if (at < 1) {
      throw new Error(
        "Invalid SS URI"
      );
    }

    credentials =
      decoded.slice(
        0,
        at
      );

    const server =
      decoded.slice(
        at + 1
      );

    const match =
      server.match(
        /^\[?([^\]]+)\]?:([0-9]+)$/
      );

    if (!match) {
      throw new Error(
        "Invalid SS server"
      );
    }

    host =
      match[1];

    port =
      Number(match[2]);
  }

  const colon =
    credentials.indexOf(":");

  if (colon < 1) {
    throw new Error(
      "Invalid SS credentials"
    );
  }

  const method =
    credentials.slice(
      0,
      colon
    );

  const password =
    credentials.slice(
      colon + 1
    );

  return {
    tag,

    protocol:
      "shadowsocks",

    settings: {
      address:
        host,

      port,

      method,

      password
    }
  };
}
