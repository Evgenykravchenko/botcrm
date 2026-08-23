# Production-развёртывание BotCRM

Это руководство описывает рекомендуемый запуск BotCRM на одном Linux-сервере через Docker Compose. Наружу публикуются только Caddy и HTTPS. PostgreSQL, Redis, API, worker и MinIO работают во внутренней Docker-сети.

## Что уже автоматизировано

- сборка отдельных контейнеров web, API и worker;
- последовательный запуск PostgreSQL → миграции → API → worker/web → Caddy;
- повторяемые миграции с журналом и checksum;
- создание первого workspace и владельца;
- генерация независимых случайных секретов;
- HTTPS и автоматическое продление сертификатов;
- закрытые PostgreSQL, Redis и MinIO;
- Redis AUTH, приватный S3 bucket и CORS только для домена панели;
- health-check, restart policy и ротация Docker-логов;
- rate limiting, RBAC, MFA и зашифрованные credentials;
- зашифрованный backup PostgreSQL + MinIO;
- опциональные Prometheus и Grafana.

## 1. Требования к серверу

Рекомендуемая начальная конфигурация:

| Ресурс | Минимум | Рекомендуется |
|---|---:|---:|
| CPU | 2 vCPU | 4 vCPU |
| RAM | 4 ГБ | 8 ГБ |
| Диск | 40 ГБ SSD | 100+ ГБ SSD |
| ОС | Ubuntu 24.04 / Debian 12 | актуальный LTS |
| Docker | Engine + Compose plugin | актуальная стабильная версия |
| Node.js | 22.13+ | актуальная 22 LTS |

Для большой истории сообщений и медиа размер диска планируется отдельно.

Установку Docker выполняйте по официальной документации:

- https://docs.docker.com/engine/install/ubuntu/
- https://docs.docker.com/compose/install/linux/

## 2. DNS и firewall

Понадобятся два публичных DNS-имени:

| Имя | Назначение |
|---|---|
| `crm.example.ru` | панель, REST API, webhook и документация |
| `media.crm.example.ru` | временные подписанные ссылки на вложения |

Обе A-записи должны указывать на публичный IPv4 сервера. При использовании IPv6 добавьте AAAA-записи.

Разрешите входящие подключения:

```text
22/tcp    SSH — желательно только с доверенных IP
80/tcp    ACME challenge и redirect на HTTPS
443/tcp   HTTPS
443/udp   HTTP/3
```

Не открывайте `3000`, `4100`, `5432`, `6379`, `9000`, `9001`, `9090` или `3002`. В production compose эти сервисы не привязаны к публичному интерфейсу; Prometheus и Grafana при включении слушают только `127.0.0.1`.

Caddy сможет автоматически получить сертификат, когда DNS корректен, порты 80/443 доступны, а volume `caddy_data` сохраняется между обновлениями.

### Tailscale Funnel без публичного IP

Если сервер уже подключён к Tailscale или находится за NAT, используйте отдельный контейнерный узел BotCRM. Он не меняет конфигурацию Tailscale хоста и не занимает host-порты других приложений.

1. Выберите уникальное имя узла, например `botcrm-rpi`.
2. Узнайте суффикс tailnet в Tailscale Admin Console или из DNS-имени существующего устройства.
3. Создайте конфигурацию, указав один DNS-host и порт `8443` для хранилища:

```bash
npm run prod:init -- \
  --domain botcrm-rpi.example-tailnet.ts.net \
  --storage-domain botcrm-rpi.example-tailnet.ts.net:8443 \
  --email owner@example.ru \
  --owner-name "Владелец" \
  --workspace-name "BotCRM" \
  --timezone Europe/Moscow
```

4. Проверьте объединённый Compose и запустите его:

```bash
export TAILSCALE_HOSTNAME=botcrm-rpi
npm run prod:check
npm run prod:tailscale:config
npm run prod:tailscale:up
```

5. При первом запуске получите одноразовую ссылку без передачи auth key:

```bash
docker compose --env-file .env.production \
  -f infra/docker-compose.prod.yml \
  -f infra/docker-compose.tailscale.yml logs tailscale
```

Откройте ссылку `https://login.tailscale.com/a/...` и подтвердите новый узел. Конфигурация `infra/tailscale-serve/serve.json` публикует панель/API на `443`, а подписанные S3-ссылки на `8443`. Funnel принимает только HTTPS, состояние авторизации хранится в volume `botcrm_tailscale_state`. На маршрутизаторе и в UFW не требуется открывать новые входящие порты.

