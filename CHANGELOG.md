# История изменений

Формат основан на Keep a Changelog, версии следуют Semantic Versioning.

## [Unreleased]

### Added

- Публичная документация и материалы сообщества.

## [0.4.1] — 2026-10-28

### Fixed

- Существующие папки Яндекс Диска сначала проверяются чтением и не требуют права записи для повторного подключения.
- Для отсутствующей папки возвращается отдельная ошибка, если OAuth-токен не имеет права создавать каталоги.

## [0.4.0] — 2026-10-28

### Added

- Единый раздел автоответов для контентных ботов с текстом, медиа, кнопками и fallback.
- Изолированные профили и персональные токены BotCRM Content API.
- Автоматическое создание папок ботов внутри `/bot_crm` на Яндекс Диске.

### Changed

- Directus используется как внутреннее хранилище и больше не выдаёт административный доступ процессам ботов.

## [0.1.0] — 2026-08-23

### Added

- Единый realtime inbox и управление `BOT / HUMAN / PAUSED`.
- Контакты, типизированные переменные, сегменты, воронки и сделки.
- Рассылки с медиа, кнопками, расписанием и ограничениями каналов.
- CRM-автоматизации, аудит, RBAC, TOTP-MFA и rate limiting.
- Telegram, VK, WhatsApp Cloud, Avito и Generic REST connectors.
- TypeScript и Python SDK, OpenAPI и тестовый Telegram-бот.
- Production Docker Compose, Caddy HTTPS, backup/restore и monitoring.

[Unreleased]: https://github.com/Evgenykravchenko/botcrm/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/Evgenykravchenko/botcrm/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Evgenykravchenko/botcrm/compare/v0.3.2...v0.4.0
[0.1.0]: https://github.com/Evgenykravchenko/botcrm/releases/tag/v0.1.0
