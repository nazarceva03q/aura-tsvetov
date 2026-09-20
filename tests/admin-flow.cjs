// Проверка нового сценария управления каталогом из бота (bot/src/products.js,
// bot/src/admin.js) – тем же способом, что и остальные тесты в этом
// проекте: реальные модули через vm.runInNewContext с явно подставленными
// зависимостями (без сети, без настоящего Object Storage). Мок
// объектного хранилища держит данные в памяти процесса — как в
// tests/order-flow.cjs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function load(file, dependencies) {
  const sandbox = {
    module: { exports: {} }, __dirname: path.dirname(path.join(root, file)),
    require(name) { if (name === 'crypto') return require('node:crypto'); if (!(name in dependencies)) throw Error('Unexpected dependency: ' + name); return dependencies[name]; },
    console: { log() {}, warn() {}, error(...args) { throw Error(args.join(' ')); } },
    Buffer, setTimeout, clearTimeout
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
  return sandbox.module.exports;
}

const config = { siteBaseUrl: 'https://aura-flower.shop', ownerChatId: '999', s3Public: { bucket: 'pub-test', accessKey: 'k', secretKey: 's' } };

// – Объектное хранилище в памяти: и JSON (catalog.json), и бинарные файлы
// (фото) – достаточно для проверки products.js без реального Yandex Cloud –
function makeObjectStorage() {
  const jsonObjects = {};
  const binaryObjects = {};
  return {
    store: { jsonObjects, binaryObjects },
    api: {
      getJson: async (cfg, key, fallback) => (key in jsonObjects ? JSON.parse(JSON.stringify(jsonObjects[key])) : fallback),
      putJson: async (cfg, key, data) => { jsonObjects[key] = JSON.parse(JSON.stringify(data)); return true; },
      putObject: async (cfg, key, buffer, contentType) => { binaryObjects[key] = { buffer, contentType }; return true; },
      publicUrl: (cfg, key) => 'https://storage.yandexcloud.net/' + cfg.bucket + '/' + key
    }
  };
}

function loadProducts(objectStorageApi) {
  return load('bot/src/products.js', { './config': config, './objectStorage': objectStorageApi, crypto: require('node:crypto') });
}

test('saveProduct creates a new product with a generated id, matching the site CATALOG shape', async () => {
  const { api } = makeObjectStorage();
  const products = loadProducts(api);
  const product = await products.saveProduct('Букеты', null, {
    name: 'Малиновый закат', price: '4900 ₽', composition: ['Роза – 5 шт.', 'Эвкалипт – 2 ветки'], photos: ['https://storage.yandexcloud.net/pub-test/products/1.jpg']
  });
  assert.equal(product.id, 'malinovyy-zakat');
  assert.equal(product.name, 'Малиновый закат');
  assert.equal(product.price, '4900 ₽');
  assert.deepEqual(product.composition, ['Роза – 5 шт.', 'Эвкалипт – 2 ветки']);
  assert.equal(product.photo, 'https://storage.yandexcloud.net/pub-test/products/1.jpg');
  assert.equal(product.photos, undefined);

  const catalog = await products.getCatalog();
  assert.equal(catalog['Букеты'].length, 1);
  // products.js работает в отдельном vm-контексте (см. load() выше) —
  // Array.from() нормализует его массив к реалму этого тестового файла,
  // иначе deepEqual считает структурно одинаковые, но кросс-реалмовые
  // массивы не равными.
  assert.deepEqual(Object.keys(catalog), Array.from(products.CATEGORY_NAMES));
});

test('saveProduct with an empty composition (dash) matches the "no composition" shape used across the site', async () => {
  const { api } = makeObjectStorage();
  const products = loadProducts(api);
  const product = await products.saveProduct('Цветы поштучно', null, { name: 'Тюльпан', price: 'от 90 ₽', composition: [], photos: ['https://x/1.jpg'] });
  assert.deepEqual(product.composition, []);
});

