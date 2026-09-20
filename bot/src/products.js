// Динамический каталог товаров сайта — то, что раньше было зашито только
// в index.html (var CATALOG), теперь можно менять из бота Max (владелица):
// добавлять/редактировать/удалять товары без правок кода и коммитов в
// GitHub. Хранится ОДНИМ JSON-файлом catalog.json в ПУБЛИЧНОМ бакете
// Yandex Object Storage (bot/README.md, раздел «Публичный бакет для
// каталога») — сайт читает его напрямую по обычной HTTPS-ссылке, без
// обращения к функции бота вообще (быстрее и бесплатнее, чем дёргать
// Cloud Function на каждое открытие сайта).
//
// Форма данных совпадает 1-в-1 с var CATALOG в index.html:
//   { 'Букеты': [ {id, name, price, composition, photo|photos}, ... ],
//     'Цветочные композиции': [...], 'Цветы поштучно': [...] }
// Это специально: index.html подставляет этот объект в тот же renderCatalog(),
// которым уже рисует статичные товары — значит, дизайн карточки не может
// «поехать» (шрифты/размеры/кнопки/стрелки — тот же код, что и всегда).
//
// id товара уникален по всему каталогу (across категорий) — это упрощает
// поиск/удаление/перенос товара между категориями (см. saveProduct ниже).

const crypto = require('crypto');
const config = require('./config');
const objectStorage = require('./objectStorage');

const CATALOG_KEY = 'catalog.json';

// Порядок и названия — как в index.html (CATEGORY_SLUGS) и в старом
// bot/src/catalog.js. Порядок важен: именно в этом порядке бот показывает
// кнопки выбора категории при добавлении товара («Букеты», «Цветочные
// композиции», «Цветы поштучно»).
const CATEGORIES = [
  { name: 'Букеты', slug: 'bukety' },
  { name: 'Цветочные композиции', slug: 'kompozitsii' },
  { name: 'Цветы поштучно', slug: 'poshtuchno' }
];
const CATEGORY_NAMES = CATEGORIES.map((c) => c.name);

function emptyCatalog() {
  const catalog = {};
  CATEGORY_NAMES.forEach((name) => { catalog[name] = []; });
  return catalog;
}

async function getCatalog() {
  const data = await objectStorage.getJson(config.s3Public, CATALOG_KEY, null);
  const catalog = emptyCatalog();
  if (data && typeof data === 'object') {
    CATEGORY_NAMES.forEach((name) => { if (Array.isArray(data[name])) catalog[name] = data[name]; });
  }
  return catalog;
}

async function saveCatalog(catalog) {
  return objectStorage.putJson(config.s3Public, CATALOG_KEY, catalog);
}

// – транслитерация для id нового товара (та же схема, что уже используется
// в id существующих товаров сайта, напр. buket-rozovoy-gortenzii) –
const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya'
};

function slugify(text) {
  const transliterated = String(text)
    .toLowerCase()
    .split('')
    .map((ch) => (TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch))
    .join('');
  const slug = transliterated.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'tovar';
}

function allIds(catalog) {
  const ids = new Set();
  CATEGORY_NAMES.forEach((name) => catalog[name].forEach((p) => ids.add(p.id)));
  return ids;
}

function generateId(catalog, name) {
  const base = slugify(name);
  const ids = allIds(catalog);
  if (!ids.has(base)) return base;
  let n = 2;
  while (ids.has(base + '-' + n)) n += 1;
  return base + '-' + n;
}

function findById(catalog, id) {
  for (const name of CATEGORY_NAMES) {
    const item = catalog[name].find((p) => p.id === id);
    if (item) return { category: name, product: item };
  }
  return null;
}

async function getProductById(id) {
  if (!id) return null;
  const catalog = await getCatalog();
  const found = findById(catalog, id);
  return found ? found.product : null;
}

