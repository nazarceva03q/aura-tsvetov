// Точка входа для Yandex Cloud Functions (Node.js). Использует ту же
// логику, что и bot/server.js (VM-деплой) — src/bot.js, src/notify.js —
// просто адаптирует её под вызов через HTTP-триггер функции вместо
// постоянно работающего Express-сервера.
//
// Настройки в консоли:
//   Точка входа:      index.handler
//   Переменные окружения: см. bot/.env.example (+ YC_S3_* для хранилища)
//
// ВАЖНО: у функции своего пути (path) нет – один URL на всю функцию.
// Поэтому вебхук Max и вебхук сайта используют ОДИН И ТОТ ЖЕ URL функции,
// а тип запроса определяется по форме тела: апдейты Max всегда содержат
// update_type, заявки с сайта – phone (и никогда update_type).
//
// ВАЖНО про фризинг контейнера: после return из handler'а Yandex Cloud
// Functions может заморозить/остановить контейнер, поэтому вся обработка
// (включая исходящие сообщения в Max) должна быть ЗАВЕРШЕНА до return –
// в отличие от server.js (VM), здесь нельзя «ответить сразу, обработать
// в фоне».

const config = require('./src/config');
const bot = require('./src/bot');
const notify = require('./src/notify');

function json(statusCode, data, extraHeaders) {
  return {
    statusCode,
    headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}),
    body: JSON.stringify(data)
  };
}

function getHeader(headers, name) {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function corsHeaders() {
  // Единая функция дергается и Max, и браузером с сайта – для Max Origin
  // не шлётся, эти заголовки ему безвредны. Для сайта разрешаем его домен;
  // при желании сузить – замените '*' на config.siteBaseUrl.
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

module.exports.handler = async function (event, context) {
  try {
    const method = event.httpMethod || 'POST';

    if (method === 'OPTIONS') {
      return { statusCode: 204, headers: corsHeaders(), body: '' };
    }

    if (method === 'GET') {
      return json(200, { ok: true, service: 'aura-tsvetov-bot' }, corsHeaders());
    }

    let raw = event.body || '';
    if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (e) {
      return json(400, { ok: false, error: 'invalid JSON' }, corsHeaders());
    }

    // – апдейт от Max Bot API –
    if (data.update_type) {
      if (config.webhookSecret) {
        const got = getHeader(event.headers, 'X-Max-Bot-Api-Secret');
        if (got !== config.webhookSecret) {
          console.warn('[handler] неверный X-Max-Bot-Api-Secret, запрос отклонён');
          return json(403, { ok: false }, corsHeaders());
        }
      }
      await bot.handleUpdate(data);
      return json(200, { ok: true }, corsHeaders());
    }

    // – заявка с сайта (форма «Оставить заявку») –
    if (data.phone) {
      const result = await notify.sendLeadNotification({
        source: data.source || (data.category ? 'Сайт → форма → ' + data.category : 'Сайт → форма'),
        name: data.name || '',
        phone: data.phone,
        productName: data.product || '',
        siteRef: data.siteRef || '',
        photoRef: data.photoRef || '',
        comment: data.comment || ''
      });
      return json(200, { ok: result.ok }, corsHeaders());
    }

    return json(400, { ok: false, error: 'unrecognized payload (нет ни update_type, ни phone)' }, corsHeaders());
  } catch (err) {
    console.error('[handler] необработанная ошибка:', err);
    return json(500, { ok: false }, corsHeaders());
  }
};
