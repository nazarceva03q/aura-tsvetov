// Тонкая обёртка над Max Bot API (https://dev.max.ru/docs-api).
// Подтверждено по документации и живым запросом (GET /me) на момент
// написания:
//   – базовый адрес: https://platform-api2.max.ru
//   – авторизация: заголовок "Authorization: <токен>" (НЕ query-параметр)
//   – отправка сообщения: POST /messages?user_id=<id>  (или ?chat_id=<id>)
//     тело: { text, attachments: [{ type: 'inline_keyboard', payload: { buttons: [[...]] } }] }
//   – кнопки: type "callback" (поле payload), "request_contact", "link"
//   – регистрация вебхука: POST /subscriptions { url, update_types, secret }
// Если после первых реальных вебхуков окажется, что какие-то поля во
// входящих апдейтах называются иначе (это возможно – часть схемы Update
// не была доступна при подготовке этого кода), правки нужны только в
// bot.js (разбор входящих апдейтов), сам этот файл трогать не придётся.
//
// ВАЖНО про TLS: platform-api2.max.ru использует сертификат от российского
// государственного удостоверяющего центра (Минцифры, «Russian Trusted Root
// CA») — этого корневого сертификата нет в стандартных доверенных хранилищах
// большинства ОС (Windows/Linux/macOS) за пределами специально настроенных
// российских окружений. Без него запросы к Max падают с
// UNABLE_TO_GET_ISSUER_CERT_LOCALLY. Поэтому здесь используется не
// глобальный fetch, а свой https.Agent с явно подмешанным сертификатом из
// bot/certs/russian-trusted-ca-bundle.pem (плюс системные корневые —
// остальной интернет как обычно). Так бот работает «из коробки» на любом
// сервере, без ручной настройки NODE_EXTRA_CA_CERTS или системного
// доверенного хранилища.

const https = require('https');
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const config = require('./config');

const HOST = 'platform-api2.max.ru';

const CA_BUNDLE_PATH = path.join(__dirname, '..', 'certs', 'russian-trusted-ca-bundle.pem');
let caList = tls.rootCertificates;
try {
  const extra = fs.readFileSync(CA_BUNDLE_PATH, 'utf8');
  const extraCerts = extra
    .split(/(?=-----BEGIN CERTIFICATE-----)/g)
    .map((c) => c.trim())
    .filter(Boolean);
  caList = tls.rootCertificates.concat(extraCerts);
} catch (e) {
  console.warn(
    '[maxApi] не удалось прочитать ' + CA_BUNDLE_PATH + ' — запросы к Max API, скорее всего, ' +
      'будут падать с ошибкой TLS (UNABLE_TO_GET_ISSUER_CERT_LOCALLY). См. bot/README.md.'
  );
}

const agent = new https.Agent({ ca: caList, keepAlive: true });

