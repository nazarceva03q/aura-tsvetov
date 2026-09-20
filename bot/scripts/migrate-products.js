// Разовый скрипт: копирует уже существующие товары сайта (index.html,
// var CATALOG) в catalog.json в ПУБЛИЧНОМ бакете Yandex Object Storage —
// после этого те же товары можно менять через бота («Изменить товар» /
// «Удалить товар»), а не только правкой кода сайта.
//
// Фото НЕ перезаливаются в Object Storage — сайт и так отдаёт их по адресу
// https://aura-flower.shop/products/*.webp (GitHub Pages), поэтому
// catalog.json просто ссылается на те же файлы абсолютными ссылками, и
// renderCatalog() на сайте показывает их как обычно. Только НОВЫЕ фото,
// которые владелица пришлёт через бота при добавлении/изменении товара,
// реально загружаются в Object Storage (см. bot/src/admin.js).
//
// Запуск (один раз, из bot/, с заполненным .env — см. bot/README.md,
// раздел «Публичный бакет для каталога»):
//   cd bot
//   node scripts/migrate-products.js
//
// Безопасно запускать повторно: товар с существующим id просто
// перезаписывается тем же содержимым (bot/src/products.js, saveProduct).
// ВАЖНО: не запускайте это ПОСЛЕ того, как через бота уже
// добавили/изменили/удалили какие-то из этих 25 товаров — миграция берёт
// данные из index.html (текущий код сайта), а не из уже накопленного
// catalog.json, и вернула бы обратно то, что вы успели удалить через бота.
// Она нужна только один раз, для самого первого переноса.

const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const products = require('../src/products');
const objectStorage = require('../src/objectStorage');

const INDEX_HTML = path.join(__dirname, '..', '..', 'index.html');
const SITE_BASE_URL = 'https://aura-flower.shop';

function loadStaticCatalog() {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const match = html.match(/var CATALOG = (\{[\s\S]*?\n {2}\});/);
  if (!match) throw new Error('Не нашла "var CATALOG = {...}" в index.html — возможно, разметка сайта изменилась.');
  // eslint-disable-next-line no-new-func
  return new Function('return (' + match[1] + ');')();
}

function toAbsolute(photoPath) {
  if (!photoPath) return photoPath;
  return photoPath.indexOf('http') === 0 ? photoPath : SITE_BASE_URL + photoPath;
}

async function main() {
  if (!config.s3Public.bucket || !config.s3Public.accessKey || !config.s3Public.secretKey) {
    console.error(
      'YC_PUBLIC_S3_BUCKET / YC_S3_ACCESS_KEY / YC_S3_SECRET_KEY не заполнены в bot/.env — ' +
        'сначала создайте публичный бакет и впишите значения, см. bot/README.md, раздел ' +
        '«Публичный бакет для каталога».'
    );
    process.exit(1);
  }

  const staticCatalog = loadStaticCatalog();
  let migrated = 0;

  for (const category of Object.keys(staticCatalog)) {
    for (const item of staticCatalog[category]) {
      const photos = item.photos
        ? item.photos.map(toAbsolute)
        : (item.photo ? [toAbsolute(item.photo)] : []);
      await products.saveProduct(category, item.id, {
        name: item.name,
        price: item.price,
        composition: item.composition || [],
        photos
      });
      migrated += 1;
      process.stdout.write('.');
    }
  }

  console.log('\nГотово: перенесено товаров — ' + migrated + '.');
  console.log('Проверить файл: ' + objectStorage.publicUrl(config.s3Public, 'catalog.json'));
  console.log('Дальше: впишите этот же адрес в business.js (поле catalogUrl), опубликуйте сайт заново и обновите страницу (Ctrl+F5).');
}

main().catch((e) => {
  console.error('Ошибка миграции:', e);
  process.exit(1);
});