test('saveProduct assigns a unique id when the slug collides with an existing product', async () => {
  const { api } = makeObjectStorage();
  const products = loadProducts(api);
  await products.saveProduct('Букеты', null, { name: 'Роза', price: '100 ₽', composition: [], photos: ['https://x/1.jpg'] });
  const second = await products.saveProduct('Букеты', null, { name: 'Роза', price: '150 ₽', composition: [], photos: ['https://x/2.jpg'] });
  assert.equal(second.id, 'roza-2');
});

test('saveProduct on an existing id moves the product between categories instead of duplicating it', async () => {
  const { api } = makeObjectStorage();
  const products = loadProducts(api);
  const created = await products.saveProduct('Букеты', null, { name: 'Тестовый букет', price: '1000 ₽', composition: [], photos: ['https://x/1.jpg'] });
  await products.saveProduct('Цветочные композиции', created.id, { name: 'Тестовый букет', price: '1200 ₽', composition: ['Пункт'], photos: ['https://x/1.jpg', 'https://x/2.jpg'] });

  const catalog = await products.getCatalog();
  assert.equal(catalog['Букеты'].length, 0);
  assert.equal(catalog['Цветочные композиции'].length, 1);
  const moved = catalog['Цветочные композиции'][0];
  assert.equal(moved.id, created.id);
  assert.equal(moved.price, '1200 ₽');
  assert.deepEqual(moved.photos, ['https://x/1.jpg', 'https://x/2.jpg']);
  assert.equal(moved.photo, undefined);
});

test('deleteProductById removes the product from whichever category holds it', async () => {
  const { api } = makeObjectStorage();
  const products = loadProducts(api);
  const created = await products.saveProduct('Цветы поштучно', null, { name: 'Гвоздика тест', price: '120 ₽', composition: [], photos: ['https://x/1.jpg'] });
  assert.equal(await products.deleteProductById(created.id), true);
  assert.equal(await products.getProductById(created.id), null);
  assert.equal(await products.deleteProductById('not-a-real-id'), false);
});

test('searchByName finds a product by partial, case-insensitive, unpunctuated input', async () => {
  const { api } = makeObjectStorage();
  const products = loadProducts(api);
  await products.saveProduct('Букеты', null, { name: 'Букет из розовой гортензии', price: '1500 ₽', composition: [], photos: ['https://x/1.jpg'] });
  await products.saveProduct('Цветочные композиции', null, { name: 'Композиция с лилиями', price: '2000 ₽', composition: [], photos: ['https://x/2.jpg'] });

  const results = await products.searchByName('гортензия');
  assert.ok(results.length >= 1);
  assert.equal(results[0].product.name, 'Букет из розовой гортензии');
  assert.equal(results[0].category, 'Букеты');

  assert.equal((await products.searchByName('совсем не тот запрос xyz')).length, 0);
});

test('uploadPhoto stores bytes under the public bucket and returns a stable public URL', async () => {
  const { api, store } = makeObjectStorage();
  const products = loadProducts(api);
  const url = await products.uploadPhoto(Buffer.from('fake-image-bytes'), 'image/png');
  assert.match(url, /^https:\/\/storage\.yandexcloud\.net\/pub-test\/products\/.+\.png$/);
  const key = url.split('/pub-test/')[1];
  assert.equal(store.binaryObjects[key].buffer.toString(), 'fake-image-bytes');
});

// – Полный сценарий «Добавить товар» через bot.handleUpdate, от нажатия
// кнопки меню до появления товара в catalog.json – проверяет, что admin.js
// и products.js действительно работают вместе, а не только по отдельности.