// Создаёт товар (id === null) ИЛИ полностью заменяет существующий по id —
// в том числе переносит его в другую категорию, если category изменилась
// (сначала удаляется из старой категории, затем кладётся в новую). Именно
// этой функцией пользуются и «Добавить товар», и «Изменить товар» в
// bot/src/admin.js — редактирование одного и того же товара переиспользует
// весь код предпросмотра/сохранения, что и добавление нового.
async function saveProduct(category, id, fields) {
  if (!CATEGORY_NAMES.includes(category)) throw new Error('Неизвестная категория: ' + category);
  const catalog = await getCatalog();

  let existing = null;
  if (id) {
    CATEGORY_NAMES.forEach((name) => {
      const idx = catalog[name].findIndex((p) => p.id === id);
      if (idx !== -1) {
        existing = catalog[name][idx];
        catalog[name].splice(idx, 1);
      }
    });
  }

  const finalId = id || generateId(catalog, fields.name);
  const product = Object.assign({}, existing, {
    id: finalId,
    name: fields.name,
    price: fields.price,
    composition: Array.isArray(fields.composition) ? fields.composition : []
  });
  delete product.photo;
  delete product.photos;
  const photos = (fields.photos || []).filter(Boolean);
  if (photos.length > 1) product.photos = photos;
  else if (photos.length === 1) product.photo = photos[0];

  catalog[category].push(product);
  await saveCatalog(catalog);
  return product;
}

async function deleteProductById(id) {
  const catalog = await getCatalog();
  let found = false;
  CATEGORY_NAMES.forEach((name) => {
    const idx = catalog[name].findIndex((p) => p.id === id);
    if (idx !== -1) {
      catalog[name].splice(idx, 1);
      found = true;
    }
  });
  if (found) await saveCatalog(catalog);
  return found;
}

// – нечёткий поиск по названию, для «Изменить товар» / «Удалить товар» –
// владелица может написать название неточно (без падежа, с опечаткой,
// частично) — ищем и по точному вхождению, и по пересечению слов.
function normalizeForSearch(text) {
  return String(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .trim();
}

// Сравнение по общему началу слова, а не по полному вхождению — русские
// названия товаров легко не совпадают по падежу/окончанию с тем, как
// владелица напишет запрос («гортензия» ищем, а в названии «гортензии»,
// «розовой гортензии» и т.п.) простое indexOf() такие случаи не находит.
function wordsMatch(a, b) {
  if (!a || !b) return false;
  // Короткие слова (предлоги вроде «с», «из», «по») сравниваем только по
  // точному совпадению — иначе, например, «с» по общему префиксу
  // совпадало бы с любым словом запроса, начинающимся на «с».
  if (a.length < 3 || b.length < 3) return a === b;
  const minShare = Math.min(4, a.length, b.length);
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
  return shared >= minShare;
}

async function searchByName(query, limit) {
  const catalog = await getCatalog();
  const q = normalizeForSearch(query);
  const qWords = q.split(' ').filter(Boolean);
  const results = [];

  CATEGORY_NAMES.forEach((category) => {
    catalog[category].forEach((product) => {
      const name = normalizeForSearch(product.name);
      let score = 0;
      if (name === q) score = 100;
      else if (q && name.indexOf(q) !== -1) score = 80;
      else {
        const nameWords = name.split(' ').filter(Boolean);
        qWords.forEach((w) => {
          if (nameWords.some((nw) => wordsMatch(nw, w))) score += 20;
        });
      }
      if (score > 0) results.push({ category, product, score });
    });
  });

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit || 5);
}

// Загружает фото товара (байты, полученные из чата Max — см. bot/src/admin.js)
// в публичный бакет и возвращает его постоянную HTTPS-ссылку, либо null,
// если загрузка не удалась (см. objectStorage.putObject — там же лог причины).
async function uploadPhoto(buffer, contentType) {
  const ext = contentType && contentType.indexOf('png') !== -1 ? 'png' : 'jpg';
  const key = 'products/' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
  const ok = await objectStorage.putObject(config.s3Public, key, buffer, contentType || 'image/jpeg');
  if (!ok) return null;
  return objectStorage.publicUrl(config.s3Public, key);
}

module.exports = {
  CATEGORIES,
  CATEGORY_NAMES,
  getCatalog,
  saveProduct,
  deleteProductById,
  getProductById,
  searchByName,
  uploadPhoto
};
