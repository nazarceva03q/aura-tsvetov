// Каталог товаров бота = каталог товаров сайта (index.html, var CATALOG).
// id совпадает с id в index.html – это и есть общая интеграция «товар сайта
// ↔ товар бота» (product_id, site_ref), про которую было в ТЗ.
//
// Если на сайте поменяется состав/цена товара, поправьте оба места –
// сайт (index.html) и этот файл. Полноценной синхронизации в одну сторону
// сейчас нет (сайт – статический HTML без API), это осознанное упрощение.

const SITE_BASE_URL = require('./config').siteBaseUrl;

// Токены фото товаров в Max (см. bot/scripts/sync-photos.js и
// bot/README.md, раздел «Фото товаров в боте»). Файл может отсутствовать
// (например, пока фото ещё не загружали) – тогда просто нет фото у карточек,
// без ошибки.
let PHOTO_TOKENS = {};
try {
  PHOTO_TOKENS = require('./photoTokens.json');
} catch (e) {
  // файла ещё нет – это нормально
}

const CATEGORIES = [
  { slug: 'bukety', name: 'Букеты', fromPrice: '900 ₽', emoji: '🌸' },
  {
    slug: 'poshtuchno',
    name: 'Цветы поштучно',
    fromPrice: '120 ₽',
    emoji: '🌷',
    note: 'Соберём букет по вашим пожеланиям из любого количества цветов'
  },
  { slug: 'kompozitsii', name: 'Цветочные композиции', fromPrice: '1000 ₽', emoji: '💐' }
];

const PRODUCTS = [
  { id: 'buket-1', category: 'bukety', name: 'Букет 1', price: '3000 ₽' },
  { id: 'buket-2', category: 'bukety', name: 'Букет 2', price: '2850 ₽' },
  { id: 'sbornyi-buket-3', category: 'bukety', name: 'Сборный букет 3', price: '3500 ₽' },
  { id: 'buket-gortenzii', category: 'bukety', name: 'Букет из гортензии', price: '1350 ₽' },

  { id: 'gortenziya-1', category: 'poshtuchno', name: 'Гортензия (голубая)', price: '700 ₽' },
  { id: 'gortenziya-2', category: 'poshtuchno', name: 'Гортензия (сиреневая)', price: '700 ₽' },
  { id: 'roza-ekvador', category: 'poshtuchno', name: 'Роза (Эквадор)', price: 'от 180 ₽' },

  { id: 'kompozitsiya-1', category: 'kompozitsii', name: 'Композиция 1', price: '1750 ₽' },
  { id: 'kompozitsiya-2', category: 'kompozitsii', name: 'Композиция 2', price: '2200 ₽' },
  { id: 'kompozitsiya-3', category: 'kompozitsii', name: 'Композиция 3', price: '2950 ₽' },
  { id: 'kompozitsiya-4', category: 'kompozitsii', name: 'Композиция 4', price: '1500 ₽' },
  { id: 'kompozitsiya-5', category: 'kompozitsii', name: 'Композиция 5', price: '1850 ₽' },
  { id: 'kompozitsiya-6', category: 'kompozitsii', name: 'Композиция 6', price: '2400 ₽' },
  { id: 'kompozitsiya-7', category: 'kompozitsii', name: 'Композиция 7', price: '1750 ₽' },
  { id: 'kompozitsiya-8', category: 'kompozitsii', name: 'Композиция 8', price: '3200 ₽' },
  { id: 'kompozitsiya-9', category: 'kompozitsii', name: 'Композиция 9', price: '2500 ₽' },
  { id: 'kompozitsiya-10', category: 'kompozitsii', name: 'Композиция 10', price: '2360 ₽' }
];

// NB: в bot-названиях двух гортензий добавлены уточнения «(голубая)» /
// «(сиреневая)» – на сайте обе карточки называются просто «Гортензия»
// (разные фото), в чате бота это неотличимо без уточнения, поэтому здесь
// названия чуть отличаются от сайта. Если на сайте тоже переименуете –
// поправьте и здесь для единообразия.

function withPhotoToken(product) {
  if (!product) return product;
  return Object.assign({}, product, { photoToken: PHOTO_TOKENS[product.id] || null });
}

function getCategoryBySlug(slug) {
  return CATEGORIES.find((c) => c.slug === slug) || null;
}

function getProductsByCategory(slug) {
  return PRODUCTS.filter((p) => p.category === slug).map(withPhotoToken);
}

function getProductById(id) {
  return withPhotoToken(PRODUCTS.find((p) => p.id === id) || null);
}

function siteRefFor(product) {
  if (!product) return '';
  return SITE_BASE_URL + '/#category=' + product.category + '&product=' + product.id;
}

module.exports = {
  CATEGORIES,
  PRODUCTS,
  getCategoryBySlug,
  getProductsByCategory,
  getProductById,
  siteRefFor
};
