# Исходящие запросы BotCRM через Xray

Этот вариант нужен, когда сервер не может напрямую подключиться к API Telegram или другого официального канала. Через прокси идут только исходящие HTTP-запросы `api` и `worker`; маршруты хоста, Caddy, PostgreSQL, Redis и остальных контейнеров не меняются.

## Требования

- работающий Xray с HTTP inbound;
- отдельная внешняя Docker-сеть, общая только для Xray и BotCRM;
- переменные production-окружения:

```dotenv
BOTCRM_OUTBOUND_PROXY_URL=http://xray_vless:8080
BOTCRM_OUTBOUND_PROXY_NETWORK=botcrm_xray_proxy
```

Не публикуйте HTTP/SOCKS-порт Xray в интернет. Контейнер должен быть доступен только внутри выделенной Docker-сети.

## Запуск

Добавьте Xray в сеть `botcrm_xray_proxy`, затем включите дополнительный Compose-файл:

```bash
docker compose \
  --env-file .env.production \
  -f infra/docker-compose.prod.yml \
  -f infra/docker-compose.tailscale.yml \
  -f infra/docker-compose.xray.yml \
  up -d --build
```

`NO_PROXY` оставляет обращения к PostgreSQL, Redis, MinIO и внутреннему API BotCRM внутри локальной сети. Проверка коннектора, ответы операторов, загрузка Telegram-медиа и рассылки используют Xray благодаря `EnvHttpProxyAgent` в процессах API и worker.

## Проверка

Проверьте официальный API из сети Xray без раскрытия токена бота:

```bash
docker run --rm --network botcrm_xray_proxy curlimages/curl:8.14.1 \
  --proxy http://xray_vless:8080 \
  --max-time 15 --head https://api.telegram.org
```

Код `200`, `301` или `302` подтверждает доступность Telegram API. После этого нажмите «Проверить» в разделе «Боты и каналы».
