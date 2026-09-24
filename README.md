# vpn-collector

Автоматический сборщик публичных VPN-конфигураций (VLESS / VMess / Trojan / Shadowsocks / SOCKS / SOCKS5 / Hysteria2) с **реальной проверкой работоспособности** через локальный SOCKS5 и Xray, GeoIP-фильтрацией, генерацией AUTO-балансировщика и подписки для Happ, публикуемой через Vercel.

## Архитектура

```
sources.json
   ↓ collector.js — скачивает источники, извлекает URI
data/raw.json
   ↓ checker.cjs
   TCP → Xray config → Xray process → локальный SOCKS5 → реальный HTTPS через прокси → latency
data/checked.json (только реально рабочие серверы)
   ↓ generator.js
   GeoIP → фильтр RU → детект 🏳️ → AUTO + отдельные профили
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
- `src/checker.cjs` — критическая логика проверки: TCP → Xray → локальный SOCKS5 → реальный HTTPS-запрос **через** этот SOCKS5 → latency. Никакого `direct`-fallback внутри проверки нет: если VPN не работает, запрос падает.
- `src/geoip.js` — определение страны по IP через публичный GeoIP API, с таймаутом и fallback `UN`.
- `src/generator.js` — фильтрует по latency, определяет страну, исключает `RU`, детектирует специальные "белые" серверы (🏳️), собирает AUTO-профиль (`leastLoad`-балансировщик) и отдельные профили, пишет `data/subscription.json` и `public/subscription.json`.

## Checker — почему это не просто TCP-пинг

Открытый TCP-порт ещё не означает рабочий VPN. Поэтому сервер засчитывается рабочим только при прохождении всей цепочки:

```
TCP PASS
  + XRAY PASS (процесс поднялся и жив)
  + SOCKS PASS (локальный SOCKS реально принимает соединения)
  + PROXY HTTPS PASS (настоящий HTTPS-запрос к https://www.gstatic.com/generate_204
                       прошёл именно через 127.0.0.1:<локальный SOCKS>, а не напрямую)
  + latency <= MAX_LATENCY
= PASS
```

Для каждого одновременно проверяемого сервера используется свой локальный порт (начиная с `127.0.0.1:20000+`), число параллельных Xray-процессов ограничено переменной `XRAY_CONCURRENCY`. После каждой проверки (в том числе при ошибке/таймауте) Xray-процесс останавливается, временный конфиг удаляется.

## GeoIP и фильтр России

Каждый прошедший проверку сервер прогоняется через GeoIP (`src/geoip.js`). Серверы с `countryCode === "RU"` полностью исключаются из `data/nodes.json`, `data/subscription.json`, `public/subscription.json`, AUTO-профиля и отдельных профилей. Если GeoIP недоступен — используется код `UN`, но такой сервер не отбрасывается (ошибка одного IP не должна останавливать генератор).

## Детект "🏳️"

Remark исходного URI нормализуется (`toLowerCase`, замена `-_/` и повторных пробелов на один пробел) и проверяется на вхождение триггеров: `обход глушилок`, `белые списки`, `обход белых списков`, `lte`, `5g`, `⚪`. При совпадении к имени профиля добавляется флаг `🏳️`.

## AUTO-профиль

Собирается напрямую в `generator.js` (без отдельного `auto.js`) на основе `leastLoad`-балансировщика Xray. Все прошедшие проверку не-RU серверы подставляются как `node-1`, `node-2`, ... — как в `routing.balancers[0].selector`, так и в `burstObservatory.subjectSelector`. AUTO всегда первый элемент в `subscription.json`, с `remarks: "🇪🇺 АВТО ⚡"`.

## GitHub Actions

`.github/workflows/update.yml`:
1. Устанавливает Node.js и актуальный релиз Xray-core.
2. `npm run collect` — сбор источников.
3. Вычисляет `BATCH_INDEX` (по `github.run_number`), чтобы не проверять десятки тысяч серверов за один прогон.
4. `npm run check` — проверка текущего батча (результаты накапливаются в `data/checked.json` от прогона к прогону).
5. `npm run generate` — сборка подписки.
6. Валидация `public/subscription.json` (должен быть массивом, первый элемент — AUTO с хотя бы одним `node-*` outbound).
7. Коммит и push, только если валидация прошла — при ошибке рабочая подписка не перезаписывается пустой.

Запуск: `workflow_dispatch` вручную или по `cron`.

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
