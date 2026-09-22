const PREFIXES = [
  "vless://",
  "vmess://",
  "trojan://",
  "ss://",
  "socks://",
  "socks5://",
  "hysteria2://",
  "hy2://"
];

function clean(line) {
  return line
    .trim()
    .replace(/^["']|["']$/g, "");
}

function supported(line) {
  const lower = line.toLowerCase();

  return PREFIXES.some(
    prefix => lower.startsWith(prefix)
  );
}

function decodeBase64(value) {
  try {
    let data = value
      .replace(/\s+/g, "")
      .replace(/-/g, "+")
      .replace(/_/g, "/");

    data += "=".repeat(
      (4 - data.length % 4) % 4
    );

    return Buffer
      .from(data, "base64")
      .toString("utf8");
  } catch {
    return "";
  }
}

function extract(text) {
  return text
    .split(/\r?\n/)
    .map(clean)
    .filter(Boolean)
    .filter(supported);
}

export function parseConfigs(text) {
  if (!text) {
    return [];
  }

  let result = extract(text);

  if (result.length) {
    return [...new Set(result)];
  }

  const decoded =
    decodeBase64(text.trim());

  if (decoded) {
    result = extract(decoded);
  }

  return [...new Set(result)];
}
