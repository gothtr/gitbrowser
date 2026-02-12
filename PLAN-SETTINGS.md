# План: Обновление настроек GitBrowser

## Безопасность API токена CryptoBot

**Проблема:** API токен нельзя хранить в открытом виде в клиентском коде — любой может декомпилировать Electron app.

**Решение:** Двухуровневая обфускация в main process:
1. Токен хранится как XOR-зашифрованная строка + base64 в `main.js`
2. Расшифровка происходит только в main process (Node.js), не в renderer
3. Вызовы CryptoBot API идут через `ipcMain.handle('donate-create-invoice')` → `net.fetch` к `https://pay.crypt.bot/api/createInvoice`
4. Renderer (settings.html) никогда не видит токен — только получает `bot_invoice_url` для открытия

**Почему не серверный прокси:** Это десктопное open-source приложение без бэкенда. Обфускация — разумный компромисс. Токен CryptoBot позволяет только создавать инвойсы (получать деньги), не отправлять — риск минимален.

## Структура разделов настроек

### 1. Основные (уже есть, обновить)
- Язык интерфейса
- Поведение при запуске (восстановить сессию / новая вкладка)
- Поисковая система по умолчанию
- Домашняя страница

### 2. Внешний вид (перенести персонализацию сюда)
- Тема (Тёмная / Светлая / Системная)
- Размер шрифта
- Фон новой вкладки (цвет из палитры, как сейчас в newtab)
- Акцентный цвет интерфейса

### 3. Приватность и безопасность (уже есть, оставить)
- Блокировка трекеров
- Блокировка рекламы
- Принудительный HTTPS
- DNS over HTTPS
- Анти-фингерпринтинг
- Очистка данных при выходе
- Менеджер паролей (ссылка)

### 4. Дополнительно
- Сброс настроек
- Очистка кэша
- Очистка истории
- Очистка cookies

### 5. О программе (новый раздел)
- Логотип + название + версия
- Ссылка на GitHub: https://github.com/gothtr/gitbrowser
- Лицензия
- Кнопка "Поддержать проект" → CryptoBot донат
  - Выбор суммы: 1$, 5$, 10$, произвольная
  - Валюта: USDT (fiat: USD)
  - Создание инвойса через API → открытие `mini_app_invoice_url` в новой вкладке

## Реализация CryptoBot доната

```
settings.html → gb.createDonateInvoice(amount)
    ↓ IPC
main.js → net.fetch('https://pay.crypt.bot/api/createInvoice', {
  headers: { 'Crypto-Pay-API-Token': deobfuscate(TOKEN) },
  body: { currency_type: 'fiat', fiat: 'USD', accepted_assets: 'USDT,TON,BTC,ETH',
          amount, description: 'GitBrowser Donation', paid_btn_name: 'callback',
          paid_btn_url: 'https://github.com/gothtr/gitbrowser' }
})
    ↓
Возвращает bot_invoice_url → открывается в новой вкладке браузера
```

## Файлы для изменения
- `electron/ui/settings.html` — полная переработка
- `electron/main.js` — IPC handler для доната + обфусцированный токен
- `electron/preload.js` — новый метод `createDonateInvoice`
- `locales/ru.json` — новые строки для настроек
- `locales/en.json` — новые строки для настроек
