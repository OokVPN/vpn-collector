import fs from 'node:fs';
import path from 'node:path';
import { parseUri, getRemark } from './parser.js';
import { geoipLookup } from './geoip.js';

const CHECKED_PATH = path.resolve('data/checked.json');
const NODES_PATH = path.resolve('data/nodes.json');
const SUBSCRIPTION_PATH = path.resolve('data/subscription.json');
const PUBLIC_PATH = path.resolve('public/subscription.json');

const REQUESTED_MAX_LATENCY = parseInt(
  process.env.MAX_LATENCY || '1000',
  10
);

// Жёсткий предел: >1000 ms никогда не попадает в подписку.
const MAX_LATENCY = Math.min(
  Number.isFinite(REQUESTED_MAX_LATENCY)
    ? REQUESTED_MAX_LATENCY
    : 1000,
  1000
);

const COUNTRY_NAMES = {
  AF: 'Афганистан',
  AL: 'Албания',
  DZ: 'Алжир',
  AD: 'Андорра',
  AO: 'Ангола',
  AG: 'Антигуа и Барбуда',
  AR: 'Аргентина',
  AM: 'Армения',
  AU: 'Австралия',
  AT: 'Австрия',
  AZ: 'Азербайджан',
  BS: 'Багамы',
  BH: 'Бахрейн',
  BD: 'Бангладеш',
  BB: 'Барбадос',
  BY: 'Беларусь',
  BE: 'Бельгия',
  BZ: 'Белиз',
  BJ: 'Бенин',
  BT: 'Бутан',
  BO: 'Боливия',
  BA: 'Босния и Герцеговина',
  BW: 'Ботсвана',
  BR: 'Бразилия',
  BN: 'Бруней',
  BG: 'Болгария',
  BF: 'Буркина-Фасо',
  BI: 'Бурунди',
  CV: 'Кабо-Верде',
  KH: 'Камбоджа',
  CM: 'Камерун',
  CA: 'Канада',
  CF: 'ЦАР',
  TD: 'Чад',
  CL: 'Чили',
  CN: 'Китай',
  CO: 'Колумбия',
  KM: 'Коморы',
  CG: 'Республика Конго',
  CD: 'ДР Конго',
  CR: 'Коста-Рика',
  CI: 'Кот-д’Ивуар',
  HR: 'Хорватия',
  CU: 'Куба',
  CY: 'Кипр',
  CZ: 'Чехия',
  DK: 'Дания',
  DJ: 'Джибути',
  DM: 'Доминика',
  DO: 'Доминиканская Республика',
  EC: 'Эквадор',
  EG: 'Египет',
  SV: 'Сальвадор',
  GQ: 'Экваториальная Гвинея',
  ER: 'Эритрея',
  EE: 'Эстония',
  SZ: 'Эсватини',
  ET: 'Эфиопия',
  FJ: 'Фиджи',
  FI: 'Финляндия',
  FR: 'Франция',
  GA: 'Габон',
  GM: 'Гамбия',
  GE: 'Грузия',
  DE: 'Германия',
  GH: 'Гана',
  GR: 'Греция',
  GD: 'Гренада',
  GT: 'Гватемала',
  GN: 'Гвинея',
  GW: 'Гвинея-Бисау',
  GY: 'Гайана',
  HT: 'Гаити',
  HN: 'Гондурас',
  HU: 'Венгрия',
  IS: 'Исландия',
  IN: 'Индия',
  ID: 'Индонезия',
  IR: 'Иран',
  IQ: 'Ирак',
  IE: 'Ирландия',
  IL: 'Израиль',
  IT: 'Италия',
  JM: 'Ямайка',
  JP: 'Япония',
  JO: 'Иордания',
  KZ: 'Казахстан',
  KE: 'Кения',
  KI: 'Кирибати',
  KP: 'Северная Корея',
  KR: 'Южная Корея',
  KW: 'Кувейт',
  KG: 'Кыргызстан',
  LA: 'Лаос',
  LV: 'Латвия',
  LB: 'Ливан',
  LS: 'Лесото',
  LR: 'Либерия',
  LY: 'Ливия',
  LI: 'Лихтенштейн',
  LT: 'Литва',
  LU: 'Люксембург',
  MG: 'Мадагаскар',
  MW: 'Малави',
  MY: 'Малайзия',
  MV: 'Мальдивы',
  ML: 'Мали',
  MT: 'Мальта',
  MH: 'Маршалловы Острова',
  MR: 'Мавритания',
  MU: 'Маврикий',
  MX: 'Мексика',
  FM: 'Микронезия',
  MD: 'Молдова',
  MC: 'Монако',
  MN: 'Монголия',
  ME: 'Черногория',
  MA: 'Марокко',
  MZ: 'Мозамбик',
  MM: 'Мьянма',
  NA: 'Намибия',
  NR: 'Науру',
  NP: 'Непал',
  NL: 'Нидерланды',
  NZ: 'Новая Зеландия',
  NI: 'Никарагуа',
  NE: 'Нигер',
  NG: 'Нигерия',
  MK: 'Северная Македония',
  NO: 'Норвегия',
  OM: 'Оман',
  PK: 'Пакистан',
  PW: 'Палау',
  PA: 'Панама',
  PG: 'Папуа — Новая Гвинея',
  PY: 'Парагвай',
  PE: 'Перу',
  PH: 'Филиппины',
  PL: 'Польша',
  PT: 'Португалия',
  QA: 'Катар',
  RO: 'Румыния',
  RU: 'Россия',
  RW: 'Руанда',
  KN: 'Сент-Китс и Невис',
  LC: 'Сент-Люсия',
  VC: 'Сент-Винсент и Гренадины',
  WS: 'Самоа',
  SM: 'Сан-Марино',
  ST: 'Сан-Томе и Принсипи',
  SA: 'Саудовская Аравия',
  SN: 'Сенегал',
  RS: 'Сербия',
  SC: 'Сейшелы',
  SL: 'Сьерра-Леоне',
  SG: 'Сингапур',
  SK: 'Словакия',
  SI: 'Словения',
  SB: 'Соломоновы Острова',
  SO: 'Сомали',
  ZA: 'ЮАР',
  SS: 'Южный Судан',
  ES: 'Испания',
  LK: 'Шри-Ланка',
  SD: 'Судан',
  SR: 'Суринам',
  SE: 'Швеция',
  CH: 'Швейцария',
  SY: 'Сирия',
  TJ: 'Таджикистан',
  TZ: 'Танзания',
  TH: 'Таиланд',
  TL: 'Тимор-Лешти',
  TG: 'Того',
  TO: 'Тонга',
  TT: 'Тринидад и Тобаго',
  TN: 'Тунис',
  TR: 'Турция',
  TM: 'Туркменистан',
  TV: 'Тувалу',
  UG: 'Уганда',
  UA: 'Украина',
  AE: 'ОАЭ',
  GB: 'Великобритания',
  US: 'США',
  UY: 'Уругвай',
  UZ: 'Узбекистан',
  VU: 'Вануату',
  VA: 'Ватикан',
  VE: 'Венесуэла',
  VN: 'Вьетнам',
  YE: 'Йемен',
  ZM: 'Замбия',
  ZW: 'Зимбабве',

  AX: 'Аландские острова',
  AS: 'Американское Самоа',
  AW: 'Аруба',
  BM: 'Бермуды',
  BQ: 'Карибские Нидерланды',
  BV: 'Остров Буве',
  IO: 'Британская территория в Индийском океане',
  KY: 'Каймановы острова',
  CX: 'Остров Рождества',
  CC: 'Кокосовые острова',
  CK: 'Острова Кука',
  CW: 'Кюрасао',
  FK: 'Фолклендские острова',
  FO: 'Фарерские острова',
  GF: 'Французская Гвиана',
  PF: 'Французская Полинезия',
  TF: 'Французские Южные территории',
  GI: 'Гибралтар',
  GL: 'Гренландия',
  GP: 'Гваделупа',
  GU: 'Гуам',
  GG: 'Гернси',
  HK: 'Гонконг',
  IM: 'Остров Мэн',
  JE: 'Джерси',
  MO: 'Макао',
  MQ: 'Мартиника',
  MS: 'Монтсеррат',
  NC: 'Новая Каледония',
  NU: 'Ниуэ',
  NF: 'Остров Норфолк',
  MP: 'Северные Марианские Острова',
  PS: 'Палестина',
  PN: 'Питкэрн',
  PR: 'Пуэрто-Рико',
  RE: 'Реюньон',
  BL: 'Сен-Бартелеми',
  SH: 'Остров Святой Елены',
  MF: 'Сен-Мартен',
  PM: 'Сен-Пьер и Микелон',
  SX: 'Синт-Мартен',
  SJ: 'Шпицберген и Ян-Майен',
  TW: 'Тайвань',
  TK: 'Токелау',
  TC: 'Теркс и Кайкос',
  UM: 'Внешние малые острова США',
  VG: 'Британские Виргинские острова',
  VI: 'Виргинские острова США',
  WF: 'Уоллис и Футуна',
  EH: 'Западная Сахара'
};

