import config, { resolvePath } from './config.js';
import { readJson } from './util.js';

const data = readJson(resolvePath(config.paths.subscriptionPublic), null);

function fail(message) {
  console.error(`VALIDATION FAILED: ${message}`);
  process.exit(1);
}

if (!Array.isArray(data) || data.length === 0) fail('empty subscription');
if (data[0].remarks !== config.generator.autoRemarks) fail('AUTO missing or not first');

const hasNode = (data[0].outbounds || []).some((o) => typeof o.tag === 'string' && o.tag.startsWith('node-'));
if (!hasNode) fail('AUTO has no node-* outbounds');

console.log('Validation OK:', data.length, 'entries');