function makeAdminEnv() {
  const sessions = {};
  const owner = [];
  const { api: objectStorageApi } = makeObjectStorage();
  const products = load('bot/src/products.js', { './config': config, './objectStorage': objectStorageApi, crypto: require('node:crypto') });
  const downloadedUrls = [];
  const maxApi = {
    sendMessage: async (target, text, rows) => { owner.push({ text, rows }); return { ok: true }; },
    sendPhotoUrlMessage: async (target, text, rows, photoUrl) => { owner.push({ text, rows, photoUrl }); return { ok: true }; },
    downloadBinary: async (url) => { downloadedUrls.push(url); return { buffer: Buffer.from('bytes-for-' + url), contentType: 'image/jpeg' }; },
    callbackButton: (text, payload) => ({ type: 'callback', text, payload })
  };
  const store = {
    getSession: async (id) => sessions[id] || { step: 'idle' },
    setSession: async (id, value) => { sessions[id] = value; },
    clearSession: async (id) => { delete sessions[id]; },
    getLeadsPage: async () => ({ items: [], total: 0 })
  };
  const admin = load('bot/src/admin.js', { './config': config, './maxApi': maxApi, './store': store, './products': products, crypto: require('node:crypto') });
  return { admin, sessions, owner, products, downloadedUrls };
}

test('full "add product" flow through admin.js publishes a product with the same shape as the rest of the site catalog', async () => {
  const env = makeAdminEnv();
  const userId = '999';

  await env.admin.sendMenu(userId);
  assert.match(env.owner.at(-1).text, /Выберите действие/);

  assert.equal(await env.admin.handleCallback(userId, env.sessions[userId], 'admin:add'), true);
  assert.match(env.owner.at(-1).text, /Выберите категорию/);

  assert.equal(await env.admin.handleCallback(userId, env.sessions[userId], 'add:cat:0'), true);
  assert.equal(env.sessions[userId].draft.category, 'Букеты');
  assert.match(env.owner.at(-1).text, /название товара/);

  await env.admin.handleMessage({ message: { body: { text: 'Малиновый закат' } } }, userId, env.sessions[userId]);
  assert.match(env.owner.at(-1).text, /цену/);

  await env.admin.handleMessage({ message: { body: { text: '4900' } } }, userId, env.sessions[userId]);
  assert.equal(env.sessions[userId].draft.price, '4900 ₽');

  await env.admin.handleMessage({ message: { body: { text: '- Роза – 5 шт.\n- Эвкалипт – 2 ветки' } } }, userId, env.sessions[userId]);
  assert.deepEqual(Array.from(env.sessions[userId].draft.composition), ['Роза – 5 шт.', 'Эвкалипт – 2 ветки']);
  const photoPrompt = env.owner.at(-1);
  assert.match(photoPrompt.text, /фото/);
  // Пока фото ни одного нет – кнопки «Готово» быть не должно, только «В меню».
  assert.equal(photoPrompt.rows.length, 1);
  assert.equal(photoPrompt.rows[0][0].payload, 'admin:menu');

  // Одно сообщение с двумя фото сразу (альбом) – оба должны попасть в черновик.
  await env.admin.handleMessage({
    message: { body: { attachments: [{ type: 'image', payload: { url: 'https://max.example/photo1.jpg' } }, { type: 'image', payload: { url: 'https://max.example/photo2.jpg' } }] } }
  }, userId, env.sessions[userId]);
  assert.equal(env.sessions[userId].draft.photos.length, 2);
  assert.equal(env.downloadedUrls.length, 2);
  // Теперь, когда фото уже есть, «Готово» должна появиться.
  const afterPhotos = env.owner.at(-1);
  assert.equal(afterPhotos.rows[0][0].payload, 'photos:done');
  assert.equal(afterPhotos.rows[1][0].payload, 'admin:menu');

  assert.equal(await env.admin.handleCallback(userId, env.sessions[userId], 'photos:done'), true);
  assert.equal(env.sessions[userId].step, 'admin_preview');
  const preview = env.owner.at(-1);
  assert.match(preview.text, /Малиновый закат/);
  assert.match(preview.text, /4900 ₽/);
  assert.match(preview.text, /Роза – 5 шт\./);

  assert.equal(await env.admin.handleCallback(userId, env.sessions[userId], 'preview:save'), true);
  assert.match(env.owner.at(-1).text, /опубликован на сайте/);
  assert.equal(env.sessions[userId].step, 'admin_idle');

  const catalog = await env.products.getCatalog();
  assert.equal(catalog['Букеты'].length, 1);
  const saved = catalog['Букеты'][0];
  assert.equal(saved.name, 'Малиновый закат');
  assert.equal(saved.price, '4900 ₽');
  assert.deepEqual(Array.from(saved.composition), ['Роза – 5 шт.', 'Эвкалипт – 2 ветки']);
  assert.equal(saved.photos.length, 2);
  assert.ok(saved.photos[0].startsWith('https://storage.yandexcloud.net/pub-test/products/'));
});

