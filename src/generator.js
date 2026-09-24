import fs from 'node:fs';
import path from 'node:path';
import { parseUri, getRemark } from './parser.js';
import { geoipLookup } from './geoip.js';

const CHECKED_PATH = path.resolve('data/checked.json');
const NODES_PATH = path.resolve('data/nodes.json');
const SUBSCRIPTION_PATH = path.resolve('data/subscription.json');
const PUBLIC_PATH = path.resolve('public/subscription.json');

const MAX_LATENCY = parseInt(process.env.MAX_LATENCY || '150', 10);

const COUNTRY_NAMES = {
  DE: 'Германия',
  NL: 'Нидерланды',
  US: 'США',
  GB: 'Великобритания',
  FR: 'Франция',
  FI: 'Финляндия',
  SE: 'Швеция',
  PL: 'Польша',
  TR: 'Турция',
  JP: 'Япония',
  SG: 'Сингапур',
  CA: 'Канада',
  CH: 'Швейцария',
  AT: 'Австрия',
  ES: 'Испания',
  IT: 'Италия',
  BE: 'Бельгия',
  NO: 'Норвегия',
  DK: 'Дания',
  IE: 'Ирландия',
  PT: 'Португалия',
  RO: 'Румыния',
  BG: 'Болгария',
  CZ: 'Чехия',
  HU: 'Венгрия',
  GR: 'Греция',
  UA: 'Украина',
  KZ: 'Казахстан',
  AM: 'Армения',
  GE: 'Грузия',
  AZ: 'Азербайджан',
  IN: 'Индия',
  KR: 'Южная Корея',
  HK: 'Гонконг',
  TW: 'Тайвань',
  AU: 'Австралия',
  NZ: 'Новая Зеландия',
  BR: 'Бразилия',
  AR: 'Аргентина',
  MX: 'Мексика',
  AE: 'ОАЭ',
  IL: 'Израиль',
  SA: 'Саудовская Аравия',
  EG: 'Египет',
  ZA: 'ЮАР',
  LT: 'Литва',
  LV: 'Латвия',
  EE: 'Эстония',
  HR: 'Хорватия',
  SI: 'Словения',
  SK: 'Словакия',
  MD: 'Молдова',
  RS: 'Сербия',
  IS: 'Исландия',
  LU: 'Люксембург',
  MT: 'Мальта',
  CY: 'Кипр',
  VN: 'Вьетнам',
  TH: 'Таиланд',
  ID: 'Индонезия',
  MY: 'Малайзия',
  PH: 'Филиппины',
  CN: 'Китай',

  // Дополнительные страны
  AL: 'Албания',
  AD: 'Андорра',
  BA: 'Босния и Герцеговина',
  BY: 'Беларусь',
  MK: 'Северная Македония',
  ME: 'Черногория',
  XK: 'Косово',
  LI: 'Лихтенштейн',
  MC: 'Монако',
  SM: 'Сан-Марино',
  VA: 'Ватикан',

  // Европа
  SE: 'Швеция',
  FO: 'Фарерские острова',
  GG: 'Гернси',
  JE: 'Джерси',
  IM: 'Остров Мэн',
  GI: 'Гибралтар',

  // Азия
  BD: 'Бангладеш',
  BT: 'Бутан',
  KH: 'Камбоджа',
  LA: 'Лаос',
  LK: 'Шри-Ланка',
  MN: 'Монголия',
  NP: 'Непал',
  PK: 'Пакистан',
  BN: 'Бруней',
  MM: 'Мьянма',
  PH: 'Филиппины',
  MO: 'Макао',

  // Ближний Восток
  BH: 'Бахрейн',
  JO: 'Иордания',
  KW: 'Кувейт',
  LB: 'Ливан',
  OM: 'Оман',
  QA: 'Катар',
  IQ: 'Ирак',

  // Африка
  DZ: 'Алжир',
  MA: 'Марокко',
  TN: 'Тунис',
  KE: 'Кения',
  NG: 'Нигерия',
  GH: 'Гана',
  MU: 'Маврикий',
  SC: 'Сейшельские Острова',
  TZ: 'Танзания',
  UG: 'Уганда',
  RW: 'Руанда',
  ET: 'Эфиопия',
  SN: 'Сенегал',
  CI: 'Кот-д’Ивуар',

  // Северная и Центральная Америка
  CR: 'Коста-Рика',
  PA: 'Панама',
  GT: 'Гватемала',
  DO: 'Доминиканская Республика',
  PR: 'Пуэрто-Рико',
  JM: 'Ямайка',
  CU: 'Куба',
  TT: 'Тринидад и Тобаго',

  // Южная Америка
  CL: 'Чили',
  CO: 'Колумбия',
  PE: 'Перу',
  UY: 'Уругвай',
  PY: 'Парагвай',
  BO: 'Боливия',
  EC: 'Эквадор',
  VE: 'Венесуэла',

  // Океания
  FJ: 'Фиджи',
  WS: 'Самоа',
  TO: 'Тонга',
  PG: 'Папуа — Новая Гвинея'
};

