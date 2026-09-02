// Единая точка формирования и отправки карточки заявки Олесе – используется
// и ботом (все ветки меню), и вебхуком с сайта (/webhook/lead), поэтому
// логика проверки повторного клиента и текст карточки не дублируются.

const config = require('./config');
const store = require('./store');
const maxApi = require('./maxApi');

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

// data: { source, name, phone, productName, siteRef, photoRef, interestedIn, comment }
// name/productName/siteRef/photoRef/interestedIn/comment – опциональны.
function buildCard(data, repeatInfo) {
  const lines = ['🔔 НОВАЯ ЗАЯВКА'];
  lines.push('Источник: ' + (data.source || 'Общая заявка'));
  if (data.name) lines.push('Имя: ' + data.name);
  lines.push('Телефон: ' + formatPhone(normalizePhone(data.phone)));
  if (data.productName) lines.push('Товар: ' + data.productName);
  if (data.siteRef) lines.push('🔗 Ссылка на сайте: ' + data.siteRef);
  if (data.photoRef) lines.push('📷 Понравилось фото: ' + data.photoRef);
  if (data.interestedIn) lines.push('Интересовало: ' + data.interestedIn);
  if (data.comment) lines.push('Комментарий: ' + data.comment);
  if (repeatInfo && repeatInfo.isRepeat) {
    lines.push('👤 Повторный заказ (первое обращение: ' + formatDate(repeatInfo.firstSeen) + ')');
  }
  lines.push('Время: ' + formatDate(new Date().toISOString()));
  return lines.join('\n');
}

// Возвращает { ok, text } – text полезен для логов/отладки даже если
// MAX_OWNER_CHAT_ID ещё не настроен (тогда отправка просто не произойдёт).
async function sendLeadNotification(data) {
  const phoneDigits = normalizePhone(data.phone);
  const repeatInfo = data.phone ? await store.checkAndRecordCustomer(phoneDigits) : { isRepeat: false, firstSeen: null };
  const text = buildCard(data, repeatInfo);

  if (!config.ownerChatId) {
    console.warn('[notify] MAX_OWNER_CHAT_ID не настроен, карточка не отправлена:\n' + text);
    return { ok: false, text, repeatInfo };
  }

  const result = await maxApi.sendMessage({ userId: config.ownerChatId }, text);
  return { ok: result.ok, text, repeatInfo };
}

module.exports = {
  normalizePhone,
  formatPhone,
  buildCard,
  sendLeadNotification
};
