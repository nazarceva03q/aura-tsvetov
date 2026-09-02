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
  return [{ type: 'inline_keyboard', payload: { buttons: rows } }];
}

// – отправка сообщения. target = { userId } или { chatId } –
async function sendMessage(target, text, rows) {
  if (!config.botToken) {
    console.warn('[maxApi] нет MAX_BOT_TOKEN, сообщение не отправлено:', text);
    return { ok: false, status: 0, body: { error: 'no token' } };
  }
  const query = target.userId
    ? '?user_id=' + encodeURIComponent(target.userId)
    : '?chat_id=' + encodeURIComponent(target.chatId);
  const payload = { text };
  if (rows && rows.length) payload.attachments = keyboardAttachment(rows);
  return callApi('POST', '/messages' + query, payload);
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
  callbackButton,
  requestContactButton,
  linkButton,
  subscribe,
  getMe
};
