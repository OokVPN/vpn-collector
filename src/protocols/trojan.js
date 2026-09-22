function number(value, fallback) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

export function parseTrojan(
  uri,
  tag
) {
  const url =
    new URL(uri);

  const q =
    url.searchParams;

  const password =
    decodeURIComponent(
      url.username
    );

  if (!password) {
    throw new Error(
      "Trojan password missing"
    );
  }

  let network =
    q.get("type") ||
    "tcp";

  if (network === "tcp") {
    network = "raw";
  }

  const security =
    q.get("security") ||
    "tls";

  const stream = {
    network,
    security
  };

  if (network === "ws") {
    stream.wsSettings = {
      path:
        q.get("path") || "/",

      headers: {}
    };

    if (q.get("host")) {
      stream.wsSettings.headers.Host =
        q.get("host");
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
      path:
        q.get("path") || "/",

      host:
        q.get("host") || ""
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
  }

  return {
    tag,

    protocol: "trojan",

    settings: {
      address:
        url.hostname,

      port:
        number(
          url.port,
          443
        ),

      password
    },

    streamSettings:
      stream
  };
}
