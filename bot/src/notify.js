// Единая точка формирования и отправки карточки заявки Олесе – используется
// и ботом (все ветки меню), и вебхуком с сайта (/webhook/lead), поэтому
// логика проверки повторного клиента и текст карточки не дублируются.

const config = require('./config');
const store = require('./store');
const maxApi = require('./maxApi');
const catalog = require('./catalog');

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

// data: { source, name, phone, productId, productName, siteRef, photoRef, interestedIn, comment }
// всё, кроме source/phone, – опционально.
function buildCard(data, repeatInfo, hasPhoto) {
  const lines = ['🔔 НОВАЯ ЗАЯВКА'];
  lines.push('Источник: ' + (data.source || 'Общая заявка'));
  if (data.name) lines.push('Имя: ' + data.name);
  lines.push('Телефон: ' + formatPhone(normalizePhone(data.phone)));
  if (data.productName) lines.push('Товар: ' + data.productName);
  // Ссылку на сайт оставляем всегда – даже когда фото уже прикреплено к
  // сообщению, ссылка полезна, чтобы открыть карточку товара на сайте целиком.
  if (data.siteRef) lines.push('🔗 Ссылка на сайте: ' + data.siteRef);
  if (data.photoRef) lines.push('📷 Понравилось фото' + (hasPhoto ? ' (см. фото выше)' : ': ' + data.photoRef));
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

  // Фото товара вместо голой ссылки – ищем по productId (приходит и из
  // бота, и с сайта, см. index.html siteRefFor/data-product-id) токен,
  // заранее загруженный в Max (scripts/sync-photos.js). Если для товара
  // фото ещё не синхронизировали – просто не будет вложения, карточка
  // всё равно уйдёт с текстом и ссылкой.
  const product = data.productId ? catalog.getProductById(data.productId) : null;
  const photoToken = product ? product.photoToken : null;

  const text = buildCard(data, repeatInfo, Boolean(photoToken));

  if (!config.ownerChatId) {
    console.warn('[notify] MAX_OWNER_CHAT_ID не настроен, карточка не отправлена:\n' + text);
    return { ok: false, text, repeatInfo };
  }

  const result = await maxApi.sendMessage({ userId: config.ownerChatId }, text, null, photoToken);
  return { ok: result.ok, text, repeatInfo };
}

module.exports = {
  normalizePhone,
  formatPhone,
  buildCard,
  sendLeadNotification
};
