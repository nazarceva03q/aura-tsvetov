// Загружает фото товаров в Max (POST /uploads -> multipart upload -> token)
// и сохраняет токены в bot/src/photoTokens.json. Токены переиспользуемые
// («Загружайте часто используемые файлы заранее и переиспользуйте токен» —
// официальная рекомендация Max), поэтому загружать нужно только один раз
// и заново — только если поменяется само фото.
//
// Запуск (из bot/):
//   node scripts/sync-photos.js
//
// Что загружать и куда класть файлы: см. bot/README.md, раздел «Фото
// товаров в боте». Коротко: JPEG/PNG (не WEBP — Max их не принимает),
// файл с именем <id-товара>.jpg в scripts/_photos_tmp/, id — как в
// src/catalog.js.

const fs = require('fs');
const path = require('path');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');
const config = require('../src/config');

const PHOTOS_DIR = path.join(__dirname, '_photos_tmp');
const OUT_PATH = path.join(__dirname, '..', 'src', 'photoTokens.json');

// platform-api2.max.ru использует сертификат Минцифры (Russian Trusted Root
// CA), которого нет в системных доверенных хранилищах большинства ОС — та
// же причина и то же решение, что в src/maxApi.js (см. комментарий там).
const CA_BUNDLE_PATH = path.join(__dirname, '..', 'certs', 'russian-trusted-ca-bundle.pem');
let caList = tls.rootCertificates;
try {
  const extra = fs
    .readFileSync(CA_BUNDLE_PATH, 'utf8')
    .split(/(?=-----BEGIN CERTIFICATE-----)/g)
    .map((c) => c.trim())
    .filter(Boolean);
  caList = tls.rootCertificates.concat(extra);
} catch (e) {
  console.warn('[sync-photos] не удалось прочитать ' + CA_BUNDLE_PATH + ' — запросы к Max, скорее всего, упадут с TLS-ошибкой.');
}
const agent = new https.Agent({ ca: caList, keepAlive: true });

function requestUploadUrl() {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'platform-api2.max.ru',
        path: '/uploads?type=image',
        method: 'POST',
        agent,
        headers: { Authorization: config.botToken }
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error('uploads -> ' + res.statusCode + ' ' + body));
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function uploadFile(uploadUrl, filePath) {
  return new Promise((resolve, reject) => {
    const boundary = '----auraBotBoundary' + crypto.randomBytes(8).toString('hex');
    const fileData = fs.readFileSync(filePath);
    const filename = path.basename(filePath);

    const preamble = Buffer.from(
      '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="data"; filename="' + filename + '"\r\n' +
        'Content-Type: image/jpeg\r\n\r\n'
    );
    const epilogue = Buffer.from('\r\n--' + boundary + '--\r\n');
    const body = Buffer.concat([preamble, fileData, epilogue]);

    const u = new URL(uploadUrl);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        agent,
        headers: {
          'Content-Type': 'multipart/form-data; boundary=' + boundary,
          'Content-Length': body.length
        }
      },
      (res) => {
        let resBody = '';
        res.on('data', (c) => (resBody += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error('upload -> ' + res.statusCode + ' ' + resBody));
          }
          // Ответ шага загрузки (не /uploads!) содержит настоящий token:
          // { "photos": { "<photoId>": { "token": "..." } } } – имя
          // <photoId> нас не интересует, берём первое (и единственное,
          // раз грузим один файл за раз) значение.
          try {
            const parsed = JSON.parse(resBody);
            const photos = parsed.photos || {};
            const firstKey = Object.keys(photos)[0];
            const token = firstKey ? photos[firstKey].token : null;
            if (!token) return reject(new Error('upload OK, но token не найден в ответе: ' + resBody));
            resolve(token);
          } catch (e) {
            reject(new Error('не удалось разобрать ответ загрузки: ' + resBody));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  if (!config.botToken) {
    console.error('Заполните MAX_BOT_TOKEN в bot/.env перед запуском.');
    process.exit(1);
  }
  if (!fs.existsSync(PHOTOS_DIR)) {
    console.error('Нет папки ' + PHOTOS_DIR + ' — положите туда <id-товара>.jpg (см. bot/README.md).');
    process.exit(1);
  }

  const files = fs.readdirSync(PHOTOS_DIR).filter((f) => /\.(jpe?g|png)$/i.test(f));
  if (!files.length) {
    console.error('В ' + PHOTOS_DIR + ' нет jpg/png файлов.');
    process.exit(1);
  }

  let tokens = {};
  if (fs.existsSync(OUT_PATH)) {
    tokens = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
  }

  for (const file of files) {
    const productId = file.replace(/\.(jpe?g|png)$/i, '');
    const filePath = path.join(PHOTOS_DIR, file);
    process.stdout.write('Загружаю ' + productId + '... ');
    try {
      const { url } = await requestUploadUrl();
      const token = await uploadFile(url, filePath);
      tokens[productId] = token;
      console.log('OK');
    } catch (e) {
      console.log('ОШИБКА: ' + e.message);
    }
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(tokens, null, 2) + '\n', 'utf8');
  console.log('Готово. Токены сохранены в ' + OUT_PATH);
  console.log('Пересоберите zip (python scripts/build-yandex-zip.py) и загрузите в Yandex Cloud Functions.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