function flagFromCode(code) {
  if (!code || code === 'UN' || code === 'UNKNOWN') {
    return '';
  }

  const normalized = String(code).toUpperCase();

  if (!/^[A-Z]{2}$/.test(normalized)) {
    return '';
  }

  const base = 0x1f1e6;

  return normalized
    .split('')
    .map((c) =>
      String.fromCodePoint(base + c.charCodeAt(0) - 65)
    )
    .join('');
}


// Триггеры белого флага.
// Проверяются по первоначальному имени сервера.
const WHITE_TRIGGERS = [
  'обход глушилок',
  'белые списки',
  'обход белых списков',
  'lte',
  '5g',
  '⚪',
  'бс',
  'бс',
  'обход',
  '🏳'
];

function normalizeRemark(remark) {
  return String(remark || '')
    .toLowerCase()
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isWhiteFlag(remark) {
  const norm = normalizeRemark(remark);

  if (!norm) {
    return false;
  }

  return WHITE_TRIGGERS.some((trigger) => {
    const t = normalizeRemark(trigger);

    if (!t) {
      return false;
    }

    // Для коротких триггеров не допускаем совпадение
    // внутри другого слова.
    if (t.length <= 3) {
      const regex = new RegExp(
        `(^|\\s)${escapeRegExp(t)}(?=\\s|$)`,
        'i'
      );

      return regex.test(norm);
    }

    return (
      norm === t ||
      norm.startsWith(`${t} `) ||
      norm.endsWith(` ${t}`) ||
      norm.includes(` ${t} `)
    );
  });
}


function buildAutoConfig(nodeTags) {
  return {
    dns: {
      servers: ['1.1.1.1', '1.0.0.1'],
      queryStrategy: 'UseIP'
    },

    routing: {
      rules: [
        {
          type: 'field',
          protocol: ['bittorrent'],
          outboundTag: 'direct'
        },
        {
          type: 'field',
          network: 'tcp,udp',
          balancerTag: 'Super_Balancer'
        }
      ],

      balancers: [
        {
          tag: 'Super_Balancer',
          selector: nodeTags,

          strategy: {
            type: 'leastLoad',
            settings: {
              maxRTT: '1s',
              expected: 2,
              baselines: ['1s'],
              tolerance: 0.01
            }
          },

          fallbackTag: 'direct'
        }
      ],

      domainMatcher: 'hybrid',
      domainStrategy: 'IPIfNonMatch'
    },

    inbounds: [
      {
        tag: 'socks',
        port: 10808,
        listen: '127.0.0.1',
        protocol: 'socks',

        settings: {
          udp: true,
          auth: 'noauth'
        },

        sniffing: {
          enabled: true,
          routeOnly: false,
          destOverride: ['http', 'tls', 'quic']
        }
      },

      {
        tag: 'http',
        port: 10809,
        listen: '127.0.0.1',
        protocol: 'http',

        settings: {
          allowTransparent: false
        },

        sniffing: {
          enabled: true,
          routeOnly: false,
          destOverride: ['http', 'tls', 'quic']
        }
      }
    ],

    outbounds: [],

    burstObservatory: {
      pingConfig: {
        timeout: '3s',
        interval: '1m',
        sampling: 1,
        destination: 'https://www.gstatic.com/generate_204',
        connectivity: ''
      },

      subjectSelector: nodeTags
    },

    remarks: '🇪🇺 АВТО ⚡'
  };
}


function buildIndividualConfig(outbound, remarks) {
  return {
    dns: {
      servers: ['1.1.1.1', '1.0.0.1'],
      queryStrategy: 'UseIP'
    },

    inbounds: [
      {
        tag: 'socks',
        port: 10808,
        listen: '127.0.0.1',
        protocol: 'socks',

        settings: {
          udp: true,
          auth: 'noauth'
        },

        sniffing: {
          enabled: true,
          routeOnly: false,
          destOverride: ['http', 'tls', 'quic']
        }
      },

      {
        tag: 'http',
        port: 10809,
        listen: '127.0.0.1',
        protocol: 'http',

        settings: {
          allowTransparent: false
        },

        sniffing: {
          enabled: true,
          routeOnly: false,
          destOverride: ['http', 'tls', 'quic']
        }
      }
    ],

    outbounds: [
      {
        ...outbound,
        tag: 'proxy'
      },
      {
        protocol: 'freedom',
        tag: 'direct'
      },
      {
        protocol: 'blackhole',
        tag: 'block'
      }
    ],

    routing: {
      domainStrategy: 'IPIfNonMatch',

      rules: [
        {
          type: 'field',
          network: 'tcp,udp',
          outboundTag: 'proxy'
        }
      ]
    },

    remarks
  };
}


async function main() {
  if (!fs.existsSync(CHECKED_PATH)) {
    console.error(
      'data/checked.json not found, run "npm run check" first'
    );

    process.exit(1);
  }

  const checked = JSON.parse(
    fs.readFileSync(CHECKED_PATH, 'utf8')
  );

  const eligible = checked.filter(
    (c) =>
      typeof c.latency === 'number' &&
      c.latency <= MAX_LATENCY
  );

  console.log(
    `Eligible (latency <= ${MAX_LATENCY}): ${eligible.length}`
  );

  const candidates = [];

  for (const item of eligible) {
    const parsed = parseUri(item.uri);

    if (
      !parsed ||
      !parsed.outbound ||
      !parsed.host
    ) {
      continue;
    }

    candidates.push({
      ...parsed,
      uri: item.uri,
      latency: item.latency,

      // ВАЖНО:
      // берём первоначальный remark именно из URI,
      // чтобы white-trigger не зависел от GeoIP.
      remark: getRemark(item.uri)
    });
  }

  let ruFiltered = 0;
  const withGeo = [];

  for (const c of candidates) {
    const geo = await geoipLookup(c.host);

    if (geo.countryCode === 'RU') {
      ruFiltered++;
      continue;
    }

    withGeo.push({
      ...c,
      ...geo
    });
  }

  console.log(`RU FILTERED: ${ruFiltered}`);

  if (withGeo.length === 0) {
    console.error('AUTO has no working nodes');
    process.exit(1);
  }

  // White flag определяется ТОЛЬКО
  // по первоначальному имени сервера.
  for (const item of withGeo) {
    item.whiteFlag = isWhiteFlag(item.remark);
  }

  withGeo.sort((a, b) => {
    const nameA =
      COUNTRY_NAMES[a.countryCode] ||
      a.countryName ||
      'Неизвестно';

    const nameB =
      COUNTRY_NAMES[b.countryCode] ||
      b.countryName ||
      'Неизвестно';

    if (nameA !== nameB) {
      return nameA.localeCompare(nameB, 'ru');
    }

    return a.latency - b.latency;
  });

  const countryCounts = {};

  const nodes = withGeo.map((item, i) => {
    const isUnknown =
      !item.countryCode ||
      item.countryCode === 'UN' ||
      item.countryCode === 'UNKNOWN';

    const countryName = isUnknown
      ? 'Неизвестно'
      : (
          COUNTRY_NAMES[item.countryCode] ||
          item.countryName ||
          item.countryCode
        );

    const countKey = item.countryCode || 'UN';

    countryCounts[countKey] =
      (countryCounts[countKey] || 0) + 1;

    const n = countryCounts[countKey];

    // У UN нет обычного флага страны.
    const flag = isUnknown
      ? ''
      : flagFromCode(item.countryCode);

    // 🏳️ появляется ТОЛЬКО если
    // первоначальное имя сервера содержит trigger.
    const flagMark = item.whiteFlag
      ? '🏳️'
      : '';

    const suffix = n > 1
      ? ` #${n}`
      : '';

    const prefix = [
      flag,
      flagMark
    ]
      .filter(Boolean)
      .join(' ');

    // Без ping и названия протокола.
    const remarks =
      `${prefix ? `${prefix} ` : ''}` +
      `${countryName}${suffix}`;

    const tag = `node-${i + 1}`;

    return {
      tag,
      remarks,
      outbound: item.outbound,
      countryCode: item.countryCode,
      latency: item.latency,
      type: item.type
    };
  });

  console.log(`PROFILES: ${nodes.length}`);

  const nodeTags = nodes.map(
    (n) => n.tag
  );

  const autoConfig =
    buildAutoConfig(nodeTags);

  autoConfig.outbounds = [
    ...nodes.map((n) => ({
      ...n.outbound,
      tag: n.tag
    })),

    {
      protocol: 'freedom',
      tag: 'direct'
    },

    {
      protocol: 'blackhole',
      tag: 'block'
    }
  ];

  console.log(
    `AUTO NODES: ${nodeTags.length}`
  );

  const profiles = nodes.map((n) =>
    buildIndividualConfig(
      n.outbound,
      n.remarks
    )
  );

  const subscription = [
    autoConfig,
    ...profiles
  ];

  // Финальная проверка AUTO.
  if (
    subscription[0].remarks !==
    '🇪🇺 АВТО ⚡'
  ) {
    console.error(
      'VALIDATION FAILED: AUTO remarks mismatch'
    );

    process.exit(1);
  }

  const hasNodeOutbound =
    subscription[0].outbounds.some(
      (o) =>
        typeof o.tag === 'string' &&
        o.tag.startsWith('node-')
    );

  if (!hasNodeOutbound) {
    console.error(
      'VALIDATION FAILED: AUTO has no node-* outbound'
    );

    process.exit(1);
  }

  fs.mkdirSync(
    path.dirname(NODES_PATH),
    { recursive: true }
  );

  fs.writeFileSync(
    NODES_PATH,
    JSON.stringify(
      nodes.map(
        ({ outbound, ...rest }) => rest
      ),
      null,
      2
    )
  );

  fs.mkdirSync(
    path.dirname(SUBSCRIPTION_PATH),
    { recursive: true }
  );

  fs.writeFileSync(
    SUBSCRIPTION_PATH,
    JSON.stringify(
      subscription,
      null,
      2
    )
  );

  fs.mkdirSync(
    path.dirname(PUBLIC_PATH),
    { recursive: true }
  );

  fs.writeFileSync(
    PUBLIC_PATH,
    JSON.stringify(
      subscription,
      null,
      2
    )
  );

  console.log(
    `Saved subscription with ${subscription.length} entries ` +
    `(1 AUTO + ${profiles.length} profiles)`
  );
}


main().catch((err) => {
  console.error(
    'GENERATOR FATAL:',
    err
  );

  process.exit(1);
});
