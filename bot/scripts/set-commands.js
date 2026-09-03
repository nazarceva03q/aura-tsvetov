// Регистрирует команды бота в Max (PATCH /me/commands) – появляются
// подсказкой, когда пользователь начинает вводить «/» в чате. Max не умеет
// в закреплённую кнопку-меню сбоку (в отличие от Telegram) – команды это
// ближайший аналог: не занимают место в переписке, но всегда доступны.
//
// Запуск (из bot/, один раз, повторный запуск просто перезапишет список):
//   node scripts/set-commands.js

const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const config = require('../src/config');

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
  console.warn('[set-commands] не удалось прочитать ' + CA_BUNDLE_PATH);
}
const agent = new https.Agent({ ca: caList });

function patchCommands(commands) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ commands }));
    const req = https.request(
      {
        hostname: 'platform-api2.max.ru',
        path: '/me/commands',
        method: 'PATCH',
        agent,
        headers: {
          Authorization: config.botToken,
          'Content-Type': 'application/json',
          'Content-Length': body.length
        }
      },
      (res) => {
        let resBody = '';
        res.on('data', (c) => (resBody += c));
        res.on('end', () => resolve({ status: res.statusCode, body: resBody }));
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
  const res = await patchCommands([
    { name: 'start', description: 'Показать меню' },
    { name: 'menu', description: 'Показать меню' }
  ]);
  console.log(res.status, res.body);
  if (res.status >= 200 && res.status < 300) {
    console.log('Готово. В чате бота теперь можно ввести «/» — появятся команды start и menu, обе открывают меню заново.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
