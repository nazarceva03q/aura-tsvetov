const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

// Mock transport and storage: tests never contact MAX or read bot secrets.
function load(file, dependencies) {
  const sandbox = {
    module: { exports: {} }, __dirname: path.dirname(path.join(root, file)),
    require(name) { if (name === 'crypto') return require('node:crypto'); if (!(name in dependencies)) throw Error('Unexpected dependency: ' + name); return dependencies[name]; },
    console: { log() {}, warn() {}, error(...args) { throw Error(args.join(' ')); } },
    Buffer, setTimeout, clearTimeout
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
  return sandbox.module.exports;
}
const config = { siteBaseUrl: 'https://aura-flower.shop', ownerChatId: '999' };
const catalog = load('bot/src/catalog.js', { './config': config, './photoTokens.json': {} });
const notify = load('bot/src/notify.js', { './config': config, './store': {}, './maxApi': {}, './catalog': catalog });

test('website leads reach owner transport with source, product and first/repeat status', async () => {
  const objects = {};
  const storageConfig = { ...config, s3: { bucket: 'test' } };
  const store = load('bot/src/store.js', {
    fs: {}, path: { join: () => 'unused' }, './config': storageConfig,
    './objectStorage': {
      getJson: async (cfg, key, fallback) => objects[key] || fallback,
      putJson: async (cfg, key, data) => { objects[key] = JSON.parse(JSON.stringify(data)); return true; }
    }
  });
  const sent = [];
  const sender = load('bot/src/notify.js', {
    './config': config, './store': store, './catalog': catalog,
    './maxApi': { sendMessage: async (target, text) => { sent.push({ target, text }); return { ok: true }; } }
  });
  const handler = load('bot/index.js', {
    './src/config': config, './src/bot': {}, './src/notify': sender
  }).handler;
  const sources = ['Первый экран → Помочь с выбором', 'Не знаете, какой букет выбрать? → Подобрать букет',
    'Предзаказ к праздникам → Обсудить предзаказ', 'Каталог → Букеты → Хочу такой', 'Каталог → Букеты → Хочу похожий'];
  for (const [index, source] of sources.entries()) {
    const data = { source: 'Сайт → ' + source, name: 'Тест', phone: index ? '+7 (900) 123-45-67' : '89001234567' };
    if (index >= 3) Object.assign(data, { productId: 'buket-1', product: 'Букет 1', price: '3000 ₽', siteRef: 'https://aura-flower.shop/#category=bukety&product=buket-1' });
    const response = await handler({ httpMethod: 'POST', body: JSON.stringify(data) });
    assert.equal(JSON.parse(response.body).ok, true);
    const card = sent.at(-1);
    assert.equal(card.target.userId, config.ownerChatId);
    assert.ok(card.text.includes(data.source));
    assert.match(card.text, index ? /Повторный заказ/ : /Первый заказ/);
    if (index >= 3) {
      assert.ok(card.text.includes(data.siteRef));
      assert.match(card.text, /Товар: Букет 1/);
      assert.match(card.text, /Цена: 3000 ₽/);
    }
  }
});

test('all 23 website IDs and prices match the bot', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const website = vm.runInNewContext('(' + html.match(/var CATALOG = (\{[\s\S]*?\n  \});/)[1] + ')');
  const products = Object.values(website).flat();
  assert.equal(products.length, 23);
  assert.equal(catalog.PRODUCTS.length, products.length);
  for (const item of products) assert.equal(catalog.getProductById(item.id).price, item.price);
});

test('owner notification uses catalog price and preserves product context', () => {
  const card = notify.buildCard({ productId: 'buket-1', productName: 'Букет 1', price: '1 ₽', imageUrl: 'https://aura-flower.shop/products/buket-1.webp' }, null, false);
  assert.match(card, /Цена: 3000 ₽/);
  assert.match(card, /Артикул: buket-1/);
  assert.match(card, /products\/buket-1.webp/);
});

