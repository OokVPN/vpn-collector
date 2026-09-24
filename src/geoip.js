import https from 'node:https';

const TIMEOUT = 4000;
const FALLBACK = { countryCode: 'UN', countryName: 'Неизвестно' };

export function geoipLookup(host) {
  return new Promise((resolve) => {
    let req;
    try {
      req = https.get(
        `https://ip-api.com/json/${encodeURIComponent(host)}?fields=status,countryCode,country`,
        { timeout: TIMEOUT },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.status === 'success' && json.countryCode) {
                resolve({ countryCode: json.countryCode, countryName: json.country || json.countryCode });
                return;
              }
            } catch {
              // fall through to fallback
            }
            resolve(FALLBACK);
          });
          res.on('error', () => resolve(FALLBACK));
        }
      );
    } catch {
      resolve(FALLBACK);
      return;
    }

    req.on('timeout', () => {
      req.destroy();
      resolve(FALLBACK);
    });
    req.on('error', () => resolve(FALLBACK));
  });
}
