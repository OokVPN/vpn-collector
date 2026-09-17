const prefixes = [
  "vless://",
  "vmess://",
  "trojan://",
  "ss://",
  "socks://",
  "hysteria2://",
  "hy2://"
];

export function parseConfigs(text) {
  if (!text) {
    return [];
  }

  const lines = text
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean);

  return [
    ...new Set(
      lines.filter(line =>
        prefixes.some(prefix => line.startsWith(prefix))
      )
    )
  ];
}
