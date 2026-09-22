import dns from "dns/promises";

const cache =
  new Map();

export async function resolveGeo(
  hostname
) {
  if (
    cache.has(hostname)
  ) {
    return cache.get(
      hostname
    );
  }

  try {
    const resolved =
      await dns.lookup(
        hostname
      );

    const ip =
      resolved.address;

    const response =
      await fetch(
        `https://ipwho.is/${encodeURIComponent(ip)}`,
        {
          signal:
            AbortSignal.timeout(
              7000
            )
        }
      );

    if (!response.ok) {
      return null;
    }

    const data =
      await response.json();

    if (!data.success) {
      return null;
    }

    const result = {
      ip,

      countryCode:
        data.country_code,

      country:
        data.country
    };

    cache.set(
      hostname,
      result
    );

    return result;
  } catch {
    return null;
  }
}
