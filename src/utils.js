export async function fetchText(url, timeout = 15000) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      headers: {
        "User-Agent": "RU-VPN-Collector/1.0"
      }
    });

    if (!response.ok) {
      return null;
    }

    return await response.text();
  } catch {
    return null;
  }
}

export function unique(array) {
  return [...new Set(array)];
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