test('pink hydrangea order reaches owner transport with verified price and image', async () => {
  let sent;
  const sender = load('bot/src/notify.js', {
    './config': config, './catalog': catalog,
    './store': { checkAndRecordCustomer: async () => ({ isRepeat: false }) },
    './maxApi': { sendMessage: async (target, text) => { sent = { target, text }; return { ok: true }; } }
  });
  const handler = load('bot/index.js', { './src/config': config, './src/bot': {}, './src/notify': sender }).handler;
  const result = await handler({ httpMethod: 'POST', body: JSON.stringify({ name: 'Тест', phone: '+79001234567', productId: 'buket-rozovoy-gortenzii', product: 'Букет из розовой гортензии', price: '1 ₽', imageUrl: 'https://aura-flower.shop/products/buket-rozovoy-gortenzii.webp', siteRef: 'https://aura-flower.shop/#category=bukety&product=buket-rozovoy-gortenzii' }) });
  assert.equal(JSON.parse(result.body).ok, true);
  assert.equal(sent.target.userId, config.ownerChatId);
  for (const value of ['Букет из розовой гортензии', '1500 ₽', 'Артикул: buket-rozovoy-gortenzii', '/products/buket-rozovoy-gortenzii.webp']) assert.ok(sent.text.includes(value));
});

test('cloud form forwards context and reports delivery failure accurately', async () => {
  let received;
  const handler = load('bot/index.js', {
    './src/config': config, './src/bot': {},
    './src/notify': { sendLeadNotification: async data => { received = data; return { ok: false }; } }
  }).handler;
  const result = await handler({ httpMethod: 'POST', body: JSON.stringify({ name: 'Test', phone: '+79001234567', productId: 'buket-1', product: 'Букет 1', price: '3000 ₽', slug: 'buket-1', imageUrl: 'https://aura-flower.shop/products/buket-1.webp' }) });
  assert.equal(JSON.parse(result.body).ok, false);
  assert.equal(received.productId, 'buket-1');
  assert.equal(received.price, '3000 ₽');
  assert.equal(received.slug, 'buket-1');
});

// – новый сценарий бота: согласие → вопрос → телефон → пересылка Олесе –

function makeBotEnv() {
  const seen = new Set();
  const sessions = {};
  const questions = {};
  const owner = [];
  const client = [];
  const bot = load('bot/src/bot.js', {
    './config': config,
    './notify': { normalizePhone: notify.normalizePhone, formatPhone: notify.formatPhone },
    './store': {
      wasRecentlyProcessed: async (key) => { if (seen.has(key)) return true; seen.add(key); return false; },
      getSession: async (id) => sessions[id] || { step: 'idle' },
      setSession: async (id, value) => { sessions[id] = value; },
      clearSession: async (id) => { delete sessions[id]; },
      saveQuestion: async (id, userId, text, name, phone) => { questions[id] = { userId, userName: name, userPhone: phone, question: text, answered: false }; },
      getQuestion: async (id) => questions[id] || null,
      markQuestionAnswered: async (id) => { if (questions[id]) questions[id].answered = true; }
    },
    './maxApi': {
      sendMessage: async (target, text, rows) => { (String(target.userId) === config.ownerChatId ? owner : client).push({ text, rows }); return { ok: true }; },
      sendMarkdownMessage: async (target, text) => { (String(target.userId) === config.ownerChatId ? owner : client).push({ text, markdown: true }); return { ok: true }; },
      userMention: (label, id) => '[' + label + '](max://user/' + id + ')',
      callbackButton: (text, payload) => ({ type: 'callback', text, payload }),
      requestContactButton: (text) => ({ type: 'request_contact', text })
    }
  });
  return { bot, sessions, questions, owner, client };
}

