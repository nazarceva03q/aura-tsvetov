# Бот «Аура цветов» в Max

Node.js/Express сервер: главное меню бота, ветки «Букеты» / «Цветы поштучно» /
«Цветочные композиции» / «Заказать звонок» / «Задать вопрос», приём заявок
и с бота, и с сайта (единый вебхук `/webhook/lead`), карточка Олесе с
проверкой повторного клиента.

Токен бота уже создан и проверен (`GET /me` живым запросом вернул бота
`@id560903131285_bot`, «Аура- магазин цветов»).

## Важно: сертификат Max требует особого внимания

`platform-api2.max.ru` использует TLS-сертификат от российского
государственного удостоверяющего центра (Минцифры, «Russian Trusted Root
CA»). Этого корня нет в обычных доверенных хранилищах — без него запросы
к Max падают с `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. Это уже решено в коде:
`bot/src/maxApi.js` сам подмешивает сертификат из
`bot/certs/russian-trusted-ca-bundle.pem` к системным корневым, поэтому
никаких дополнительных настроек TLS на сервере делать не нужно — это уже
проверено живым запросом к API.

## Структура

```
bot/
  server.js               – HTTP-сервер, роуты /webhook/max и /webhook/lead
  src/
    config.js              – переменные окружения (+ свой мини-загрузчик .env)
    catalog.js              – каталог товаров = каталог сайта (id, категория, цена)
    store.js                – JSON-файлы вместо БД: клиенты, вопросы, сессии
    maxApi.js               – обёртка над Max Bot API (+ фикс сертификата)
    notify.js               – сборка и отправка карточки заявки Олесе
    bot.js                  – сценарии диалога (меню → заказ, звонок, вопрос)
  scripts/setup-webhook.js  – регистрация вебхука в Max (запустить 1 раз)
  certs/russian-trusted-ca-bundle.pem
  data/                     – customers.json, questions.json, sessions.json
                              (создаются автоматически, в git не попадают)
  .env.example              – скопировать в .env и заполнить
```

## Локальный запуск

```bash
cd bot
npm install
cp .env.example .env   # заполнить MAX_BOT_TOKEN (уже есть) и остальное
npm start
```

Проверка: `curl http://localhost:3000/health` → `{"ok":true,...}`.

## Деплой на Yandex Cloud

Скриншоты настроек Yandex Cloud, о которых вы писали, не прикрепились к
сообщению — пришлите их ещё раз, и я распишу заполнение полей именно под
ваш экран. А пока — рабочая инструкция для самого простого варианта:
маленькая виртуальная машина (Compute Cloud) с Node.js. Она подходит
и для «Serverless Containers», если решите использовать их вместо VM —
код это не ограничивает (обычное Express-приложение, слушающее порт).

### 1. Создать VM в Yandex Cloud

Консоль → **Compute Cloud** → **Создать ВМ**:

| Поле | Что поставить |
|---|---|
| Имя | `aura-bot` (любое) |
| Зона доступности | любая, например `ru-central1-a` |
| Образ/ОС | **Ubuntu 22.04 LTS** |
| Платформа | Intel Ice Lake (по умолчанию) |
| vCPU / RAM | 2 vCPU, 2 ГБ — этого более чем достаточно |
| Диск | 20 ГБ, стандартный сетевой (HDD) |
| Сеть | сеть/подсеть по умолчанию |
| Публичный IP | **включить** (нужен, чтобы Max мог достучаться до вебхука) |
| SSH-ключ | вставить свой публичный ключ (если его нет — сгенерировать: `ssh-keygen -t ed25519`, вставить содержимое `~/.ssh/id_ed25519.pub`) |

После создания запишите **публичный IP** — он понадобится для DNS/сертификата.

### 2. Домен и HTTPS

