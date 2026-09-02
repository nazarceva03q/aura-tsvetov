// HTTP-сервер бота: два вебхука на один и тот же поток заявок –
//   POST /webhook/max   – апдейты от Max Bot API (кнопки меню, сообщения)
//   POST /webhook/lead  – форма «Оставить заявку» с сайта (index.html, sendToMaxBot)
// Оба в итоге зовут notify.sendLeadNotification() и пишут в один и тот же
// чат Олеси в Max – единая интеграция, как и просили в ТЗ.

const express = require('express');
const config = require('./src/config');
const bot = require('./src/bot');
const notify = require('./src/notify');

const app = express();
app.use(express.json({ limit: '256kb' }));

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'aura-tsvetov-bot' });
});

// – вебхук Max Bot API –
app.post('/webhook/max', (req, res) => {
  if (config.webhookSecret) {
    const got = req.get('X-Max-Bot-Api-Secret');
    if (got !== config.webhookSecret) {
      console.warn('[server] webhook /webhook/max: неверный X-Max-Bot-Api-Secret, запрос отклонён');
      return res.sendStatus(403);
    }
  }

  // Отвечаем Max сразу 200, обработку не ждём – чтобы не словить таймаут
  // и повторную доставку апдейта, пока bot.handleUpdate() ходит в Max API
  // за отправкой ответных сообщений.
  res.sendStatus(200);

  bot.handleUpdate(req.body).catch((err) => {
    console.error('[server] необработанная ошибка в bot.handleUpdate:', err);
  });
});

// – вебхук формы заявки на сайте –
const allowedOrigins = [config.siteBaseUrl, config.siteBaseUrl.replace('https://', 'https://www.')];

function corsHeaders(req, res) {
  const origin = req.get('Origin');
  if (origin && (allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production')) {
    res.set('Access-Control-Allow-Origin', origin);
  }
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}

app.options('/webhook/lead', (req, res) => {
  corsHeaders(req, res);
  res.sendStatus(204);
});

app.post('/webhook/lead', async (req, res) => {
  corsHeaders(req, res);
  const data = req.body || {};

  if (!data.phone) {
    return res.status(400).json({ ok: false, error: 'phone обязателен' });
  }

  // source с сайта передаётся как есть (например «Предзаказ на праздники»,
  // «Общая заявка», «Акции → …») – поле «Источник» в карточке уведомления
  // не ограничено фиксированным списком значений, как и просили в ТЗ.
  const result = await notify.sendLeadNotification({
    source: data.source || (data.category ? 'Сайт → форма → ' + data.category : 'Сайт → форма'),
    name: data.name || '',
    phone: data.phone,
    productName: data.product || '',
    siteRef: data.siteRef || '',
    photoRef: data.photoRef || '',
    comment: data.comment || ''
  });

  res.json({ ok: result.ok });
});

app.listen(config.port, () => {
  console.log('[server] бот "Аура цветов" слушает на порту ' + config.port);
  console.log('[server] webhook для Max:   POST /webhook/max');
  console.log('[server] webhook для сайта: POST /webhook/lead');
});
