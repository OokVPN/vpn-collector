function number(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function alpn(value) {
  if (!value) return undefined;

  return value
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);
}

export function parseVless(uri, tag) {
  const url = new URL(uri);
  const q = url.searchParams;

  const id = decodeURIComponent(url.username);

  if (!id) {
    throw new Error("VLESS UUID missing");
  }

  let network =
    q.get("type") ||
    q.get("network") ||
    "tcp";

  if (network === "tcp") {
    network = "raw";
  }

  const security =
    q.get("security") ||
    "none";

  const stream = {
    network,
    security
  };

  if (network === "ws") {
    stream.wsSettings = {
      path: q.get("path") || "/",
      headers: {}
    };

    const host = q.get("host");

    if (host) {
      stream.wsSettings.headers.Host = host;
    }
  }

  if (network === "grpc") {
    stream.grpcSettings = {
      serviceName:
        q.get("serviceName") ||
        q.get("service") ||
        ""
    };
  }

  if (network === "xhttp") {
    stream.xhttpSettings = {
      path: q.get("path") || "/",
      host: q.get("host") || ""
    };
  }

  if (network === "httpupgrade") {
    stream.httpupgradeSettings = {
      path: q.get("path") || "/",
      host: q.get("host") || ""
    };
  }

  if (security === "tls") {
    stream.tlsSettings = {
      serverName:
        q.get("sni") ||
        url.hostname,

      fingerprint:
        q.get("fp") ||
        "chrome"
    };

    const protocols =
      alpn(q.get("alpn"));

    if (protocols?.length) {
      stream.tlsSettings.alpn =
        protocols;
    }

    const pinned =
      q.get("pinSHA256") ||
      q.get("pinnedPeerCertSha256");

    if (pinned) {
      stream.tlsSettings.pinnedPeerCertSha256 =
        pinned;
    }

    const verifyName =
      q.get("verifyPeerCertByName") ||
      q.get("vcn");

    if (verifyName) {
      stream.tlsSettings.verifyPeerCertByName =
        verifyName;
    }
  }

  if (security === "reality") {
    stream.realitySettings = {
      serverName:
        q.get("sni") ||
        url.hostname,

      fingerprint:
        q.get("fp") ||
        "chrome",

      publicKey:
        q.get("pbk") ||
        "",

      shortId:
        q.get("sid") ||
        "",

      spiderX:
        q.get("spx") ||
        "/"
    };
  }

  return {
    tag,

    protocol: "vless",

    settings: {
      vnext: [
        {
          address:
            url.hostname,

          port:
            number(
              url.port,
              443
            ),

          users: [
            {
              id,

              encryption:
                q.get("encryption") ||
                "none",

              flow:
                q.get("flow") ||
                ""
            }
          ]
        }
      ]
    },

    streamSettings:
      stream
  };
}