Max **требует HTTPS с доверенным сертификатом** для вебхука (обычный
Let's Encrypt подходит). Проще всего:

1. Заведите поддомен, например `bot.aura-flower.shop`, и направьте его
   A-записью на публичный IP VM (в панели вашего DNS-провайдера, там же,
   где настроен `aura-flower.shop`).
2. На сервере поставьте Nginx + Certbot и получите сертификат:

```bash
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx -d bot.aura-flower.shop
```

Nginx будет проксировать `https://bot.aura-flower.shop` → `http://localhost:3000`
(конфиг ниже).

### 3. Установить Node.js и код бота

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git

git clone https://github.com/nazarceva03q/aura-tsvetov.git
cd aura-tsvetov/bot
npm install --production
cp .env.example .env
nano .env   # заполнить (см. ниже)
```

Заполните `.env` на сервере:

```
MAX_BOT_TOKEN=f9LHodD0cOJzJYgI4HEDAEf-zn3AjYkpnMDGJpzc0rLQNi4w8nEuT2JRPcEnKeBFOtHoY2t2ffkpc5TdMsCF
MAX_OWNER_CHAT_ID=            # заполнить после шага 6
MAX_WEBHOOK_SECRET=придумайте-случайную-строку-без-пробелов
SITE_BASE_URL=https://aura-flower.shop
PORT=3000
PUBLIC_SERVER_URL=https://bot.aura-flower.shop
```

### 4. Nginx как обратный прокси

`/etc/nginx/sites-available/aura-bot`:

```nginx
server {
    listen 443 ssl;
    server_name bot.aura-flower.shop;
    # строки ssl_certificate добавит certbot сам

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/aura-bot /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 5. Запуск как службы (чтобы бот не падал при перезагрузке VM)

`/etc/systemd/system/aura-bot.service`:

```ini
[Unit]
Description=Aura Tsvetov Max Bot
After=network.target

[Service]
WorkingDirectory=/home/<ваш_пользователь>/aura-tsvetov/bot
ExecStart=/usr/bin/node server.js
Restart=always
User=<ваш_пользователь>

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now aura-bot
sudo systemctl status aura-bot   # должно быть "active (running)"
```

### 6. Узнать chat_id Олеси и зарегистрировать вебхук

1. Зарегистрируйте вебхук (один раз):
   ```bash
   npm run setup-webhook
   ```
   Скрипт проверит токен и скажет «Вебхук зарегистрирован».

2. Попросите Олесю открыть бота в Max по ссылке
   `https://max.ru/id560903131285_bot?start=setup` и нажать «Начать».

3. Посмотрите логи сервера:
   ```bash
   sudo journalctl -u aura-bot -f
   ```
   Там появится строка вида `[bot] bot_started: user_id=123456789`.
   Это и есть `MAX_OWNER_CHAT_ID`.

4. Впишите его в `.env` и перезапустите бота:
   ```bash
   nano .env   # MAX_OWNER_CHAT_ID=123456789
   sudo systemctl restart aura-bot
   ```

### 7. Сайт → бот

На сайте (`index.html`) есть константа:

```js
var MAX_LEAD_WEBHOOK_URL = 'https://ЗАМЕНИТЕ-НА-АДРЕС-БОТА.example/webhook/lead';
```

Замените на `https://bot.aura-flower.shop/webhook/lead`, опубликуйте сайт
заново — форма «Оставить заявку» начнёт слать заявки боту.

## Проверка после деплоя

- [ ] `curl https://bot.aura-flower.shop/health` → `{"ok":true,...}`
- [ ] Диплинк `https://max.ru/id560903131285_bot?start=test` открывает бота
      и сразу приходит приветствие с меню
- [ ] Кнопки категорий показывают товары с ценами и кнопкой «Хочу такой»
- [ ] «Хочу такой» → просит контакт/телефон → просит/подтверждает имя →
      приходит «Спасибо, …» и Олесе приходит карточка заявки
- [ ] «Заказать звонок» → просит телефон → приходит «Спасибо! Скоро
      перезвоним», Олесе приходит карточка без поля «Имя»
- [ ] «Задать вопрос» → текст вопроса уходит Олесе с кнопкой «Ответить» →
      после ответа Олеси автору вопроса приходит её ответ
- [ ] Повторная заявка с тем же телефоном добавляет в карточку пометку
      «Повторный заказ»
- [ ] На сайте кнопка «Оставить заявку» реально уходит в тот же чат
      (после того как в `index.html` прописан реальный `MAX_LEAD_WEBHOOK_URL`)

## Что уже проверено живыми запросами к Max Bot API

- `GET /me` — токен рабочий, бот `@id560903131285_bot`
- `POST /messages` с кнопками — формат тела запроса подтверждён
  (важно: у кнопок поле называется **`payload`**, а не `callback_data`,
  как было в изначальной сводке по документации — это выяснилось именно
  через живой запрос и уже исправлено в коде)
- Весь цикл диалога (меню → категория → заказ → звонок → вопрос → ответ)
  прогнан программно через `bot.handleUpdate()` — все шаги, сессии и
  карточки уведомлений собираются верно

## Известные ограничения (сознательно, не забыто)

- **Фото в карточках товаров бот пока не шлёт.** На сайте фото — это
  data-URI прямо в HTML, отдельных публичных ссылок на картинки нет.
  Карточки уже готовы принять `attachments` типа `image`, как только
  появится хостинг изображений (например, Yandex Object Storage) —
  правка на пару строк в `bot/src/bot.js`, функция `sendCategory`.
- **Точные названия полей `message_callback` и вложения `contact` не
  на 100% подтверждены документацией** (часть страниц API-справочника не
  открылась при подготовке кода) — разобраны защитно, с логированием
  необработанных апдейтов целиком. Поле `payload` у кнопок callback уже
  подтверждено живым запросом; если что-то ещё поведёт себя не так —
  смотрите `journalctl -u aura-bot -f`, там будет весь апдейт целиком,
  править нужно только `extract*()`-функции в начале `bot/src/bot.js`.
- **Каталог бота — отдельный файл** (`bot/src/catalog.js`), не читает
  сайт напрямую (сайт — статический HTML без API). Если меняете товары
  на сайте, продублируйте изменения там же.
