# Запуск и эксплуатация BotCRM

> Для развёртывания на публичном сервере используйте отдельное руководство: [Production deployment](PRODUCTION.md).

Это руководство описывает локальный запуск на Windows, подготовку production-сервера, обновление и восстановление системы. Функции панели описаны в [USER_GUIDE.md](USER_GUIDE.md), интеграция ботов — в [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md).

## 1. Что запускается

BotCRM состоит из пяти частей:

| Компонент | Назначение | Адрес по умолчанию |
|---|---|---|
| Web | Панель операторов | `http://localhost:3001` |
| API | REST, webhook, авторизация, realtime | `http://localhost:4100` |
| Worker | Доставка сообщений, рассылки, повторы, автоматизации | отдельного порта нет |
| PostgreSQL | Все бизнес-данные | `localhost:5432` |
| Redis + MinIO | Очереди и вложения | `localhost:6379`, `http://localhost:9001` |

PostgreSQL является источником истины. Если API не может подключиться к базе, панель не подменяет данные моками.

## 2. Требования

- Windows 10/11, Linux или macOS;
- Node.js 22.13 или новее;
- npm;
- Docker Desktop с запущенным Linux engine;
- свободные порты `3001`, `4100`, `5432`, `6379`, `9000`, `9001`.

Проверка:

```powershell
node --version
npm --version
docker version
```

## 3. Первый локальный запуск

В корне проекта:

```powershell
Copy-Item .env.example .env
npm install
npm run infra:up
```

Перед первым входом откройте `.env` и обязательно задайте:

```dotenv
POSTGRES_PASSWORD=длинный-пароль
DATABASE_URL=postgresql://botcrm:длинный-пароль@localhost:5432/botcrm
MINIO_ROOT_PASSWORD=другой-длинный-пароль
SERVICE_TOKEN=случайный-секрет-не-короче-32-символов
MASTER_ENCRYPTION_KEY=случайный-ключ-не-короче-32-символов
BOOTSTRAP_OWNER_EMAIL=owner@example.ru
BOOTSTRAP_OWNER_PASSWORD=уникальный-пароль-не-короче-12-символов
```

Эти переменные уже перечислены в `.env.example`. Перед первым запуском замените значения в локальном `.env`: API использует их для создания первоначального владельца и установки его пароля.

Запустите три процесса в трёх терминалах:

```powershell
npm run api:dev
```

```powershell
npm run worker:dev
```

```powershell
npm run dev
```

Откройте:

- панель — `http://localhost:3001`;
- документация BotCRM — `http://localhost:3001/docs`;
- Swagger — `http://localhost:4100/docs`;
- health-check — `http://localhost:4100/api/v1/health`;
- MinIO — `http://localhost:9001`.

Свежая база пустая. В ней есть только workspace и владелец: контакты, боты, сделки и рассылки создаются пользователем.

## 4. Демо-набор — только по желанию

Для обучения на вымышленных контактах:

```powershell
npm run demo:seed
```

В рабочей базе эту команду запускать не нужно. Состав набора находится в `infra/seed.sql`.

## 5. Обычный повторный запуск

Если зависимости уже установлены и Docker-тома существуют:

```powershell
npm run infra:up
```

Затем запустите API, worker и web теми же тремя командами. `infra:up` не удаляет существующие данные.

## 6. Проверка работоспособности

```powershell
Invoke-RestMethod http://localhost:4100/api/v1/health
docker compose -f infra/docker-compose.yml ps
npm run test:all
```

Нормальное состояние: PostgreSQL и Redis имеют статус `healthy`, API возвращает `status: ok`, web-сборка и тесты проходят.

## 7. Остановка

Остановить процессы Node.js — `Ctrl+C` в их терминалах. Остановить контейнеры без удаления данных:

```powershell
docker compose -f infra/docker-compose.yml stop
```

Команда `docker compose ... down -v` удаляет PostgreSQL, очередь и файлы. Используйте её только для полного сброса тестовой установки.

### Realtime для ранее созданной базы

В новой установке realtime-триггеры создаются автоматически при первом запуске PostgreSQL. Если база была создана до появления realtime, один раз выполните:

```powershell
npm run db:migrate:realtime
npm run db:migrate:message-order
npm run db:migrate:attributes
npm run db:migrate:attribute-labels
```

Первая команда добавляет realtime-события, вторая — стабильный причинный порядок сообщений даже при небольшой рассинхронизации часов Telegram и сервера. После этого перезапустите API. В левой нижней части панели появится статус «Обновления в реальном времени». Поток `GET /api/v1/realtime` использует пользовательскую авторизацию и отправляет только события текущего рабочего пространства.
## 8. Production

Минимальные требования:

- отдельный VPS/сервер с HTTPS;
- закрытые снаружи PostgreSQL, Redis и MinIO;
- Caddy/Nginx перед web и API;
- уникальные секреты и пароли;
- `CORS_ORIGINS` только для домена панели;
- `S3_PUBLIC_ENDPOINT`, доступный официальным API каналов;
- `BOT_EVENT_ALLOW_HTTP=false`;
- регулярные backup и проверка восстановления.

Соберите процессы:

```powershell
npm run build
npm run api:build
npm run worker:build
```

Запускайте web, API и worker через systemd, Docker, Kubernetes или другой process manager с автоматическим рестартом.

## 9. Резервное копирование

```powershell
$env:BOTCRM_BACKUP_PASSWORD = "отдельный-длинный-пароль"
npm run backup
```

Восстановление меняет текущие данные и требует подтверждения:

```powershell
$env:BOTCRM_BACKUP_PASSWORD = "тот-же-пароль"
npm run restore -- .\backups\botcrm-....botcrm-backup --confirm
```

Рекомендуется ежедневный backup, недельная внешняя копия и ежемесячная проверка восстановления.

## 10. Наблюдаемость

```powershell
npm run observability:up
```

- Prometheus — `http://localhost:9090`;
- Grafana — `http://localhost:3002`;
- метрики API — `GET /api/v1/metrics`;
- health — `GET /api/v1/health`.

Смените пароль Grafana перед публикацией сервиса.

## 11. Частые проблемы

### Панель открывается, но данных нет

Для чистой установки это нормально. Создайте подключение в «Боты и каналы» или передайте первое событие через API. Если индикатор показывает «API недоступен», проверьте API и PostgreSQL.

### `Failed to fetch dynamically imported module`

Остановите старый web-процесс, удалите только артефакты сборки `.next`/`dist`, снова выполните `npm run dev` и обновите страницу без кэша.

### Docker отвечает `Access is denied`

Запустите Docker Desktop, дождитесь готовности Linux engine и откройте терминал с правами пользователя, имеющего доступ к Docker.

### Сообщения стоят в `queued`

Проверьте, что запущен `npm run worker:dev`, Redis доступен, а подключение канала прошло health-check.

### Webhook не принимается

Проверьте публичный HTTPS URL, connector ID, секрет подписи и raw body. Telegram использует `X-Telegram-Bot-Api-Secret-Token`, WhatsApp — `X-Hub-Signature-256`, generic — `X-BotCRM-Signature`.
