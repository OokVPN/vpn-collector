# vpn-collector

Автоматический сборщик публичных VPN-конфигураций (VLESS / VMess / Trojan / Shadowsocks / SOCKS / SOCKS5 / Hysteria2) с **реальной проверкой работоспособности** через локальный SOCKS5 и Xray, GeoIP-фильтрацией, генерацией AUTO-балансировщика и подписки для Happ, публикуемой через Vercel.

## Архитектура

```
sources.json
   ↓ collector.js — скачивает источники, извлекает URI
data/raw.json
   ↓ checker.cjs
   TCP → Xray config → Xray process → реальный HTTPS через прокси
data/checked.json (только реально рабочие серверы)
   ↓ generator.js
   страна выхода / GeoIP → фильтр стран → детект 🏳️ → AUTO + отдельные профили
data/subscription.json, public/subscription.json
   ↓ GitHub Actions (commit + push)
Vercel (раздаёт public/subscription.json)
   ↓
Happ (по ссылке подписки)
```

## Структура проекта

- `src/collector.js` — скачивает источники из `sources.json`, извлекает конфиги (в т.ч. Base64-подписки), сохраняет в `data/raw.json`.
- `src/parser.js` — определяет протокол по префиксу URI и вызывает нужный модуль из `src/protocols/`.
- `src/protocols/*.js` — конвертеры `vless://`, `vmess://`, `trojan://`, `ss://`, `socks://`/`socks5://`, `hysteria2://`/`hy2://` в Xray outbound.
- `src/xray.js` — сборка временного check-конфига Xray, запуск/остановка процесса, ожидание открытия SOCKS-порта.
- `src/checker.cjs` — проверка: TCP → Xray → реальный HTTPS-запрос через локальный HTTP-inbound.
- `src/geoip.js` — определение страны: несколько провайдеров, голосование, кеш.
- `src/config.js`, `config.json` — единый конфиг.
- `src/generator.js` — фильтрует по latency, определяет страну, исключает `RU`, детектирует специальные "белые" серверы (🏳️), собирает AUTO-профиль (`leastLoad`-балансировщик) и отдельные профили, пишет `data/subscription.json` и `public/subscription.json`.

## Конфигурация

Все параметры лежат в `config.json` (пути, таймауты, тестовые URL, GeoIP-провайдеры, фильтры стран, триггеры 🏳️, порты и DNS в подписке, настройки балансировщика). Часть значений можно переопределить переменными окружения: `XRAY_CONCURRENCY`, `CURL_TIMEOUT`, `XRAY_TIMEOUT`, `NEW_SERVER_BATCH`, `MAX_REPLACEMENT_ROUNDS`, `TARGET_NODES`, `EXCLUDE_COUNTRIES`, `HTTP_TIMEOUT`. Другой файл конфига: `VPN_CONFIG=путь`.

Приватные ссылки-подписки не нужно хранить в `sources.json`: добавьте секрет репозитория `SOURCE_URLS` (URL через пробел или с новой строки). В логах источники выводятся только как `host #hash`.

## Checker

Сервер считается рабочим только если через него реально прошёл HTTPS-запрос:

```
TCP-предпроверка (для TCP-транспортов)
  + xray -test (конфиг валиден) + процесс жив
  + запрос через локальный HTTP-inbound (свободный порт от ОС)
  + ответ с ТОЧНЫМ ожидаемым статусом (204 для generate_204, 200 + ip= для cdn-cgi/trace)
= PASS
```

- Лимита по пингу нет. Сервер отбрасывается только если не удалось получить корректный ответ ни от одного тестового URL. `latency` (время полного запроса через туннель) используется только для сортировки.
- Keep-alive не требуется, ответы 3xx/4xx/5xx и «заглушки» не засчитываются.
- В check-конфиге нет `direct`-outbound, утечка трафика мимо VPN при проверке невозможна.
- `cdn-cgi/trace` через туннель возвращает IP и страну выхода (`loc`), они сохраняются в `data/checked.json`.
- Неудачные ноды попадают в `data/failed.json` и не перепроверяются `failedRetryMinutes` минут.
- Рабочие ноды перепроверяются при каждом запуске; если их меньше `targetNodes`, собираются новые.

## GeoIP и фильтр стран

Страна берётся в порядке приоритета: страна выхода из `cdn-cgi/trace` → голосование нескольких GeoIP-провайдеров по всем IP хоста (кворум, circuit breaker, кеш в `data/geoip-cache.json`) → флаг-эмодзи из названия. Названия стран генерируются через `Intl.DisplayNames`.

`generator.excludeCountries` (по умолчанию `["RU"]`) исключает страны. Ноды с триггером «белых списков» в названии исключению не подвергаются (`keepExcludedWhenWhitelisted`), а если после фильтра не осталось ничего, ноды оставляются (`relaxExclusionIfEmpty`), а не роняют генерацию.

## Тесты

`npm test` — парсер, чекер (на локальных фейковых прокси), GeoIP (мок провайдеров), генератор и сквозной прогон с фейковым xray.

## GitHub Actions

`.github/workflows/update.yml`: установка Xray (stable) → `npm run check` → `npm run generate` → `npm run validate` → коммит. Подписка не перезаписывается, если валидация не прошла.

## Vercel

`vercel.json` отдаёт `public/subscription.json` с заголовками `profile-title`, `announce`, `profile-update-interval`, `subscription-userinfo` — как ожидает клиент Happ.

## Подключение к Happ

1. Задеплоить репозиторий на Vercel.
2. В Happ добавить подписку по ссылке:
   ```
   https://YOUR-VERCEL-DOMAIN/subscription.json
   ```
3. Обновление подписки в приложении подтянет актуальный список: AUTO-профиль первым, затем отдельные серверы по странам.

## Быстрый старт

1. Создать репозиторий на GitHub, скопировать в него файлы этого проекта.
2. Заполнить `sources.json` массивом URL источников конфигов, например:
   ```json
   ["https://example.com/sub1.txt", "https://example.com/sub2"]
   ```
3. Запушить в GitHub.
4. Запустить Actions → `Update VPN Subscription` → `workflow_dispatch`.
5. Задеплоить репозиторий на Vercel.
6. Подключить `https://YOUR-VERCEL-DOMAIN/subscription.json` в Happ.
