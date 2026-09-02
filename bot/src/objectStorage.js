// Минимальный клиент Yandex Object Storage (S3-совместимое API) — только
// то, что нужно этому боту: прочитать/записать один JSON-объект в бакете.
// Реализован на встроенных модулях Node (https, crypto) — без внешних
// npm-пакетов, чтобы всю функцию можно было вставить прямо в inline-редактор
// кода Yandex Cloud Functions (Источник кода → «Редактор кода»), без сборки
// ZIP-архива и node_modules.
//
// Подпись запросов — по алгоритму AWS Signature V4 (Yandex Object Storage
// S3-совместим и принимает обычные подписанные S3-запросы со статическими
// ключами доступа сервисного аккаунта). Регион для подписи — "ru-central1"
// (стандартное значение для Yandex Object Storage).
//
// Нужны переменные окружения (задаются в настройках функции в консоли):
//   YC_S3_BUCKET       – имя бакета, например aura-max-bot-data
//   YC_S3_ACCESS_KEY   – Key ID статического ключа сервисного аккаунта
//   YC_S3_SECRET_KEY   – Secret статического ключа
// Как их получить — см. bot/README.md, раздел «Yandex Object Storage».

const https = require('https');
const crypto = require('crypto');

const REGION = 'ru-central1';
const SERVICE = 's3';
const HOST = 'storage.yandexcloud.net';

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}
function hash(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function getSignatureKey(secretKey, dateStamp, region, service) {
  const kDate = hmac('AWS4' + secretKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

// method: 'GET' | 'PUT'; objectKey: путь объекта в бакете (без ведущего /);
// body: строка (для PUT) или '' (для GET).
function signedRequest(method, bucket, objectKey, body, accessKey, secretKey) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);

  const canonicalUri = '/' + bucket + '/' + objectKey;
  const payloadHash = hash(body || '');

  const canonicalHeaders =
    'host:' + HOST + '\n' +
    'x-amz-content-sha256:' + payloadHash + '\n' +
    'x-amz-date:' + amzDate + '\n';
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const credentialScope = dateStamp + '/' + REGION + '/' + SERVICE + '/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, hash(canonicalRequest)].join('\n');

  const signingKey = getSignatureKey(secretKey, dateStamp, REGION, SERVICE);
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  const authorization =
    'AWS4-HMAC-SHA256 Credential=' + accessKey + '/' + credentialScope +
    ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;

  return {
    path: canonicalUri,
    headers: {
      Host: HOST,
      'X-Amz-Date': amzDate,
      'X-Amz-Content-Sha256': payloadHash,
      Authorization: authorization
    }
  };
}

function request(method, objectKey, body, config) {
  return new Promise((resolve, reject) => {
    const { path, headers } = signedRequest(method, config.bucket, objectKey, body, config.accessKey, config.secretKey);
    const data = body ? Buffer.from(body, 'utf8') : null;
    if (data) headers['Content-Length'] = data.length;

    const req = https.request({ hostname: HOST, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Возвращает распарсенный JSON или fallback, если объекта ещё нет (404)
// либо переменные окружения не настроены (тогда – предупреждение в лог,
// чтобы не уронить весь сценарий диалога из-за отсутствующего хранилища).
async function getJson(config, objectKey, fallback) {
  if (!config.bucket || !config.accessKey || !config.secretKey) {
    console.warn('[objectStorage] YC_S3_* не настроены, читаю пустые данные для', objectKey);
    return fallback;
  }
  try {
    const res = await request('GET', objectKey, '', config);
    if (res.status === 404) return fallback;
    if (res.status !== 200) {
      console.error('[objectStorage] GET ' + objectKey + ' -> ' + res.status, res.body);
      return fallback;
    }
    return JSON.parse(res.body);
  } catch (e) {
    console.error('[objectStorage] GET ' + objectKey + ' упал:', e.message);
    return fallback;
  }
}

async function putJson(config, objectKey, data) {
  if (!config.bucket || !config.accessKey || !config.secretKey) {
    console.warn('[objectStorage] YC_S3_* не настроены, запись', objectKey, 'пропущена');
    return false;
  }
  try {
    const res = await request('PUT', objectKey, JSON.stringify(data, null, 2), config);
    if (res.status !== 200) {
      console.error('[objectStorage] PUT ' + objectKey + ' -> ' + res.status, res.body);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[objectStorage] PUT ' + objectKey + ' упал:', e.message);
    return false;
  }
}

module.exports = { getJson, putJson };