test('dialogue is blocked until the consent button is pressed', async () => {
  const env = makeBotEnv();
  await env.bot.handleUpdate({ update_type: 'bot_started', user: { user_id: 1 } });
  assert.equal(env.sessions[1].step, 'awaiting_consent');
  const greeting = env.client.at(-1);
  assert.match(greeting.text, /Добрый день/);
  assert.match(greeting.text, /согласие/);
  assert.equal(greeting.rows[0][0].payload, 'consent:start');

  await env.bot.handleUpdate({ update_type: 'message_created', user: { user_id: 1 }, message: { body: { text: 'Хочу букет' } } });
  assert.equal(env.sessions[1].step, 'awaiting_consent');
  assert.match(env.client.at(-1).text, /нажмите кнопку выше/);
});

test('consent -> question -> manually-typed phone still picks up the auto-detected name, forwards a labeled question to the owner, then thanks the client by name', async () => {
  const env = makeBotEnv();
  await env.bot.handleUpdate({ update_type: 'bot_started', user: { user_id: 2, first_name: 'Аня' } });
  await env.bot.handleUpdate({ update_type: 'message_callback', user: { user_id: 2, first_name: 'Аня' }, callback_data: 'consent:start' });
  assert.equal(env.sessions[2].step, 'awaiting_message');
  assert.match(env.client.at(-1).text, /Чем можем вам помочь/);

  await env.bot.handleUpdate({ update_type: 'message_created', user: { user_id: 2, first_name: 'Аня' }, message: { body: { text: 'Сколько стоит букет №1?' } } });
  assert.equal(env.sessions[2].step, 'awaiting_phone');
  assert.match(env.client.at(-1).text, /номером телефона/);

  // Телефон вводится вручную текстом (не через кнопку «Поделиться контактом») –
  // имя всё равно должно определиться автоматически из профиля отправителя.
  await env.bot.handleUpdate({ update_type: 'message_created', user: { user_id: 2, first_name: 'Аня' }, message: { body: { text: '+79991234567' } } });
  assert.equal(env.sessions[2].step, 'chatting');
  assert.equal(env.sessions[2].name, 'Аня');

  const nameMsg = env.owner.find((m) => m.markdown);
  assert.match(nameMsg.text, /Аня/);
  assert.match(nameMsg.text, /\+7 \(999\) 123-45-67/);
  const questionMsg = env.owner.find((m) => m.rows);
  assert.match(questionMsg.text, /^❓ Вопрос: Сколько стоит букет №1\?$/);
  assert.equal(questionMsg.rows[0][0].payload.indexOf('answer:'), 0);

  assert.equal(env.client.at(-1).text, 'Спасибо, Аня! Мы получили ваше сообщение, скоро ответим!');

  // Дальше клиент пишет свободно, без повторного согласия/запроса телефона –
  // каждое сообщение снова уходит Олесе.
  env.owner.length = 0;
  await env.bot.handleUpdate({ update_type: 'message_created', user: { user_id: 2, first_name: 'Аня' }, message: { body: { text: 'А доставка сегодня возможна?' } } });
  assert.equal(env.sessions[2].step, 'chatting');
  assert.match(env.owner.find((m) => m.rows).text, /А доставка сегодня возможна\?/);
});

test('thank-you message falls back to name-less phrasing when the name is unknown', async () => {
  const env = makeBotEnv();
  await env.bot.handleUpdate({ update_type: 'bot_started', user: { user_id: 4 } });
  await env.bot.handleUpdate({ update_type: 'message_callback', user: { user_id: 4 }, callback_data: 'consent:start' });
  await env.bot.handleUpdate({ update_type: 'message_created', user: { user_id: 4 }, message: { body: { text: 'Вопрос без имени' } } });
  await env.bot.handleUpdate({ update_type: 'message_created', user: { user_id: 4 }, message: { body: { text: '+79991234567' } } });
  assert.equal(env.sessions[4].name, '');
  assert.equal(env.client.at(-1).text, 'Спасибо! Мы получили ваше сообщение, скоро ответим!');
});