function flagFromCode(code) {
  if (!code || code.length !== 2 || code === 'UN') return '🏳️';
  const base = 0x1f1e6;
  const chars = code
    .toUpperCase()
    .split('')
    .map((c) => String.fromCodePoint(base + (c.charCodeAt(0) - 65)));
  return chars.join('');
}

const WHITE_TRIGGERS = ['обход глушилок', 'белые списки', 'обход белых списков', 'lte', '5g', '⚪', 'БС', 'обход', 'белые', 'глушилка'];

function normalizeRemark(remark) {
  return remark
    .toLowerCase()
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isWhiteFlag(remark) {
  const norm = normalizeRemark(remark || '');
  return WHITE_TRIGGERS.some((t) => norm.includes(t));
}

function buildAutoConfig(nodeTags) {
  return {
    dns: { servers: ['1.1.1.1', '1.0.0.1'], queryStrategy: 'UseIP' },
    routing: {
      rules: [
        { type: 'field', protocol: ['bittorrent'], outboundTag: 'direct' },
        { type: 'field', network: 'tcp,udp', balancerTag: 'Super_Balancer' }
      ],
      balancers: [
        {
          tag: 'Super_Balancer',
          selector: nodeTags,
          strategy: {
            type: 'leastLoad',
            settings: { maxRTT: '1s', expected: 2, baselines: ['1s'], tolerance: 0.01 }
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
        settings: { udp: true, auth: 'noauth' },
        sniffing: { enabled: true, routeOnly: false, destOverride: ['http', 'tls', 'quic'] }
      },
      {
        tag: 'http',
        port: 10809,
        listen: '127.0.0.1',
        protocol: 'http',
        settings: { allowTransparent: false },
        sniffing: { enabled: true, routeOnly: false, destOverride: ['http', 'tls', 'quic'] }
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
    dns: { servers: ['1.1.1.1', '1.0.0.1'], queryStrategy: 'UseIP' },
    inbounds: [
      {
        tag: 'socks',
        port: 10808,
        listen: '127.0.0.1',
        protocol: 'socks',
        settings: { udp: true, auth: 'noauth' },
        sniffing: { enabled: true, routeOnly: false, destOverride: ['http', 'tls', 'quic'] }
      },
      {
        tag: 'http',
        port: 10809,
        listen: '127.0.0.1',
        protocol: 'http',
        settings: { allowTransparent: false },
        sniffing: { enabled: true, routeOnly: false, destOverride: ['http', 'tls', 'quic'] }
      }
    ],
    outbounds: [
      { ...outbound, tag: 'proxy' },
      { protocol: 'freedom', tag: 'direct' },
      { protocol: 'blackhole', tag: 'block' }
    ],
    routing: {
      domainStrategy: 'IPIfNonMatch',
      rules: [{ type: 'field', network: 'tcp,udp', outboundTag: 'proxy' }]
    },
    remarks
  };
}

async function main() {
  if (!fs.existsSync(CHECKED_PATH)) {
    console.error('data/checked.json not found, run "npm run check" first');
    process.exit(1);
  }

  const checked = JSON.parse(fs.readFileSync(CHECKED_PATH, 'utf8'));
  const eligible = checked.filter((c) => typeof c.latency === 'number' && c.latency <= MAX_LATENCY);
  console.log(`Eligible (latency <= ${MAX_LATENCY}): ${eligible.length}`);

  const candidates = [];
  for (const item of eligible) {
    const parsed = parseUri(item.uri);
    if (!parsed || !parsed.outbound || !parsed.host) continue;
    candidates.push({ ...parsed, uri: item.uri, latency: item.latency, remark: getRemark(item.uri) });
  }

  let ruFiltered = 0;
  const withGeo = [];
  for (const c of candidates) {
    const geo = await geoipLookup(c.host);
    if (geo.countryCode === 'RU') {
      ruFiltered++;
      continue;
    }
    withGeo.push({ ...c, ...geo });
  }
  console.log(`RU FILTERED: ${ruFiltered}`);

  if (withGeo.length === 0) {
    console.error('AUTO has no working nodes');
    process.exit(1);
  }

  for (const item of withGeo) {
    item.whiteFlag = isWhiteFlag(item.remark);
  }

  withGeo.sort((a, b) => {
    const nameA = COUNTRY_NAMES[a.countryCode] || a.countryCode;
    const nameB = COUNTRY_NAMES[b.countryCode] || b.countryCode;
    if (nameA !== nameB) return nameA.localeCompare(nameB, 'ru');
    return a.latency - b.latency;
  });

  const countryCounts = {};
  const nodes = withGeo.map((item, i) => {
    const countryName = COUNTRY_NAMES[item.countryCode] || item.countryCode;
    countryCounts[item.countryCode] = (countryCounts[item.countryCode] || 0) + 1;
    const n = countryCounts[item.countryCode];
    const flag = flagFromCode(item.countryCode);
    const suffix = n > 1 ? ` #${n}` : '';
    const flagMark = item.whiteFlag ? ' 🏳️' : '';
    const remarks = `${flag}${flagMark} ${countryName}${suffix} • ${item.latency} ms • ${item.type}`;
    const tag = `node-${i + 1}`;
    return { tag, remarks, outbound: item.outbound, countryCode: item.countryCode, latency: item.latency, type: item.type };
  });

  console.log(`PROFILES: ${nodes.length}`);

  const nodeTags = nodes.map((n) => n.tag);
  const autoConfig = buildAutoConfig(nodeTags);
  autoConfig.outbounds = [
    ...nodes.map((n) => ({ ...n.outbound, tag: n.tag })),
    { protocol: 'freedom', tag: 'direct' },
    { protocol: 'blackhole', tag: 'block' }
  ];

  console.log(`AUTO NODES: ${nodeTags.length}`);

  const profiles = nodes.map((n) => buildIndividualConfig(n.outbound, n.remarks));
  const subscription = [autoConfig, ...profiles];

  // Final validation before writing anything out.
  if (subscription[0].remarks !== '🇪🇺 АВТО ⚡') {
    console.error('VALIDATION FAILED: AUTO remarks mismatch');
    process.exit(1);
  }
  const hasNodeOutbound = subscription[0].outbounds.some(
    (o) => typeof o.tag === 'string' && o.tag.startsWith('node-')
  );
  if (!hasNodeOutbound) {
    console.error('VALIDATION FAILED: AUTO has no node-* outbound');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(NODES_PATH), { recursive: true });
  fs.writeFileSync(NODES_PATH, JSON.stringify(nodes.map(({ outbound, ...rest }) => rest), null, 2));

  fs.mkdirSync(path.dirname(SUBSCRIPTION_PATH), { recursive: true });
  fs.writeFileSync(SUBSCRIPTION_PATH, JSON.stringify(subscription, null, 2));

  fs.mkdirSync(path.dirname(PUBLIC_PATH), { recursive: true });
  fs.writeFileSync(PUBLIC_PATH, JSON.stringify(subscription, null, 2));

  console.log(`Saved subscription with ${subscription.length} entries (1 AUTO + ${profiles.length} profiles)`);
}

main().catch((err) => {
  console.error('GENERATOR FATAL:', err);
  process.exit(1);
});
