import fs from "fs";

import {
  resolveGeo
} from "./geoip.js";

import {
  uriToOutbound,
  protocolOf
} from "./xray.js";

const checked =
  JSON.parse(
    fs.readFileSync(
      "./data/checked.json",
      "utf8"
    )
  );

const countries = {
  RU: ["🇷🇺", "Россия"],
  NL: ["🇳🇱", "Нидерланды"],
  DE: ["🇩🇪", "Германия"],
  FI: ["🇫🇮", "Финляндия"],
  US: ["🇺🇸", "США"],
  PL: ["🇵🇱", "Польша"],
  FR: ["🇫🇷", "Франция"],
  GB: ["🇬🇧", "Великобритания"],
  SE: ["🇸🇪", "Швеция"],
  CH: ["🇨🇭", "Швейцария"],
  AT: ["🇦🇹", "Австрия"],
  CA: ["🇨🇦", "Канада"],
  JP: ["🇯🇵", "Япония"],
  SG: ["🇸🇬", "Сингапур"],
  HK: ["🇭🇰", "Гонконг"],
  TR: ["🇹🇷", "Турция"],
  CZ: ["🇨🇿", "Чехия"],
  RO: ["🇷🇴", "Румыния"],
  IT: ["🇮🇹", "Италия"],
  ES: ["🇪🇸", "Испания"],
  NO: ["🇳🇴", "Норвегия"]
};

function countryName(code) {
  const item =
    countries[
      String(code || "")
        .toUpperCase()
    ];

  if (!item) {
    return `🌐 ${code || "UNKNOWN"}`;
  }

  return `${item[0]} ${item[1]}`;
}

function vmessHost(uri) {
  try {
    const encoded =
      uri.slice(
        "vmess://".length
      );

    let value =
      encoded
        .replace(/-/g, "+")
        .replace(/_/g, "/");

    value += "=".repeat(
      (4 - value.length % 4) % 4
    );

    const data =
      JSON.parse(
        Buffer.from(
          value,
          "base64"
        ).toString("utf8")
      );

    return data.add || null;
  } catch {
    return null;
  }
}

function hostFromUri(uri) {
  const protocol =
    protocolOf(uri);

  if (
    protocol === "vmess"
  ) {
    return vmessHost(uri);
  }

  try {
    return new URL(
      uri
    ).hostname;
  } catch {
    return null;
  }
}

async function main() {
  const alive =
    checked.filter(
      item =>
        typeof item?.uri === "string" &&
        Number.isFinite(
          Number(item.latency)
        ) &&
        Number(item.latency) <= 150
    );

  console.log(
    `CHECKED: ${checked.length}`
  );

  console.log(
    `ALIVE: ${alive.length}`
  );

  const nodes = [];

  for (const item of alive) {
    try {
      const uri =
        item.uri;

      const protocol =
        protocolOf(uri);

      const host =
        hostFromUri(uri);

      if (!host) {
        continue;
      }

      const geo =
        await resolveGeo(
          host
        );

      const code =
        String(
          geo?.countryCode || "UN"
        ).toUpperCase();

      const tag =
        `node-${nodes.length + 1}`;

      const outbound =
        uriToOutbound(
          uri,
          tag
        );

      if (
        !outbound ||
        !outbound.tag
      ) {
        continue;
      }

      nodes.push({
        tag,

        outbound,

        countryCode:
          code,

        latency:
          Number(item.latency),

        protocol
      });
    } catch (error) {
      console.log(
        `GENERATOR ERROR: ${error.message}`
      );
    }
  }

  const countryIndexes = {};

  const profiles =
    nodes.map(node => {
      const code =
        node.countryCode;

      countryIndexes[code] =
        (countryIndexes[code] || 0) + 1;

      const number =
        countryIndexes[code];

      const suffix =
        number === 1
          ? ""
          : ` #${number}`;

      return {
        remarks:
          `${countryName(code)}${suffix} • ${node.latency} ms • ${node.protocol.toUpperCase()}`,

        inbounds: [],

        outbounds: [
          node.outbound
        ]
      };
    });

  const tags =
    nodes.map(
      node => node.tag
    );

  const autoOutbounds =
    nodes.map(
      node => node.outbound
    );

  const auto = {
    remarks: "🤖 AUTO",

    inbounds: [
      {
        tag: "auto-socks",

        listen:
          "127.0.0.1",

        port: 10808,

        protocol: "socks",

        settings: {
          auth: "noauth",
          udp: true
        }
      }
    ],

    outbounds:
      autoOutbounds,

    burstObservatory: {
      subjectSelector:
        tags,

      pingConfig: {
        destination:
          "https://www.gstatic.com/generate_204",

        connectivity:
          "https://www.gstatic.com/generate_204"
      }
    },

    routing: {
      balancers: [
        {
          tag: "AUTO",

          selector:
            tags,

          strategy: {
            type:
              "leastPing"
          }
        }
      ],

      rules: [
        {
          type: "field",

          inboundTag: [
            "auto-socks"
          ],

          balancerTag:
            "AUTO"
        }
      ]
    }
  };

  const result = [
    ...profiles,
    auto
  ];

  fs.writeFileSync(
    "./data/nodes.json",
    JSON.stringify(
      nodes,
      null,
      2
    )
  );

  fs.mkdirSync(
    "./public",
    {
      recursive: true
    }
  );

  fs.writeFileSync(
    "./data/subscription.json",
    JSON.stringify(
      result,
      null,
      2
    )
  );

  fs.writeFileSync(
    "./public/subscription.json",
    JSON.stringify(
      result,
      null,
      2
    )
  );

  console.log(
    `LIVE: ${nodes.length}`
  );

  console.log(
    `PROFILES: ${profiles.length}`
  );

  console.log(
    `AUTO NODES: ${tags.length}`
  );
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
