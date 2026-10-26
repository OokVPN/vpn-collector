import fs from 'node:fs';
import path from 'node:path';

const CONFIG_FILE = path.resolve(process.env.VPN_CONFIG || 'config.json');

const ENV_OVERRIDES = [
  ['HTTP_TIMEOUT', 'collector.timeoutMs', 'number'],
  ['XRAY_TIMEOUT', 'checker.xrayStartTimeoutMs', 'number'],
  ['CURL_TIMEOUT', 'checker.requestTimeoutMs', 'number'],
  ['XRAY_CONCURRENCY', 'checker.concurrency', 'number'],
  ['NEW_SERVER_BATCH', 'checker.batchSize', 'number'],
  ['MAX_REPLACEMENT_ROUNDS', 'checker.maxRounds', 'number'],
  ['TARGET_NODES', 'checker.targetNodes', 'number'],
  ['EXCLUDE_COUNTRIES', 'generator.excludeCountries', 'list']
];

function setByPath(target, dotted, value) {
  const keys = dotted.split('.');
  let node = target;
  for (const key of keys.slice(0, -1)) {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
}

function load() {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(`config file not found: ${CONFIG_FILE}`);
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

  for (const [name, dotted, kind] of ENV_OVERRIDES) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') continue;
    if (kind === 'number') {
      const value = Number(raw);
      if (Number.isFinite(value)) setByPath(config, dotted, value);
    } else if (kind === 'list') {
      setByPath(config, dotted, raw.split(',').map((item) => item.trim()).filter(Boolean));
    }
  }
  return config;
}

export function resolvePath(file) {
  return path.resolve(file);
}

export default load();
