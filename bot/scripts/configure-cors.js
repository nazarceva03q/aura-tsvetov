// Разовый скрипт: включает CORS (чтение из браузера с другого домена) на
// публичном бакете каталога (YC_PUBLIC_S3_BUCKET). Без этого сам файл
// catalog.json прекрасно открывается прямой ссылкой в браузере или curl —
// но JS-код сайта (fetch() из index.html) браузер молча блокирует, потому
// что сайт (aura-flower.shop) и бакет (storage.yandexcloud.net) — разные
// домены, а CORS-заголовков без этой настройки бакет не отдаёт.
//
// Запуск (один раз, из bot/, с заполненным .env):
//   node scripts/configure-cors.js
//
// Безопасно запускать повторно — просто переустанавливает то же правило.
// Разрешает GET/HEAD с ЛЮБОГО домена (AllowedOrigin: *) — это нормально
// для бакета с исключительно публичными данными (каталог товаров и их
// фото, ничего приватного), которые и так открыты на чтение всем.

const config = require('../src/config');
const objectStorage = require('../src/objectStorage');

const CORS_XML =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<CORSConfiguration>' +
  '<CORSRule>' +
  '<AllowedOrigin>*</AllowedOrigin>' +
  '<AllowedMethod>GET</AllowedMethod>' +
  '<AllowedMethod>HEAD</AllowedMethod>' +
  '<AllowedHeader>*</AllowedHeader>' +
  '<MaxAgeSeconds>3600</MaxAgeSeconds>' +
  '</CORSRule>' +
  '</CORSConfiguration>';

async function main() {
  if (!config.s3Public.bucket || !config.s3Public.accessKey || !config.s3Public.secretKey) {
    console.error('YC_PUBLIC_S3_BUCKET / YC_S3_ACCESS_KEY / YC_S3_SECRET_KEY не заполнены в bot/.env.');
    process.exit(1);
  }
  const ok = await objectStorage.putBucketCors(config.s3Public, CORS_XML);
  if (!ok) {
    console.error('Не удалось настроить CORS — см. ошибку выше.');
    process.exit(1);
  }
  console.log('Готово: CORS настроен для бакета ' + config.s3Public.bucket + '.');
}

main().catch((e) => { console.error(e); process.exit(1); });
