import https from 'node:https';

const TIMEOUT = 8000;
const FALLBACK = {
  countryCode: 'UN',
  countryName: 'Неизвестно'
};

function requestJson(url) {
  return new Promise((resolve) => {
    let req;

    try {
      req = https.get(
        url,
        {
          timeout: TIMEOUT,
          headers: {
            'User-Agent': 'OokVPN/1.0'
          }
        },
        (res) => {
          let data = '';

          res.setEncoding('utf8');

          res.on('data', (chunk) => {
            data += chunk;
          });

          res.on('end', () => {
            try {
              if (res.statusCode && res.statusCode >= 400) {
                resolve(null);
                return;
              }

              resolve(JSON.parse(data));
            } catch {
              resolve(null);
            }
          });

          res.on('error', () => resolve(null));
        }
      );
    } catch {
      resolve(null);
      return;
    }

    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });

    req.on('error', () => resolve(null));
  });
}

export async function geoipLookup(host) {
  const encodedHost = encodeURIComponent(host);

  // Основной GeoIP-провайдер
  const ipwho = await requestJson(
    `https://ipwho.is/${encodedHost}`
  );

  if (
    ipwho?.success === true &&
    typeof ipwho.country_code === 'string' &&
    ipwho.country_code.length === 2
  ) {
    return {
      countryCode: ipwho.country_code.toUpperCase(),
      countryName: ipwho.country || ipwho.country_code
    };
  }

  // Резервный GeoIP-провайдер
  const ipApi = await requestJson(
    `https://ip-api.com/json/${encodedHost}?fields=status,countryCode,country`
  );

  if (
    ipApi?.status === 'success' &&
    typeof ipApi.countryCode === 'string' &&
    ipApi.countryCode.length === 2
  ) {
    return {
      countryCode: ipApi.countryCode.toUpperCase(),
      countryName: ipApi.country || ipApi.countryCode
    };
  }

  // Только если оба сервиса не смогли определить страну
  return FALLBACK;
}
