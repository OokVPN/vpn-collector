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
  AD: ["🇦🇩", "Андорра"],
  AE: ["🇦🇪", "ОАЭ"],
  AF: ["🇦🇫", "Афганистан"],
  AL: ["🇦🇱", "Албания"],
  AM: ["🇦🇲", "Армения"],
  AR: ["🇦🇷", "Аргентина"],
  AT: ["🇦🇹", "Австрия"],
  AU: ["🇦🇺", "Австралия"],
  AZ: ["🇦🇿", "Азербайджан"],

  BA: ["🇧🇦", "Босния и Герцеговина"],
  BD: ["🇧🇩", "Бангладеш"],
  BE: ["🇧🇪", "Бельгия"],
  BG: ["🇧🇬", "Болгария"],
  BH: ["🇧🇭", "Бахрейн"],
  BN: ["🇧🇳", "Бруней"],
  BO: ["🇧🇴", "Боливия"],
  BR: ["🇧🇷", "Бразилия"],
  BY: ["🇧🇾", "Беларусь"],

  CA: ["🇨🇦", "Канада"],
  CH: ["🇨🇭", "Швейцария"],
  CL: ["🇨🇱", "Чили"],
  CN: ["🇨🇳", "Китай"],
  CO: ["🇨🇴", "Колумбия"],
  CR: ["🇨🇷", "Коста-Рика"],
  CY: ["🇨🇾", "Кипр"],
  CZ: ["🇨🇿", "Чехия"],

  DE: ["🇩🇪", "Германия"],
  DK: ["🇩🇰", "Дания"],
  DO: ["🇩🇴", "Доминиканская Республика"],
  DZ: ["🇩🇿", "Алжир"],

  EC: ["🇪🇨", "Эквадор"],
  EE: ["🇪🇪", "Эстония"],
  EG: ["🇪🇬", "Египет"],
  ES: ["🇪🇸", "Испания"],

  FI: ["🇫🇮", "Финляндия"],
  FJ: ["🇫🇯", "Фиджи"],
  FR: ["🇫🇷", "Франция"],

  GB: ["🇬🇧", "Великобритания"],
  GE: ["🇬🇪", "Грузия"],
  GR: ["🇬🇷", "Греция"],
  GT: ["🇬🇹", "Гватемала"],

  HK: ["🇭🇰", "Гонконг"],
  HR: ["🇭🇷", "Хорватия"],
  HU: ["🇭🇺", "Венгрия"],

  ID: ["🇮🇩", "Индонезия"],
  IE: ["🇮🇪", "Ирландия"],
  IL: ["🇮🇱", "Израиль"],
  IN: ["🇮🇳", "Индия"],
  IQ: ["🇮🇶", "Ирак"],
  IS: ["🇮🇸", "Исландия"],
  IT: ["🇮🇹", "Италия"],

  JP: ["🇯🇵", "Япония"],
  JO: ["🇯🇴", "Иордания"],

  KE: ["🇰🇪", "Кения"],
  KG: ["🇰🇬", "Кыргызстан"],
  KH: ["🇰🇭", "Камбоджа"],
  KR: ["🇰🇷", "Южная Корея"],
  KW: ["🇰🇼", "Кувейт"],
  KZ: ["🇰🇿", "Казахстан"],

  LA: ["🇱🇦", "Лаос"],
  LB: ["🇱🇧", "Ливан"],
  LI: ["🇱🇮", "Лихтенштейн"],
  LK: ["🇱🇰", "Шри-Ланка"],
  LT: ["🇱🇹", "Литва"],
  LU: ["🇱🇺", "Люксембург"],
  LV: ["🇱🇻", "Латвия"],

  MA: ["🇲🇦", "Марокко"],
  MC: ["🇲🇨", "Монако"],
  MD: ["🇲🇩", "Молдова"],
  ME: ["🇲🇪", "Черногория"],
  MK: ["🇲🇰", "Северная Македония"],
  MN: ["🇲🇳", "Монголия"],
  MO: ["🇲🇴", "Макао"],
  MT: ["🇲🇹", "Мальта"],
  MX: ["🇲🇽", "Мексика"],
  MY: ["🇲🇾", "Малайзия"],

  NG: ["🇳🇬", "Нигерия"],
  NI: ["🇳🇮", "Никарагуа"],
  NL: ["🇳🇱", "Нидерланды"],
  NO: ["🇳🇴", "Норвегия"],
  NP: ["🇳🇵", "Непал"],
  NZ: ["🇳🇿", "Новая Зеландия"],

  PA: ["🇵🇦", "Панама"],
  PE: ["🇵🇪", "Перу"],
  PH: ["🇵🇭", "Филиппины"],
  PK: ["🇵🇰", "Пакистан"],
  PL: ["🇵🇱", "Польша"],
  PR: ["🇵🇷", "Пуэрто-Рико"],
  PT: ["🇵🇹", "Португалия"],
  PY: ["🇵🇾", "Парагвай"],

  QA: ["🇶🇦", "Катар"],

  RO: ["🇷🇴", "Румыния"],
  RS: ["🇷🇸", "Сербия"],
  RU: ["🇷🇺", "Россия"],

  SA: ["🇸🇦", "Саудовская Аравия"],
  SE: ["🇸🇪", "Швеция"],
  SG: ["🇸🇬", "Сингапур"],
  SI: ["🇸🇮", "Словения"],
  SK: ["🇸🇰", "Словакия"],
  SM: ["🇸🇲", "Сан-Марино"],
  SN: ["🇸🇳", "Сенегал"],
  SV: ["🇸🇻", "Сальвадор"],

  TH: ["🇹🇭", "Таиланд"],
  TJ: ["🇹🇯", "Таджикистан"],
  TM: ["🇹🇲", "Туркменистан"],
  TN: ["🇹🇳", "Тунис"],
  TR: ["🇹🇷", "Турция"],
  TW: ["🇹🇼", "Тайвань"],

  UA: ["🇺🇦", "Украина"],
  US: ["🇺🇸", "США"],
  UZ: ["🇺🇿", "Узбекистан"],

  VA: ["🇻🇦", "Ватикан"],
  VE: ["🇻🇪", "Венесуэла"],
  VN: ["🇻🇳", "Вьетнам"],

  ZA: ["🇿🇦", "ЮАР"],
  ZM: ["🇿🇲", "Замбия"],
  ZW: ["🇿🇼", "Зимбабве"]
};

