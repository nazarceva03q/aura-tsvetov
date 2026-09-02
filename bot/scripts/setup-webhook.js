// Одноразовый скрипт: регистрирует вебхук сервера в Max Bot API, чтобы Max
// начал слать сюда апдейты (сообщения, нажатия кнопок). Запускать один раз
// после того, как сервер уже развёрнут и доступен по HTTPS:
//
//   cd bot && npm run setup-webhook
//
// Требует заполненных MAX_BOT_TOKEN и PUBLIC_SERVER_URL в bot/.env.
// PUBLIC_SERVER_URL — ПОЛНЫЙ адрес вебхука (с путём, если он есть):
//   VM (server.js, Express):        https://bot.aura-flower.shop/webhook/max
//   Yandex Cloud Functions:          https://functions.yandexcloud.net/<id-функции>
//     (у функции один URL на всё — путь не добавляется, см. bot/index.js)

const config = require('../src/config');
const maxApi = require('../src/maxApi');

async function main() {
  if (!config.botToken) {
    console.error('Заполните MAX_BOT_TOKEN в bot/.env перед запуском.');
    process.exit(1);
  }
  if (!config.publicServerUrl) {
    console.error('Заполните PUBLIC_SERVER_URL в bot/.env (полный HTTPS-адрес вебхука, см. комментарий выше).');
    process.exit(1);
  }

  const me = await maxApi.getMe();
  if (!me.ok) {
    console.error('Не удалось проверить токен бота (GET /me):', me.body);
    process.exit(1);
  }
  console.log('Токен рабочий, бот: @' + (me.body.username || me.body.first_name));

  const webhookUrl = config.publicServerUrl;
  const result = await maxApi.subscribe(webhookUrl, config.webhookSecret);
  if (!result.ok) {
    console.error('Не удалось зарегистрировать вебхук:', result.body);
    process.exit(1);
  }
  console.log('Вебхук зарегистрирован:', webhookUrl);
  console.log('Готово! Теперь напишите боту в Max ("Начать") и проверьте, что пришло главное меню.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
