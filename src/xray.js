import {
  parseVless
} from "./protocols/vless.js";

import {
  parseVmess
} from "./protocols/vmess.js";

import {
  parseTrojan
} from "./protocols/trojan.js";

import {
  parseShadowsocks
} from "./protocols/shadowsocks.js";

import {
  parseSocks
} from "./protocols/socks.js";

import {
  parseHysteria2
} from "./protocols/hysteria2.js";

export function protocolOf(uri) {
  return uri
    .split("://", 1)[0]
    .toLowerCase();
}

export function uriToOutbound(
  uri,
  tag
) {
  switch (
    protocolOf(uri)
  ) {
    case "vless":
      return parseVless(
        uri,
        tag
      );

    case "vmess":
      return parseVmess(
        uri,
        tag
      );

    case "trojan":
      return parseTrojan(
        uri,
        tag
      );

    case "ss":
      return parseShadowsocks(
        uri,
        tag
      );

    case "socks":
    case "socks5":
      return parseSocks(
        uri,
        tag
      );

    case "hysteria2":
    case "hy2":
      return parseHysteria2(
        uri,
        tag
      );

    default:
      throw new Error(
        "Unsupported protocol"
      );
  }
}

export function buildCheckConfig(
  outbound,
  port
) {
  return {
    log: {
      loglevel: "warning"
    },

    inbounds: [
      {
        tag: "check",

        listen:
          "127.0.0.1",

        port,

        protocol: "socks",

        settings: {
          auth: "noauth",
          udp: true
        }
      }
    ],

    outbounds: [
      outbound,

      {
        tag: "direct",

        protocol: "freedom"
      }
    ],

    routing: {
      rules: [
        {
          type: "field",

          inboundTag: [
            "check"
          ],

          outboundTag:
            outbound.tag
        }
      ]
    }
  };
}