Проверка после авторизации:

```bash
npm run prod:tailscale:ps
curl -fsS "https://${TAILSCALE_HOSTNAME}.example-tailnet.ts.net/api/v1/health"
curl -fsS "https://${TAILSCALE_HOSTNAME}.example-tailnet.ts.net:8443/minio/health/live"
```

Не запускайте одновременно обычный `prod:up` и Tailscale-профиль: обычный профиль публикует Caddy на host-портах `80/443`, а Funnel-профиль намеренно сбрасывает эти привязки.

## 3. Получение проекта

```bash
sudo mkdir -p /opt/botcrm
sudo chown "$USER":"$USER" /opt/botcrm
git clone <URL-РЕПОЗИТОРИЯ> /opt/botcrm
cd /opt/botcrm
npm ci
```

Проверьте инструменты:

```bash
node --version
docker --version
docker compose version
```

## 4. Создание конфигурации

```bash
npm run prod:init -- \
  --domain crm.example.ru \
  --storage-domain media.crm.example.ru \
  --email owner@example.ru \
  --owner-name "Иван" \
  --workspace-name "Моя команда" \
  --timezone Europe/Moscow
```

Будет создан файл `.env.production` с правами `0600`. Команда:

- сгенерирует пароли PostgreSQL, Redis, MinIO и Grafana;
- создаст master key для шифрования credentials и TOTP;
- создаст сервисный и webhook-секреты;
- один раз выведет пароль первого владельца.

Сохраните пароль владельца в менеджере паролей. Файл `.env.production` нельзя коммитить, отправлять в чат или прикладывать к заявкам поддержки.

Если нужно разрешить автоматизациям исходящие webhook, перечислите только доверенные hostnames:

```dotenv
AUTOMATION_WEBHOOK_ALLOWLIST=hooks.example.ru,crm.internal.example.ru
```

Пустое значение блокирует все исходящие webhooks автоматизаций.

## 5. Предварительная проверка

```bash
npm run prod:check
npm run prod:config
```

Проверяются обязательные переменные, длина секретов, production-флаги и валидность Docker Compose.

## 6. Первый запуск

```bash
npm run prod:up
npm run prod:ps
```

Первый запуск дольше повторных: Docker скачивает базовые образы и собирает приложение. Посмотреть процесс:

```bash
npm run prod:logs
```

Ожидаемое состояние:

- `postgres` и `redis` — healthy;
- `migrate` и `create-bucket` — завершены с кодом 0;
- `api` и `web` — healthy;
- `worker` и `caddy` — running.

Проверьте извне:

```bash
npm run prod:check:live
```

Затем откройте `https://crm.example.ru` и войдите email/паролем владельца.

## 7. Что делает reverse proxy

Caddy обслуживает два host:

```text
crm.example.ru
  /api/*       → API
  /api-docs*   → Swagger
  остальные    → web-панель

media.crm.example.ru
  все запросы  → приватный MinIO по подписанной S3-ссылке
```

Также добавляются HSTS, запрет iframe, `nosniff`, Referrer-Policy, Permissions-Policy и базовая Content-Security-Policy. HTTP автоматически перенаправляется на HTTPS.

## 8. Первый вход и настройка

После входа:

1. Откройте профиль и включите TOTP-MFA.
2. В разделе «Настройки» создайте пользователей и выдайте минимально необходимые роли.
3. В разделе «Боты и каналы» подключите первый канал.
4. Проверьте публичный webhook URL.
5. Отправьте тестовое сообщение и убедитесь, что оно появляется в realtime.
6. Проверьте отправку текста и вложения.
7. Настройте backup до добавления реальных клиентов.

Значение `BOOTSTRAP_OWNER_PASSWORD` не меняет пароль существующего владельца при рестарте. Оно применяется только при первоначальном создании аккаунта. После первого успешного запуска можно хранить его только в защищённом secret storage.

## 9. Обновление без потери данных

Перед обновлением сделайте backup:

```bash
cd /opt/botcrm
export BOTCRM_BACKUP_PASSWORD='отдельный пароль длиной не менее 16 символов'
npm run prod:backup

git pull --ff-only
npm ci
npm run prod:check
npm run prod:up
npm run prod:check:live
```

`prod:up` пересобирает изменившиеся образы. Migration container применяет только отсутствующие миграции и сверяет checksum уже выполненных файлов.

