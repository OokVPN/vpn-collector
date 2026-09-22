function decode(value) {
  let input =
    value
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

export function parseVmess(
  uri,
  tag
) {
  const encoded =
    uri.slice(
      "vmess://".length
    );

  const data =
    JSON.parse(
      decode(encoded)
    );

  if (
    !data.add ||
    !data.id
  ) {
    throw new Error(
      "Invalid VMess"
    );
  }

  let network =
    String(
      data.net || "tcp"
    ).toLowerCase();

  if (network === "tcp") {
    network = "raw";
  }

  if (network === "kcp") {
    network = "mkcp";
  }

  const stream = {
    network,

    security:
      data.tls === "tls"
        ? "tls"
        : "none"
  };

  if (network === "ws") {
    stream.wsSettings = {
      path:
        data.path || "/",

      headers:
        data.host
          ? {
              Host: data.host
            }
          : {}
    };
  }

  if (network === "grpc") {
    stream.grpcSettings = {
      serviceName:
        data.path ||
        data.serviceName ||
        ""
    };
  }

  if (network === "xhttp") {
    stream.xhttpSettings = {
      path:
        data.path || "/",

      host:
        data.host || ""
    };
  }

  if (network === "httpupgrade") {
    stream.httpupgradeSettings = {
      path:
        data.path || "/",

      host:
        data.host || ""
    };
  }

  if (network === "mkcp") {
    stream.kcpSettings = {
      mtu:
        number(data.mtu, 1350),

      tti:
        number(data.tti, 50),

      uplinkCapacity:
        number(data.up, 5),

      downlinkCapacity:
        number(data.down, 20),

      congestion:
        Boolean(data.congestion),

      header: {
        type:
          data.type || "none"
      }
    };
  }

  if (
    stream.security === "tls"
  ) {
    stream.tlsSettings = {
      serverName:
        data.sni ||
        data.host ||
        data.add,

      fingerprint:
        data.fp ||
        "chrome"
    };
  }

  return {
    tag,

    protocol: "vmess",

    settings: {
      vnext: [
        {
          address:
            data.add,

          port:
            number(
              data.port,
              443
            ),

          users: [
            {
              id:
                data.id,

              alterId:
                number(
                  data.aid,
                  0
                ),

              security:
                data.scy ||
                "auto"
            }
          ]
        }
      ]
    },

    streamSettings:
      stream
  };
}
