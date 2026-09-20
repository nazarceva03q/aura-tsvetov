// Все секреты и адреса — только из переменных окружения (.env локально,
// переменные окружения сервиса на проде). Ничего не хардкодим здесь.
// Своя загрузка .env вместо пакета dotenv – чтобы не тянуть лишнюю
// зависимость ради пяти строк парсинга KEY=VALUE.
const fs = require('fs');
const path = require('path');

(function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  });
})();

// user_id владелицы (MAX_OWNER_CHAT_ID) остаётся ЕДИНСТВЕННЫМ адресом, куда
// уходят заявки/вопросы покупателей (notify.js, bot.js forwardToOwner) —
// это не меняется. А вот доступ к МЕНЮ УПРАВЛЕНИЯ (admin.js — Добавить/
// Изменить/Удалить товар, Заявки) может быть у нескольких user_id сразу:
// MAX_OWNER_CHAT_ID всегда в их числе (её доступ ничего не отбирает), плюс
// через запятую можно перечислить ещё людей в MAX_ADMIN_CHAT_IDS — например,
// разработчика, который хочет проверить, что получилось, тем же меню, что
// видит владелица. Пусто в MAX_ADMIN_CHAT_IDS — доступ только у владелицы,
// как и раньше.
const ownerChatId = process.env.MAX_OWNER_CHAT_ID || '';
const extraAdminIds = (process.env.MAX_ADMIN_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const adminChatIds = Array.from(new Set([ownerChatId, ...extraAdminIds].filter(Boolean)));

const config = {
  botToken: process.env.MAX_BOT_TOKEN || '',
  ownerChatId,
  adminChatIds,
  webhookSecret: process.env.MAX_WEBHOOK_SECRET || '',
  siteBaseUrl: (process.env.SITE_BASE_URL || 'https://aura-flower.shop').replace(/\/$/, ''),
  port: parseInt(process.env.PORT, 10) || 3000,
  publicServerUrl: (process.env.PUBLIC_SERVER_URL || '').replace(/\/$/, ''),
  // Yandex Object Storage – постоянное хранилище сессий/клиентов/вопросов
  // на Cloud Functions (там нет постоянного диска между вызовами).
  // На VM-деплое эти переменные можно не задавать — store.js сам
  // переключается на локальные файлы, если YC_S3_BUCKET пуст (см. store.js).
  s3: {
    bucket: process.env.YC_S3_BUCKET || '',
    accessKey: process.env.YC_S3_ACCESS_KEY || '',
    secretKey: process.env.YC_S3_SECRET_KEY || ''
  },
  // Отдельный, ПУБЛИЧНЫЙ (открытый на чтение) бакет — каталог товаров
  // (catalog.json) и фото, загруженные владелицей через бота («Добавить
  // товар» / «Изменить товар»). Сайт (index.html) читает catalog.json
  // напрямую по HTTPS, без обращения к функции бота — см. bot/README.md,
  // раздел «Публичный бакет для каталога». Ключи доступа те же, что у
  // основного (приватного) бакета выше — один сервисный аккаунт может
  // писать в оба бакета, если у него есть роль storage.editor на них.
  s3Public: {
    bucket: process.env.YC_PUBLIC_S3_BUCKET || '',
    accessKey: process.env.YC_S3_ACCESS_KEY || '',
    secretKey: process.env.YC_S3_SECRET_KEY || ''
  }
};

if (!config.botToken) {
  console.warn('[config] MAX_BOT_TOKEN не задан — запросы к Max Bot API будут падать. Заполните bot/.env');
}
if (!config.ownerChatId) {
  console.warn('[config] MAX_OWNER_CHAT_ID не задан — уведомления Олесе отправляться не будут, пока вы не впишете её user_id в bot/.env (см. README.md)');
}
if (!config.s3.bucket) {
  console.warn('[config] YC_S3_BUCKET не задан — используется локальное файловое хранилище (bot/data/*.json). На Cloud Functions это НЕ будет работать между вызовами, см. README.md.');
}
if (!config.s3Public.bucket) {
  console.warn('[config] YC_PUBLIC_S3_BUCKET не задан — управление товарами через бота (добавить/изменить/удалить) работать не будет, см. README.md.');
}

module.exports = config;