Не редактируйте применённые SQL-миграции. Для изменения схемы добавляйте новый файл в `infra/migrations` со следующим номером.

## 10. Backup

Backup включает:

- PostgreSQL в custom format;
- содержимое bucket `botcrm-media`;
- AES-256-GCM шифрование всего архива.

```bash
export BOTCRM_BACKUP_PASSWORD='уникальный backup-пароль'
npm run prod:backup
```

Файл создаётся в `backups/`. Копируйте его в другое хранилище или другую площадку. Пароль backup храните отдельно от архива и `.env.production`.

Рекомендуемый график:

- ежедневно — автоматический зашифрованный backup;
- еженедельно — внешняя копия;
- ежемесячно — тест восстановления на отдельном сервере.

## 11. Восстановление

Восстановление перезаписывает текущую БД и медиа. Сначала остановите API и worker либо выполняйте операцию в период обслуживания.

```bash
docker compose --env-file .env.production -f infra/docker-compose.prod.yml stop api worker web caddy

export BOTCRM_BACKUP_PASSWORD='тот же backup-пароль'
npm run prod:restore -- backups/botcrm-YYYY-MM-DD.botcrm-backup --confirm

npm run prod:up
npm run prod:check:live
```

После восстановления проверьте вход, диалоги, последние вложения, очереди и подключения каналов.

## 12. Monitoring

Запуск:

```bash
npm run prod:up:observability
```

Сервисы доступны только на loopback сервера:

- Prometheus — `http://127.0.0.1:9090`;
- Grafana — `http://127.0.0.1:3002`.

Подключайтесь через SSH tunnel:

```bash
ssh -L 3002:127.0.0.1:3002 -L 9090:127.0.0.1:9090 user@server
```

Токен для scrape передаётся Prometheus через Docker secret, а не публикуется в URL.

## 13. Полезные команды

```bash
npm run prod:ps
npm run prod:logs
npm run prod:restart
npm run prod:stop
npm run prod:migrate
npm run prod:check
npm run prod:check:live
```

Точечные логи:

```bash
docker compose --env-file .env.production -f infra/docker-compose.prod.yml logs -f api
docker compose --env-file .env.production -f infra/docker-compose.prod.yml logs -f worker
docker compose --env-file .env.production -f infra/docker-compose.prod.yml logs -f caddy
```

## 14. Диагностика

### Caddy не получает сертификат

- DNS обоих имён должен указывать на этот сервер.
- Порты 80 и 443 должны быть доступны из интернета.
- На портах не должен работать другой Nginx/Apache.
- Проверьте `docker compose ... logs caddy`.

### API остаётся unhealthy

```bash
docker compose --env-file .env.production -f infra/docker-compose.prod.yml logs migrate api
```

Чаще всего причина — неверный пароль PostgreSQL, незавершённая миграция или слишком короткий master key.

### Вложения загружаются с ошибкой

Проверьте:

- DNS и TLS домена `media.*`;
- состояние `create-bucket`;
- совпадение `MINIO_ROOT_USER / MINIO_ROOT_PASSWORD`;
- отсутствие proxy/CDN, изменяющего query string подписанного URL;
- CORS bucket через логи `create-bucket`.

### Сообщения остаются queued

Проверьте worker, Redis и health подключения канала:

```bash
docker compose --env-file .env.production -f infra/docker-compose.prod.yml logs worker redis
```

### После смены master key не расшифровываются подключения

`MASTER_ENCRYPTION_KEY` — постоянный ключ установки. Его нельзя менять без отдельной процедуры ротации всех зашифрованных данных. Восстановите прежнее значение из защищённой копии.

## 15. Checklist перед реальными клиентами

- [ ] DNS и HTTPS работают для панели и media.
- [ ] Внешние порты внутренних сервисов закрыты.
- [ ] У владельца включена MFA.
- [ ] Созданы отдельные аккаунты операторов.
- [ ] `.env.production` имеет права 0600 и не попал в Git.
- [ ] Backup создаётся автоматически и копируется с сервера.
- [ ] Выполнено тестовое восстановление.
- [ ] Отправка текста, изображения и кнопок проверена на каждом канале.
- [ ] Настроены согласия, отписка и suppression list.
- [ ] Проверены правила обработки персональных данных вашей юрисдикции.
- [ ] Настроены monitoring и оповещения об ошибках.