function callApi(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { Authorization: config.botToken };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = data.length;
    }

    const req = https.request(
      { hostname: HOST, path: urlPath, method, agent, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = text ? JSON.parse(text) : {};
          } catch (e) {
            json = { raw: text };
          }
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          if (!ok) {
            console.error('[maxApi] ' + method + ' ' + urlPath + ' -> ' + res.statusCode, json);
          }
          resolve({ ok, status: res.statusCode, body: json });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// – кнопки –
// Живой запрос показал, что поле называется "payload", а не "callback_data"
// (как было в изначально найденной сводке по документации) — API вернул
// {"code":"proto.payload","message":"Field 'payload' cannot be null"} при
// отправке кнопки с callback_data. Похоже, Max последовательно использует
// "payload" как имя поля-контейнера для данных (так же оформлена и сама
// клавиатура: attachments[].payload.buttons).
function callbackButton(text, callbackData) {
  return { type: 'callback', text, payload: callbackData };
}
function requestContactButton(text) {
  return { type: 'request_contact', text: text || '📱 Поделиться контактом' };
}
function linkButton(text, url) {
  return { type: 'link', text, url };
}

// rows – массив массивов кнопок, напр. [[btn1, btn2], [btn3]]
function keyboardAttachment(rows) {
  return { type: 'inline_keyboard', payload: { buttons: rows } };
}

// token – из bot/src/photoTokens.json (см. scripts/sync-photos.js)
function imageAttachment(token) {
  return { type: 'image', payload: { token } };
}

// – отправка сообщения. target = { userId } или { chatId }.
// photoToken (необязательно) – фото товара, показывается вместе с текстом
// и кнопками в одном сообщении.
async function sendMessage(target, text, rows, photoToken) {
  if (!config.botToken) {
    console.warn('[maxApi] нет MAX_BOT_TOKEN, сообщение не отправлено:', text);
    return { ok: false, status: 0, body: { error: 'no token' } };
  }
  const query = target.userId
    ? '?user_id=' + encodeURIComponent(target.userId)
    : '?chat_id=' + encodeURIComponent(target.chatId);
  const payload = { text };
  const attachments = [];
  if (photoToken) attachments.push(imageAttachment(photoToken));
  if (rows && rows.length) attachments.push(keyboardAttachment(rows));
  if (attachments.length) payload.attachments = attachments;
  return callApi('POST', '/messages' + query, payload);
}

// Сообщение с фото по прямой HTTPS-ссылке (а не по token, как imageAttachment
// выше) — используется только в bot/src/admin.js, для показа фото товаров,
// загруженных владелицей через бота (там URL — это адрес в Yandex Object
// Storage, а не заранее загруженный в Max файл, токена для него нет).
// ВАЖНО: формат вложения "image" с полем "url" (вместо "token") не был
// подтверждён живым запросом на момент написания кода (по документации
// Max поддерживает оба способа для фото, но это стоит перепроверить по
// логам после первого реального теста). Поэтому вызывающий код в admin.js
// всегда проверяет result.ok и при неудаче повторяет отправку тем же
// текстом без фото — так сценарий не подвиснет, даже если этот способ
// вложения не сработает.
async function sendPhotoUrlMessage(target, text, rows, photoUrl) {
  if (!config.botToken) {
    console.warn('[maxApi] нет MAX_BOT_TOKEN, сообщение с фото не отправлено:', text);
    return { ok: false, status: 0, body: { error: 'no token' } };
  }
  const query = target.userId
    ? '?user_id=' + encodeURIComponent(target.userId)
    : '?chat_id=' + encodeURIComponent(target.chatId);
  const payload = { text };
  const attachments = [];
  if (photoUrl) attachments.push({ type: 'image', payload: { url: photoUrl } });
  if (rows && rows.length) attachments.push(keyboardAttachment(rows));
  if (attachments.length) payload.attachments = attachments;
  return callApi('POST', '/messages' + query, payload);
}

// Скачивает файл по HTTPS (используется в admin.js, чтобы забрать байты
// фото, которое владелица прислала боту, и перезалить их в Object Storage —
// см. комментарий в admin.js про то, зачем это нужно). Использует тот же
// расширенный список доверенных корневых сертификатов, что и остальной
// файл (см. заголовок), на случай если CDN фото Max тоже использует
// российский государственный сертификат. Следует до 5 редиректов.
function downloadBinary(url, redirectsLeft) {
  if (redirectsLeft === undefined) redirectsLeft = 5;
  return new Promise((resolve, reject) => {
    https.get(url, { agent }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        resolve(downloadBinary(res.headers.location, redirectsLeft - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('downloadBinary: ' + url + ' -> ' + res.statusCode));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] || 'image/jpeg' });
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Сообщение с разметкой markdown (format: 'markdown', подтверждено
// документацией POST /messages). Используется только там, где нужна
// именно кликабельная ссылка на профиль по user_id — max://user/<id> (тоже
// подтверждено документацией, формат упоминаний в сообщениях). Отдельная
// функция, а не флаг у sendMessage: текст обычных сообщений (в т.ч. вопрос
// покупателя, введённый им самим) НЕ размечается как markdown специально,
// чтобы случайные символы вроде * или _ в чужом тексте не ломали вид.
async function sendMarkdownMessage(target, markdownText) {
  if (!config.botToken) {
    console.warn('[maxApi] нет MAX_BOT_TOKEN, сообщение не отправлено:', markdownText);
    return { ok: false, status: 0, body: { error: 'no token' } };
  }
  const query = target.userId
    ? '?user_id=' + encodeURIComponent(target.userId)
    : '?chat_id=' + encodeURIComponent(target.chatId);
  return callApi('POST', '/messages' + query, { text: markdownText, format: 'markdown' });
}

function userMention(label, userId) {
  // Экранируем ] и ( внутри текста ссылки – маловероятно в имени, но на
  // всякий случай, чтобы не сломать markdown-разметку.
  const safeLabel = String(label).replace(/[[\]()]/g, '');
  return '[' + safeLabel + '](max://user/' + userId + ')';
}

// – регистрация вебхука (используется скриптом bot/scripts/setup-webhook.js) –
async function subscribe(webhookUrl, secret) {
  const body = {
    url: webhookUrl,
    update_types: ['message_created', 'message_callback', 'bot_started']
  };
  if (secret) body.secret = secret;
  return callApi('POST', '/subscriptions', body);
}

async function getMe() {
  return callApi('GET', '/me');
}

module.exports = {
  sendMessage,
  sendPhotoUrlMessage,
  downloadBinary,
  sendMarkdownMessage,
  userMention,
  callbackButton,
  requestContactButton,
  linkButton,
  subscribe,
  getMe
};