test('the menu has an explicit Start button, and each search result has a "back to menu" button under "Этот товар"', async () => {
  const env = makeAdminEnv();
  const userId = '999';

  await env.admin.sendMenu(userId);
  const menu = env.owner.at(-1);
  assert.ok(menu.rows.some((row) => row[0].payload === 'admin:menu' && /Старт/.test(row[0].text)));

  await env.products.saveProduct('Букеты', null, { name: 'Тюльпан красный', price: '300 ₽', composition: [], photos: ['https://x/1.jpg'] });
  await env.admin.handleCallback(userId, env.sessions[userId], 'admin:edit');
  await env.admin.handleMessage({ message: { body: { text: 'тюльпан' } } }, userId, env.sessions[userId]);
  const match = env.owner.at(-1);
  assert.equal(match.rows.length, 2);
  assert.equal(match.rows[0][0].payload, 'find:pick:0');
  assert.equal(match.rows[1][0].payload, 'admin:menu');
});

test('stale buttons from a finished flow (no draft in the current session) prompt to restart instead of crashing', async () => {
  const env = makeAdminEnv();
  const userId = '999';
  // Меню сброшено (например, товар уже сохранён и добавлен новый диалог) —
  // Max не убирает кнопки из старых сообщений, поэтому Олеся технически
  // может нажать «✏️ Название»/«Готово»/«Сохранить» под давно закрытым
  // товаром. Раньше это падало (session.draft.* от undefined).
  await env.admin.sendMenu(userId);
  assert.equal(env.sessions[userId].step, 'admin_idle');

  for (const staleData of ['add:cat:0', 'edit:field:name', 'photos:done', 'photos:add', 'photos:back', 'photos:remove:0', 'preview:save']) {
    env.owner.length = 0;
    const handled = await env.admin.handleCallback(userId, env.sessions[userId], staleData);
    assert.equal(handled, true, staleData);
    assert.match(env.owner.at(-1).text, /устарела/, staleData);
    assert.equal(env.sessions[userId].step, 'admin_idle', staleData);
  }
});

test('"delete product" flow finds a fuzzy match and removes it after confirmation', async () => {
  const env = makeAdminEnv();
  const userId = '999';
  await env.products.saveProduct('Цветы поштучно', null, { name: 'Гортензия голубая', price: '700 ₽', composition: [], photos: ['https://x/1.jpg'] });

  await env.admin.sendMenu(userId);
  await env.admin.handleCallback(userId, env.sessions[userId], 'admin:delete');
  await env.admin.handleMessage({ message: { body: { text: 'гортензия' } } }, userId, env.sessions[userId]);
  assert.ok(env.owner.some((m) => m.rows && m.rows[0][0].payload === 'find:pick:0'));

  await env.admin.handleCallback(userId, env.sessions[userId], 'find:pick:0');
  assert.match(env.owner.at(-1).text, /Удалить товар «Гортензия голубая»\?/);

  await env.admin.handleCallback(userId, env.sessions[userId], 'delete:confirm:yes');
  assert.match(env.owner.at(-1).text, /удалён/);

  const catalog = await env.products.getCatalog();
  assert.equal(catalog['Цветы поштучно'].length, 0);
});
