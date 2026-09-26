import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';

const TIMEOUT = 8000;

const FALLBACK = {
  countryCode: 'UN',
  countryName: 'Неизвестно'
};

const CACHE = new Map();

function normalizeResult(
  countryCode,
  countryName
) {
  if (
    typeof countryCode !== 'string'
  ) {
    return null;
  }

  const code =
    countryCode
      .trim()
      .toUpperCase();

  if (
    !/^[A-Z]{2}$/.test(code)
  ) {
    return null;
  }

  let name =
    typeof countryName === 'string'
      ? countryName.trim()
      : '';

  if (!name) {
    name = code;
  }

  return {
    countryCode: code,
    countryName: name
  };
}

function requestJson(url) {
  return new Promise(
    (resolve) => {
      let req;

      try {
        req = https.get(
          url,
          {
            timeout: TIMEOUT,

            headers: {
              'User-Agent':
                'OokVPN/2.0',
              'Accept':
                'application/json'
            }
          },
          (res) => {
            let data = '';

            res.setEncoding(
              'utf8'
            );

            res.on(
              'data',
              (chunk) => {
                data += chunk;
              }
            );

            res.on(
              'end',
              () => {
                try {
                  if (
                    res.statusCode &&
                    res.statusCode >= 400
                  ) {
                    resolve(null);
                    return;
                  }

                  const parsed =
                    JSON.parse(data);

                  resolve(parsed);
                } catch {
                  resolve(null);
                }
              }
            );

            res.on(
              'error',
              () => resolve(null)
            );
          }
        );
      } catch {
        resolve(null);
        return;
      }

      req.on(
        'timeout',
        () => {
          req.destroy();
          resolve(null);
        }
      );

      req.on(
        'error',
        () => resolve(null)
      );
    }
  );
}

async function resolveHost(
  host
) {
  if (
    net.isIP(host)
  ) {
    return host;
  }

  try {
    const addresses =
      await dns.lookup(
        host,
        {
          all: true,
          verbatim: true
        }
      );

    if (
      !Array.isArray(addresses) ||
      addresses.length === 0
    ) {
      return host;
    }

    const ipv4 =
      addresses.find(
        (x) =>
          x &&
          net.isIP(x.address) === 4
      );

    if (ipv4) {
      return ipv4.address;
    }

    const ipv6 =
      addresses.find(
        (x) =>
          x &&
          net.isIP(x.address) === 6
      );

    return (
      ipv6?.address ||
      host
    );
  } catch {
    return host;
  }
}

async function lookupIpWho(
  ip
) {
  const data =
    await requestJson(
      `https://ipwho.is/${encodeURIComponent(
        ip
      )}`
    );

  if (
    data?.success === true
  ) {
    return normalizeResult(
      data.country_code,
      data.country
    );
  }

  return null;
}

async function lookupIpApi(
  ip
) {
  const data =
    await requestJson(
      `https://ip-api.com/json/${encodeURIComponent(
        ip
      )}?fields=status,countryCode,country`
    );

  if (
    data?.status === 'success'
  ) {
    return normalizeResult(
      data.countryCode,
      data.country
    );
  }

  return null;
}

async function lookupIpApiCo(
  ip
) {
  const data =
    await requestJson(
      `https://ipapi.co/${encodeURIComponent(
        ip
      )}/json/`
    );

  if (
    data &&
    !data.error
  ) {
    return normalizeResult(
      data.country_code,
      data.country_name
    );
  }

  return null;
}

export async function geoipLookup(
  host
) {
  if (!host) {
    return FALLBACK;
  }

  const cacheKey =
    String(host)
      .trim()
      .toLowerCase();

  if (
    CACHE.has(cacheKey)
  ) {
    return CACHE.get(
      cacheKey
    );
  }

  const ip =
    await resolveHost(
      host
    );

  const query =
    ip || host;

  const [
    ipwhoResult,
    ipApiResult
  ] = await Promise.all([
    lookupIpWho(query),
    lookupIpApi(query)
  ]);

  if (
    ipwhoResult &&
    ipApiResult
  ) {
    if (
      ipwhoResult.countryCode ===
      ipApiResult.countryCode
    ) {
      CACHE.set(
        cacheKey,
        ipwhoResult
      );

      return ipwhoResult;
    }

    CACHE.set(
      cacheKey,
      ipwhoResult
    );

    return ipwhoResult;
  }

  if (ipwhoResult) {
    CACHE.set(
      cacheKey,
      ipwhoResult
    );

    return ipwhoResult;
  }

  if (ipApiResult) {
    CACHE.set(
      cacheKey,
      ipApiResult
    );

    return ipApiResult;
  }

  const third =
    await lookupIpApiCo(
      query
    );

  if (third) {
    CACHE.set(
      cacheKey,
      third
    );

    return third;
  }

  CACHE.set(
    cacheKey,
    FALLBACK
  );

  return FALLBACK;
}
