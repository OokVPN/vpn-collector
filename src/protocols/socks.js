export function parseSocks(
  uri,
  tag
) {
  const normalized =
    uri.replace(
      /^socks5:\/\//i,
      "socks://"
    );

  const url =
    new URL(normalized);

  const settings = {
    address:
      url.hostname,

    port:
      Number(url.port) || 1080
  };

  if (url.username) {
    settings.user =
      decodeURIComponent(
        url.username
      );
  }

  if (url.password) {
    settings.pass =
      decodeURIComponent(
        url.password
      );
  }

  return {
    tag,

    protocol: "socks",

    settings
  };
}