test("owner's answer reaches the client as a plain message with no label or buttons", async () => {
  const env = makeBotEnv();
  env.sessions[3] = { step: 'chatting', name: 'Аня', phone: '79991234567' };
  env.questions.q1 = { userId: 3, userName: 'Аня', userPhone: '79991234567', question: 'Вопрос', answered: false };
  await env.bot.handleUpdate({ update_type: 'message_callback', user: { user_id: 999 }, callback_data: 'answer:q1' });
  assert.equal(env.sessions[999].step, 'awaiting_answer');

  env.client.length = 0;
  await env.bot.handleUpdate({ update_type: 'message_created', user: { user_id: 999 }, message: { body: { text: 'Да, доставим сегодня!' } } });
  assert.equal(env.client.length, 1);
  assert.equal(env.client[0].text, 'Да, доставим сегодня!');
  assert.equal(env.client[0].rows, undefined);
  assert.equal(env.questions.q1.answered, true);
});

test('a new question after an answer includes identity once; retries and concurrent deliveries do not duplicate it', async () => {
  const env = makeBotEnv();
  env.sessions[3] = { step: 'chatting', name: 'Аня', phone: '79991234567' };
  const message = (mid, text, userId = 3) => ({ update_type: 'message_created', timestamp: 1, message: { sender: { user_id: userId }, body: { mid, text } } });
  await env.bot.handleUpdate(message('first', 'Есть розы?'));
  const payload = env.owner.find(m => m.rows).rows[0][0].payload;
  await env.bot.handleUpdate({ update_type: 'message_callback', callback: { callback_id: 'answer-click', user: { user_id: 999 }, payload } });
  await env.bot.handleUpdate(message('owner-answer', 'Да', 999));
  env.owner.length = 0;
  const next = message('second', 'Есть розы?');
  await Promise.all([env.bot.handleUpdate(next), env.bot.handleUpdate({ ...next, timestamp: 2000 }), env.bot.handleUpdate(next)]);
  assert.equal(env.owner.length, 2); // Existing format: identity, then question with answer button.
  assert.match(env.owner[0].text, /Аня/);
  assert.match(env.owner[0].text, /\+7 \(999\) 123-45-67/);
  assert.match(env.owner[1].text, /Есть розы/);
  await env.bot.handleUpdate(message('third', 'Есть розы?'));
  assert.equal(env.owner.length, 4); // A genuinely new ID must not be suppressed.
});

test('separate storage instances atomically claim the same stable ID only once', async () => {
  const objects = new Set();
  const dependencies = {
    fs: {}, path: { join: () => 'unused' }, './config': { s3: { bucket: 'test' } },
    './objectStorage': { createJsonOnce: async (config, key) => {
      if (objects.has(key)) return false;
      objects.add(key); return true;
    } }
  };
  const first = load('bot/src/store.js', dependencies);
  const second = load('bot/src/store.js', dependencies);
  assert.deepEqual(await Promise.all([first.wasRecentlyProcessed('mid-1', true), second.wasRecentlyProcessed('mid-1', true)]), [false, true]);
  assert.equal(await second.wasRecentlyProcessed('mid-1', true), true);
  assert.equal(await second.wasRecentlyProcessed('mid-2', true), false);
});

test('conditional storage request uses If-None-Match and rejects storage failures', async () => {
  let status = 200, sentHeaders;
  const { EventEmitter } = require('node:events');
  const storage = load('bot/src/objectStorage.js', {
    https: { request: (options, callback) => {
      sentHeaders = options.headers;
      return { on() {}, write() {}, end() {
        const response = new EventEmitter(); response.statusCode = status;
        callback(response); response.emit('end');
      } };
    } }
  });
  const credentials = { bucket: 'test', accessKey: 'test', secretKey: 'test' };
  assert.equal(await storage.createJsonOnce(credentials, 'processed/test.json', {}), true);
  assert.equal(sentHeaders['If-None-Match'], '*');
  status = 412;
  assert.equal(await storage.createJsonOnce(credentials, 'processed/test.json', {}), false);
  status = 503;
  await assert.rejects(storage.createJsonOnce(credentials, 'processed/test.json', {}));
});
