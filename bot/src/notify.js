// Единая точка формирования и отправки карточки заявки Олесе – используется
// и ботом (все ветки меню), и вебхуком с сайта (/webhook/lead), поэтому
// логика проверки повторного клиента и текст карточки не дублируются.

const config = require('./config');
const store = require('./store');
const maxApi = require('./maxApi');
const catalog = require('./catalog');
const products = require('./products');

function normalizePhone(rawPhone) {
  let digits = String(rawPhone || '').replace(/\D/g, '');
  if (digits[0] === '8') digits = '7' + digits.slice(1);
  if (digits[0] !== '7') digits = '7' + digits;
  return digits.slice(0, 11);
}

function formatPhone(digits) {
  if (digits.length !== 11) return digits;
  return '+7 (' + digits.slice(1, 4) + ') ' + digits.slice(4, 7) + '-' + digits.slice(7, 9) + '-' + digits.slice(9, 11);
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return iso;
  }
}

// Ищет товар сначала в динамическом каталоге (bot/src/products.js — товары,
// добавленные/изменённые через бота, а после миграции — вообще все товары
// сайта, см. bot/scripts/migrate-products.js), и только если там не нашлось
// (например, миграция ещё не запускалась) — в старом статическом
// bot/src/catalog.js. Так цена в карточке заявки всегда берётся из
// проверенного каталога, а не из того, что прислал браузер клиента (это
// сознательно — client-side цену в карточке никогда не используем).
async function lookupProduct(productId) {
  if (!productId) return null;
  try {
    const dynamic = await products.getProductById(productId);
    if (dynamic) return dynamic;
  } catch (e) {
    console.error('[notify] products.getProductById упал, использую статический каталог:', e.message);
  }
  return catalog.getProductById(productId);
}

// data: { source, name, phone, productId, productName, siteRef, photoRef, interestedIn, comment }
// всё, кроме source/phone, – опционально. product – результат lookupProduct
// (необязателен – если не передан, buildCard сам его найдёт; так функция
// остаётся удобной для тестов/отладки, вызывающих buildCard напрямую).
async function buildCard(data, repeatInfo, product) {
  const lines = ['🔔 НОВАЯ ЗАЯВКА'];
  lines.push('Источник: ' + (data.source || 'Общая заявка'));
  if (data.name) lines.push('Имя: ' + data.name);
  lines.push('Телефон: ' + formatPhone(normalizePhone(data.phone)));
  if (data.productName) lines.push('Товар: ' + data.productName);
  const resolvedProduct = product !== undefined ? product : (data.productId ? await lookupProduct(data.productId) : null);
  if (resolvedProduct) lines.push('Цена: ' + resolvedProduct.price);
  if (data.imageUrl && /^https:\/\/aura-flower\.shop\/products\/[a-z0-9-]+\.webp$/.test(data.imageUrl)) lines.push('Фото товара: ' + data.imageUrl);
  // Ссылку на сайт оставляем всегда – даже когда фото уже прикреплено к
  // сообщению, ссылка полезна, чтобы открыть карточку товара на сайте целиком.
  if (data.siteRef) lines.push('🔗 Ссылка на сайте: ' + data.siteRef);
  if (data.interestedIn) lines.push('Интересовало: ' + data.interestedIn);
  if (data.comment) lines.push('Комментарий: ' + data.comment);
  if (data.phone) {
    lines.push(
      repeatInfo && repeatInfo.isRepeat
        ? '👤 Повторный заказ (первое обращение: ' + formatDate(repeatInfo.firstSeen) + ')'
        : '🆕 Первый заказ'
    );
  }
  lines.push('Время: ' + formatDate(new Date().toISOString()));
  return lines.join('\n\n');
}

// Возвращает { ok, text } – text полезен для логов/отладки даже если
// MAX_OWNER_CHAT_ID ещё не настроен (тогда отправка просто не произойдёт).
async function sendLeadNotification(data) {
  const phoneDigits = normalizePhone(data.phone);
  const repeatInfo = data.phone ? await store.checkAndRecordCustomer(phoneDigits) : { isRepeat: false, firstSeen: null };

  const product = data.productId ? await lookupProduct(data.productId) : null;
  const text = await buildCard(data, repeatInfo, product);

  // Фото товара вместо голой ссылки. Два источника, по приоритету:
  //  1) photoToken – товар из старого статического каталога, фото которого
  //     заранее загружено в Max (scripts/sync-photos.js);
  //  2) URL фото из динамического каталога (products.js) – товар добавлен
  //     или изменён через бота, отдельного токена для него нет, фото лежит
  //     в Object Storage и отправляется по прямой ссылке (см. предупреждение
  //     в maxApi.sendPhotoUrlMessage про неподтверждённый формат).
  const staticProduct = data.productId ? catalog.getProductById(data.productId) : null;
  const photoToken = staticProduct ? staticProduct.photoToken : null;
  const dynamicPhotoUrl = !photoToken && product ? (product.photo || (product.photos && product.photos[0]) || null) : null;

  await store.saveLead({
    kind: 'order',
    source: data.source || 'Общая заявка',
    name: data.name || '',
    phone: formatPhone(phoneDigits),
    productName: data.productName || '',
    siteRef: data.siteRef || '',
    isRepeat: Boolean(repeatInfo && repeatInfo.isRepeat)
  });

  if (!config.ownerChatId) {
    console.warn('[notify] MAX_OWNER_CHAT_ID не настроен, карточка не отправлена:\n' + text);
    return { ok: false, text, repeatInfo };
  }

  let result;
  if (dynamicPhotoUrl) {
    result = await maxApi.sendPhotoUrlMessage({ userId: config.ownerChatId }, text, null, dynamicPhotoUrl);
    if (!result.ok) result = await maxApi.sendMessage({ userId: config.ownerChatId }, text);
  } else {
    result = await maxApi.sendMessage({ userId: config.ownerChatId }, text, null, photoToken);
  }
  return { ok: result.ok, text, repeatInfo };
}

module.exports = {
  normalizePhone,
  formatPhone,
  buildCard,
  sendLeadNotification
};
