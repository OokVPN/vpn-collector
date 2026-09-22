function parseAuthority(uri) {
  const match =
    uri.match(
      /^(?:hysteria2|hy2):\/\/([^@]+)@(\[[^\]]+\]|[^:/?#]+):(\d+)/i
    );

  if (!match) {
    throw new Error(
      "Invalid Hysteria2 URI"
    );
  }

  return {
    password:
      decodeURIComponent(
        match[1]
      ),

    host:
      match[2].replace(
        /^\[|\]$/g,
        ""
      ),

    port:
      Number(match[3])
  };
}

export function parseHysteria2(
  uri,
  tag
) {
  const authority =
    parseAuthority(uri);

  const question =
    uri.indexOf("?");

  const hash =
    uri.indexOf("#");

  let query = "";

  if (question >= 0) {
    query =
      uri.slice(
        question + 1,
        hash >= 0
          ? hash
          : undefined
      );
  }

  const q =
    new URLSearchParams(
      query
    );

  const sni =
    q.get("sni") ||
    authority.host;

  const tls = {
    serverName: sni
  };

  if (q.get("alpn")) {
    tls.alpn =
      q.get("alpn")
        .split(",")
        .map(x => x.trim())
        .filter(Boolean);
  } else {
    tls.alpn = ["h3"];
  }

  if (
    q.get("insecure") === "1" ||
    q.get("insecure") === "true"
  ) {
    tls.allowInsecure = true;
  }

  const hysteriaSettings = {
    version: 2,

    auth:
      authority.password
  };

  if (q.get("up")) {
    hysteriaSettings.up =
      `${q.get("up")} mbps`;
  }

  if (q.get("down")) {
    hysteriaSettings.down =
      `${q.get("down")} mbps`;
  }

  return {
    tag,

    protocol: "hysteria",

    settings: {
      version: 2,

      address:
        authority.host,

      port:
        authority.port
    },

    streamSettings: {
      network: "hysteria",

      security: "tls",

      tlsSettings: tls,

      hysteriaSettings
    }
  };
}