function countryLabel(code) {
  const item =
    countries[
      String(code || "")
        .toUpperCase()
    ];

  return item
    ? item[1]
    : String(
        code ||
        "UNKNOWN"
      );
}

function vmessHost(uri) {
  try {
    let value =
      uri
        .slice(
          "vmess://".length
        )
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
    return new URL(
      uri
    ).hostname;
  } catch {
    return null;
  }
}

function sourceRemark(uri) {
  try {
    const index =
      uri.indexOf("#");

    if (index === -1) {
      return "";
    }

    return decodeURIComponent(
      uri.slice(index + 1)
    );
  } catch {
    return "";
  }
}

function normalizeRemark(
  value
) {
  return String(
    value || ""
  )
    .toLowerCase()
    .replace(
      /[-_/]+/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}

function hasWhiteFlag(uri) {
  const remark =
    normalizeRemark(
      sourceRemark(uri)
    );

  const triggers = [
    "обход глушилок",
    "белые списки",
    "обход белых списков",
    "lte",
    "5g",
    "⚪",
    "обход",
    "белые",
    "бс"
  ];

  return triggers.some(
    trigger =>
      remark.includes(
        trigger
      )
  );
}

function createAuto(nodes) {
  const tags =
    nodes.map(
      node =>
        node.tag
    );

  return {
    dns: {
      servers: [
        "1.1.1.1",
        "1.0.0.1"
      ],

      queryStrategy:
        "UseIP"
    },

    routing: {
      rules: [
        {
          type:
            "field",

          protocol: [
            "bittorrent"
          ],

          outboundTag:
            "direct"
        },

        {
          type:
            "field",

          network:
            "tcp,udp",

          balancerTag:
            "Super_Balancer"
        }
      ],

      balancers: [
        {
          tag:
            "Super_Balancer",

          selector:
            tags,

          strategy: {
            type:
              "leastLoad",

            settings: {
              maxRTT:
                "1s",

              expected:
                2,

              baselines: [
                "1s"
              ],

              tolerance:
                0.01
            }
          },

          fallbackTag:
            "direct"
        }
      ],

      domainMatcher:
        "hybrid",

      domainStrategy:
        "IPIfNonMatch"
    },

    inbounds: [
      {
        tag:
          "socks",

        port:
          10808,

        listen:
          "127.0.0.1",

        protocol:
          "socks",

        settings: {
          udp:
            true,

          auth:
            "noauth"
        },

        sniffing: {
          enabled:
            true,

          routeOnly:
            false,

          destOverride: [
            "http",
            "tls",
            "quic"
          ]
        }
      },

      {
        tag:
          "http",

        port:
          10809,

        listen:
          "127.0.0.1",

        protocol:
          "http",

        settings: {
          allowTransparent:
            false
        },

        sniffing: {
          enabled:
            true,

          routeOnly:
            false,

          destOverride: [
            "http",
            "tls",
            "quic"
          ]
        }
      }
    ],

    outbounds: [
      ...nodes.map(
        node =>
          node.outbound
      ),

      {
        tag:
          "direct",

        protocol:
          "freedom"
      },

      {
        tag:
          "block",

        protocol:
          "blackhole"
      }
    ],

    burstObservatory: {
      pingConfig: {
        timeout:
          "3s",

        interval:
          "1m",

        sampling:
          1,

        destination:
          "https://www.gstatic.com/generate_204",

        connectivity:
          ""
      },

      subjectSelector:
        tags
    },

    remarks:
      "🇪🇺 АВТО ⚡"
  };
}

async function main() {
  const nodes = [];

  console.log(
    `CHECKED: ${checked.length}`
  );

  for (
    const item of checked
  ) {
    try {
      const uri =
        item?.uri;

      if (
        typeof uri !==
        "string"
      ) {
        continue;
      }

      const latency =
        Number(
          item.proxyLatency ??
          item.latency
        );

      if (
        !Number.isFinite(
          latency
        )
      ) {
        continue;
      }

      const protocol =
        protocolOf(uri);

      const host =
        hostFromUri(uri);

      if (!host) {
        continue;
      }

      /*
       * Checker уже отфильтровал RU.
       *
       * Для совместимости со старыми
       * checked.json дополнительно
       * проверяем GeoIP здесь.
       */
      let code =
        String(
          item.countryCode ||
          ""
        ).toUpperCase();

      if (!code) {
        const geo =
          await resolveGeo(
            host
          );

        code =
          String(
            geo?.countryCode ||
            "UN"
          ).toUpperCase();
      }

      if (
        code === "RU"
      ) {
        continue;
      }

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

        latency,

        proxyLatency:
          latency,

        tcpLatency:
          Number(
            item.tcpLatency ??
            0
          ),

        proxyPing1:
          item.proxyPing1 ??
          null,

        proxyPing2:
          item.proxyPing2 ??
          null,

        protocol,

        whiteFlag:
          hasWhiteFlag(uri)
      });
    } catch (
      error
    ) {
      console.log(
        `GENERATOR ERROR: ${error.message}`
      );
    }
  }

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

        const flag =
          countries[code]?.[0] ||
          "🌐";

        const name =
          countryLabel(
            code
          );

        const whiteFlag =
          node.whiteFlag
            ? " 🏳️"
            : "";

        return {
          remarks:
            `${flag}${whiteFlag} ${name}${suffix} • ${node.latency} ms • ${node.protocol.toUpperCase()}`,

          inbounds:
            [],

          outbounds: [
            node.outbound
          ]
        };
      }
    );

  const auto =
    createAuto(nodes);

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
    `AUTO NODES: ${nodes.length}`
  );

  console.log(
    "AUTO: custom template + checked non-RU nodes"
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
