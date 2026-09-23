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
  AT: ["🇦🇹", "Австрия"],
  BE: ["🇧🇪", "Бельгия"],
  BG: ["🇧🇬", "Болгария"],
  CA: ["🇨🇦", "Канада"],
  CH: ["🇨🇭", "Швейцария"],
  CZ: ["🇨🇿", "Чехия"],
  DE: ["🇩🇪", "Германия"],
  DK: ["🇩🇰", "Дания"],
  EE: ["🇪🇪", "Эстония"],
  ES: ["🇪🇸", "Испания"],
  FI: ["🇫🇮", "Финляндия"],
  FR: ["🇫🇷", "Франция"],
  GB: ["🇬🇧", "Великобритания"],
  GR: ["🇬🇷", "Греция"],
  HK: ["🇭🇰", "Гонконг"],
  HU: ["🇭🇺", "Венгрия"],
  IE: ["🇮🇪", "Ирландия"],
  IT: ["🇮🇹", "Италия"],
  JP: ["🇯🇵", "Япония"],
  KR: ["🇰🇷", "Южная Корея"],
  LT: ["🇱🇹", "Литва"],
  LU: ["🇱🇺", "Люксембург"],
  LV: ["🇱🇻", "Латвия"],
  NL: ["🇳🇱", "Нидерланды"],
  NO: ["🇳🇴", "Норвегия"],
  PL: ["🇵🇱", "Польша"],
  PT: ["🇵🇹", "Португалия"],
  RO: ["🇷🇴", "Румыния"],
  RU: ["🇷🇺", "Россия"],
  SE: ["🇸🇪", "Швеция"],
  SG: ["🇸🇬", "Сингапур"],
  SK: ["🇸🇰", "Словакия"],
  TR: ["🇹🇷", "Турция"],
  UA: ["🇺🇦", "Украина"],
  US: ["🇺🇸", "США"],
  VN: ["🇻🇳", "Вьетнам"],
  KZ: ["🇰🇿", "Казахстан"]
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

function countryLabel(code) {
  const item =
    countries[
      String(code || "")
        .toUpperCase()
    ];

  return item
    ? item[1]
    : String(code || "UNKNOWN");
}

function vmessHost(uri) {
  try {
    let value =
      uri
        .slice("vmess://".length)
        .replace(/-/g, "+")
        .replace(/_/g, "/");

    value += "=".repeat(
      (4 - value.length % 4) % 4
    );

    const data =
      JSON.parse(
        Buffer
          .from(
            value,
            "base64"
          )
          .toString("utf8")
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
    return new URL(uri).hostname;
  } catch {
    return null;
  }
}

async function main() {
  const alive =
    checked.filter(
      item =>
        typeof item?.uri ===
          "string" &&

        Number.isFinite(
          Number(item.latency)
        ) &&

        Number(item.latency) <=
          150
    );

  console.log(
    `CHECKED: ${checked.length}`
  );

  console.log(
    `ALIVE: ${alive.length}`
  );

  const nodes = [];

  for (
    const item of alive
  ) {
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
        await resolveGeo(host);

      const code =
        String(
          geo?.countryCode ||
          "UN"
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
          Number(
            item.latency
          ),

        protocol
      });
    } catch (error) {
      console.log(
        `GENERATOR ERROR: ${error.message}`
      );
    }
  }

  /*
   * Сначала сортируем по стране,
   * затем внутри страны по ping.
   */

  nodes.sort(
    (a, b) => {
      const countryA =
        countryLabel(
          a.countryCode
        );

      const countryB =
        countryLabel(
          b.countryCode
        );

      const countryCompare =
        countryA.localeCompare(
          countryB,
          "ru"
        );

      if (
        countryCompare !== 0
      ) {
        return countryCompare;
      }

      return (
        a.latency -
        b.latency
      );
    }
  );

  /*
   * После сортировки перенумеровываем
   * node-теги, чтобы порядок был
   * последовательным.
   */

  nodes.forEach(
    (node, index) => {
      node.tag =
        `node-${index + 1}`;

      node.outbound.tag =
        node.tag;
    }
  );

  const countryIndexes = {};

  const profiles =
    nodes.map(
      node => {
        const code =
          node.countryCode;

        countryIndexes[code] =
          (
            countryIndexes[code] ||
            0
          ) + 1;

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
      }
    );

  const tags =
    nodes.map(
      node =>
        node.tag
    );

  /*
   * AUTO создаётся отдельно
   * и ставится самым первым.
   */

  const auto = {
    remarks:
      "🇪🇺 АВТО ⚡",

    inbounds: [
      {
        tag:
          "auto-socks",

        listen:
          "127.0.0.1",

        port:
          10808,

        protocol:
          "socks",

        settings: {
          auth:
            "noauth",

          udp:
            true
        }
      }
    ],

    outbounds:
      nodes.map(
        node =>
          node.outbound
      ),

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
          tag:
            "AUTO",

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
          type:
            "field",

          inboundTag: [
            "auto-socks"
          ],

          balancerTag:
            "AUTO"
        }
      ]
    }
  };

  /*
   * ВАЖНО:
   * AUTO всегда первый.
   */

  const result = [
    auto,
    ...profiles
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
      recursive:
        true
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

  console.log(
    "ORDER: AUTO -> COUNTRY -> PING"
  );
}

main().catch(
  error => {
    console.error(
      error
    );

    process.exit(1);
  }
);
