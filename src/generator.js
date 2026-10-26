import path from 'node:path';
import { pathToFileURL } from 'node:url';
import config, { resolvePath } from './config.js';
import { parseUri } from './parser.js';
import { createGeoResolver } from './geoip.js';
import { flagFromCode, mapLimit, readJson, writeJson } from './util.js';

const cfg = config.generator;

const regionNames = new Intl.DisplayNames([cfg.locale], { type: 'region' });

function countryName(code) {
  if (!code || code === 'UN') return cfg.unknownCountryName;
  if (cfg.countryNameOverrides[code]) return cfg.countryNameOverrides[code];
  try {
    return regionNames.of(code) || code;
  } catch {
    return code;
  }
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const TRIGGERS = cfg.whiteTriggers.map(normalizeText).filter(Boolean);

export function isWhiteFlag(remark) {
  const text = ` ${normalizeText(remark)} `;
  return TRIGGERS.some((trigger) => text.includes(` ${trigger} `));
}

function inbound(tag, protocol, port, settings) {
  return {
    tag,
    port,
    listen: cfg.inbounds.listen,
    protocol,
    settings,
    sniffing: { enabled: true, routeOnly: false, destOverride: cfg.inbounds.sniffing }
  };
}

function baseInbounds() {
  return [
    inbound('socks', 'socks', cfg.inbounds.socksPort, { udp: true, auth: 'noauth' }),
    inbound('http', 'http', cfg.inbounds.httpPort, { allowTransparent: false })
  ];
}

function baseDns() {
  return { servers: cfg.dns.servers, queryStrategy: cfg.dns.queryStrategy };
}

function systemOutbounds() {
  return [
    { protocol: 'freedom', tag: 'direct' },
    { protocol: 'blackhole', tag: 'block' }
  ];
}

export function buildAutoConfig(nodes) {
  const tags = nodes.map((node) => node.tag);
  const balancer = cfg.balancer;
  const rules = [];
  if (cfg.routing.bittorrentDirect) {
    rules.push({ type: 'field', protocol: ['bittorrent'], outboundTag: 'direct' });
  }
  rules.push({ type: 'field', network: 'tcp,udp', balancerTag: balancer.tag });

  return {
    dns: baseDns(),
    routing: {
      rules,
      balancers: [
        {
          tag: balancer.tag,
          selector: tags,
          strategy: {
            type: 'leastLoad',
            settings: {
              maxRTT: balancer.maxRTT,
              expected: balancer.expected,
              baselines: balancer.baselines,
              tolerance: balancer.tolerance
            }
          },
          fallbackTag: balancer.fallbackTag
        }
      ],
      domainMatcher: cfg.routing.domainMatcher,
      domainStrategy: cfg.routing.domainStrategy
    },
    inbounds: baseInbounds(),
    outbounds: [...nodes.map((node) => ({ ...node.outbound, tag: node.tag })), ...systemOutbounds()],
    burstObservatory: {
      pingConfig: {
        timeout: cfg.observatory.timeout,
        interval: cfg.observatory.interval,
        sampling: cfg.observatory.sampling,
        destination: cfg.observatory.destination,
        connectivity: ''
      },
      subjectSelector: tags
    },
    remarks: cfg.autoRemarks
  };
}

export function buildIndividualConfig(outbound, remarks) {
  return {
    dns: baseDns(),
    inbounds: baseInbounds(),
    outbounds: [{ ...outbound, tag: 'proxy' }, ...systemOutbounds()],
    routing: {
      domainStrategy: cfg.routing.domainStrategy,
      rules: [{ type: 'field', network: 'tcp,udp', outboundTag: 'proxy' }]
    },
    remarks
  };
}

function securityAllowed(parsed) {
  if (cfg.plainProtocols.includes(parsed.type)) return true;
  const security = parsed.outbound.streamSettings && parsed.outbound.streamSettings.security;
  return cfg.allowedSecurity.includes(security);
}

export function selectByCountry(items) {
  const excluded = new Set(cfg.excludeCountries.map((code) => code.toUpperCase()));
  const kept = [];
  const dropped = [];

  for (const item of items) {
    const isExcluded = excluded.has(item.countryCode);
    if (isExcluded && !(cfg.keepExcludedWhenWhitelisted && item.whiteFlag)) dropped.push(item);
    else kept.push(item);
  }

  console.log(`EXCLUDED (${[...excluded].join(',') || 'none'}): ${dropped.length}`);

  if (kept.length === 0 && dropped.length > 0 && cfg.relaxExclusionIfEmpty) {
    console.warn('All working nodes are in excluded countries; keeping them instead of failing.');
    return dropped;
  }
  return kept;
}

async function main() {
  const checkedPath = resolvePath(config.paths.checked);
  const checked = readJson(checkedPath, null);

  if (!Array.isArray(checked)) {
    console.error('data/checked.json not found, run "npm run check" first');
    process.exit(1);
  }

  const candidates = [];
  for (const item of checked) {
    const parsed = item && parseUri(item.uri);
    if (!parsed || !securityAllowed(parsed)) continue;
    candidates.push({
      ...parsed,
      uri: item.uri,
      latency: typeof item.latency === 'number' ? item.latency : Infinity,
      exitIp: item.exitIp,
      exitCountry: item.exitCountry
    });
  }
  console.log(`Candidates after protocol/security filter: ${candidates.length}/${checked.length}`);

  const geo = createGeoResolver();
  await mapLimit(candidates, config.geoip.concurrency, async (candidate) => {
    if (candidate.exitCountry) {
      candidate.countryCode = candidate.exitCountry;
      candidate.geoSource = 'exit';
      return;
    }
    const result = await geo.lookup(candidate.exitIp || candidate.host, candidate.remark);
    candidate.countryCode = result.countryCode;
    candidate.geoSource = result.source;
  });
  geo.save();

  for (const candidate of candidates) candidate.whiteFlag = isWhiteFlag(candidate.remark);

  const selected = selectByCountry(candidates);
  if (selected.length === 0) {
    console.error('AUTO has no working nodes');
    process.exit(1);
  }

  selected.sort((a, b) => {
    const byCountry = countryName(a.countryCode).localeCompare(countryName(b.countryCode), cfg.locale);
    return byCountry || a.latency - b.latency;
  });

  const counters = {};
  const nodes = selected.map((item, index) => {
    counters[item.countryCode] = (counters[item.countryCode] || 0) + 1;
    const suffix = counters[item.countryCode] > 1 ? ` #${counters[item.countryCode]}` : '';
    const prefix = [flagFromCode(item.countryCode), item.whiteFlag ? cfg.whiteMark : ''].filter(Boolean).join(' ');

    return {
      tag: `node-${index + 1}`,
      remarks: `${prefix ? `${prefix} ` : ''}${countryName(item.countryCode)}${suffix}`,
      outbound: item.outbound,
      countryCode: item.countryCode,
      geoSource: item.geoSource,
      latency: Number.isFinite(item.latency) ? item.latency : null,
      type: item.type,
      ...(item.exitIp ? { exitIp: item.exitIp } : {})
    };
  });

  console.log(`PROFILES: ${nodes.length}`);

  const subscription = [
    buildAutoConfig(nodes),
    ...nodes.map((node) => buildIndividualConfig(node.outbound, node.remarks))
  ];

  writeJson(resolvePath(config.paths.nodes), nodes.map(({ outbound, ...rest }) => rest));
  writeJson(resolvePath(config.paths.subscriptionData), subscription);
  writeJson(resolvePath(config.paths.subscriptionPublic), subscription);

  console.log(`Saved subscription with ${subscription.length} entries (1 AUTO + ${nodes.length} profiles)`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main().catch((error) => {
    console.error('GENERATOR FATAL:', error);
    process.exit(1);
  });
}
