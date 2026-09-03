// Основная логика бота: разбор входящих апдейтов от Max и сценарии диалога
// (главное меню → категории → заказ; «Заказать звонок»; «Задать вопрос»).
//
// ВАЖНО про разбор апдейтов: официально подтверждены только базовые поля
// Update-объекта (update_type, chat_id, user, timestamp) и типы событий
// (message_created, message_callback, bot_started, ...). Точные названия
// полей внутри message_callback (где лежит callback_data) и вложения
// message_created типа "contact" (когда пользователь делится номером) не
// были доступны при подготовке кода — ниже это разобрано защитно
// (проверяется несколько вероятных вариантов полей), и каждый необработанный
// апдейт логируется целиком. После первых реальных вебхуков от Max
// посмотрите логи сервера и, если что-то не распозналось, поправьте только
// функции extract*() в начале этого файла — остальной код трогать не нужно.

const config = require('./config');
const store = require('./store');
const catalog = require('./catalog');
const maxApi = require('./maxApi');
const notify = require('./notify');

// ---------- разбор апдейта (см. предупреждение выше) ----------

function extractUserId(update) {
  return (
    (update.user && update.user.user_id) ||
    (update.callback && update.callback.user && update.callback.user.user_id) ||
    (update.message && update.message.sender && update.message.sender.user_id) ||
    update.user_id ||
    null
  );
}

function extractAutoName(update) {
  const u = update.user || (update.message && update.message.sender) || null;
  if (!u) return null;
  const name = [u.first_name || u.name, u.last_name].filter(Boolean).join(' ').trim();
  return name || null;
}

// username – «уникальное публичное имя пользователя» (подтверждено
// документацией User-объекта), из него собирается ссылка на профиль
// https://max.ru/<username>. У части пользователей его нет (не задан) –
// тогда ссылки не будет, только имя и id.
function extractUsername(update) {
  const u = update.user || (update.message && update.message.sender) || null;
  return (u && u.username) || null;
}

// Единое представление «кто спрашивает» – используется и в первом
// пересланном вопросе, и повторно, когда Олеся жмёт «Ответить». Телефон
// сюда сознательно не добавляем: Max не отдаёт номер человека, который
// просто написал боту (User-объект такого поля не содержит) – телефон
// известен только если человек явно поделился контактом в форме заказа.
function formatAsker(name, userId, username) {
  let line = name || 'без имени в профиле';
  line += username ? ' — https://max.ru/' + username : ' (профиль без юзернейма)';
  line += '\nid: ' + userId;
  return line;
}

function extractCallbackData(update) {
  return (
    update.callback_data ||
    (update.callback && (update.callback.payload || update.callback.callback_data)) ||
    (update.update_type === 'message_callback' ? update.payload : null) ||
    null
  );
}

function extractMessageText(update) {
  return (update.message && update.message.body && update.message.body.text) || update.text || null;
}

// Кнопка request_contact присылает контакт как vCard-текст внутри
// payload.vcf_info (подтверждено документацией), например:
//   "BEGIN:VCARD\r\nVERSION:3.0\r\nTEL;TYPE=cell:79990000000\r\nFN:Иван Иванов\r\nEND:VCARD\r\n"
// Раньше здесь искали несуществующие payload.phone_number/payload.phone –
// поэтому кнопка «Поделиться контактом» не срабатывала.
function parseVcfPhone(vcf) {
  if (!vcf) return null;
  const m = vcf.match(/TEL[^:]*:([+\d][\d\s()-]*)/i);
  return m ? m[1].replace(/\s+/g, '') : null;
}
function parseVcfName(vcf) {
  if (!vcf) return null;
  const m = vcf.match(/FN:([^\r\n]+)/i);
  return m ? m[1].trim() : null;
}

function extractContact(update) {
  const attachments = (update.message && update.message.body && update.message.body.attachments) || [];
  const contactAtt = attachments.find((a) => a && a.type === 'contact');
  if (!contactAtt) return null;
  const payload = contactAtt.payload || contactAtt;
  const vcf = payload.vcf_info || payload.vcf || null;
  return {
    phone: parseVcfPhone(vcf) || payload.phone_number || payload.phone || null,
    name: parseVcfName(vcf) || payload.name || null
  };
}

function extractStartPayload(update) {
  return update.payload || update.start_payload || null;
}

// ---------- вспомогательное ----------

function isValidPhone(rawPhone) {
  return notify.normalizePhone(rawPhone).length === 11;
}

function categoryDisplayName(slug) {
  const c = catalog.getCategoryBySlug(slug);
  return c ? c.name : slug;
}

// Max не умеет в закреплённую кнопку-меню сбоку от переписки (в отличие от
// Telegram) – ближайший рабочий заменитель: кнопка «Меню» почти на каждом
// сообщении бота, чтобы она всегда была под рукой прямо в последнем
// сообщении, без необходимости листать назад или набирать /start. Не
// используется в служебном чате владелицы (там своя логика, см. isOwner) –
// там кнопка «В меню» открывала бы витрину, которую там как раз не
// показываем.
function withMenu(rows) {
  const r = rows ? rows.slice() : [];
  r.push([maxApi.callbackButton('🏠 Меню', 'menu:root')]);
  return r;
}

// ---------- главное меню ----------

const WELCOME_TEXT = 'Добрый день! Что вас интересует?';

function mainMenuRows() {
  const c = catalog.CATEGORIES;
  // По одной кнопке в строке – так они шире и название всегда видно целиком
  // (на узком экране 2-3 кнопки в ряд обрезали текст).
  return [
    [maxApi.callbackButton(c[0].emoji + ' ' + c[0].name, 'category:' + c[0].slug)],
    [maxApi.callbackButton(c[1].emoji + ' ' + c[1].name, 'category:' + c[1].slug)],
    [maxApi.callbackButton(c[2].emoji + ' ' + c[2].name, 'category:' + c[2].slug)],
    [maxApi.callbackButton('📞 Заказать звонок', 'menu:call')],
    [maxApi.callbackButton('💬 Задать вопрос', 'menu:question')]
  ];
}

async function sendMainMenu(userId) {
  await maxApi.sendMessage({ userId }, WELCOME_TEXT, mainMenuRows());
}

// ---------- служебный чат владелицы (MAX_OWNER_CHAT_ID) ----------
// Сюда приходят уведомления о заявках и пересланные вопросы – витрину
// магазина в этом чате не показываем, даже если она случайно что-то нажмёт.

async function sendOwnerGreeting(userId) {
  await maxApi.sendMessage(
    { userId },
    'Здравствуйте! Это служебный чат бота «Аура цветов» — сюда будут приходить уведомления о новых заявках и вопросы покупателей. Витрина магазина здесь не открывается.'
  );
}

async function sendOwnerNotice(userId) {
  await maxApi.sendMessage(
    { userId },
    'Это служебный чат уведомлений — витрина магазина здесь не открывается. Ответить покупателю можно кнопкой «Ответить» под его вопросом.'
  );
}

// ---------- категория → карточки товаров ----------

async function sendCategory(userId, slug) {
  const category = catalog.getCategoryBySlug(slug);
  if (!category) return sendMainMenu(userId);

  const products = catalog.getProductsByCategory(slug);
  var intro = category.emoji + ' ' + category.name + ' — выберите, что понравится:';
  if (category.note) intro = category.emoji + ' ' + category.name + ' — ' + category.note + ':';
  await maxApi.sendMessage({ userId }, intro);

  // Фото загружены заранее в Max и переиспользуются по токену – см.
  // scripts/sync-photos.js и src/photoTokens.json. Если для товара пока нет
  // токена (фото не синхронизировали), карточка уходит без фото, просто
  // текстом – ничего не падает.
  for (const p of products) {
    await maxApi.sendMessage(
      { userId },
      p.name + '\n' + p.price,
      withMenu([[maxApi.callbackButton('Хочу такой', 'order:' + p.id)]]),
      p.photoToken
    );
  }
}

// ---------- сценарий заказа (после «Хочу такой») ----------

// Ссылка на «Согласие на обработку персональных данных» на сайте – тот же
// текст, что и в чекбоксе формы заказа на сайте (152-ФЗ). #doc=consent
// открывает этот документ напрямую (см. index.html, openFromSiteRef).
function consentUrl() {
  return config.siteBaseUrl + '/#doc=consent';
}

async function startOrderFlow(userId, productId) {
  const product = catalog.getProductById(productId);
  if (!product) return sendMainMenu(userId);

  await store.setSession(userId, {
    step: 'order_awaiting_consent',
    order: {
      productId: product.id,
      productName: product.name,
      category: product.category,
      siteRef: catalog.siteRefFor(product)
    }
  });

  await maxApi.sendMessage(
    userId ? { userId } : {},
    'Для оформления заказа нужно ваше согласие на обработку персональных данных (имя, телефон) в соответствии с 152-ФЗ.\n' +
      'Ознакомиться: ' + consentUrl(),
    withMenu([[maxApi.callbackButton('✅ Согласен(на)', 'consent:order')]])
  );
}

async function proceedToOrderContact(userId) {
  const session = await store.getSession(userId);
  if (session.step !== 'order_awaiting_consent' || !session.order) return sendMainMenu(userId);
  session.step = 'order_awaiting_contact';
  await store.setSession(userId, session);

  await maxApi.sendMessage(
    userId ? { userId } : {},
    'Отлично! Оставьте, пожалуйста, имя и телефон, и мы уточним детали.\n🎁 Скидка 10% на первый заказ\n\n' +
      'Нажмите кнопку, чтобы поделиться номером одним тапом, либо просто напишите его в чат.',
    withMenu([[maxApi.requestContactButton('📱 Поделиться контактом')]])
  );
}

async function handleOrderAwaitingContact(update, userId, session) {
  const contact = extractContact(update);
  const text = extractMessageText(update);

  let phone = null;
  let contactName = null;
  if (contact && contact.phone) {
    phone = contact.phone;
    contactName = contact.name;
  } else if (text && isValidPhone(text)) {
    phone = text;
  } else {
    await maxApi.sendMessage(
      { userId },
      'Не получилось распознать номер. Отправьте его ещё раз, например: +7 999 123-45-67',
      withMenu()
    );
    return;
  }

  session.order.phone = notify.normalizePhone(phone);
  const autoName = contactName || extractAutoName(update);

  if (autoName) {
    session.order.autoName = autoName;
    session.step = 'order_awaiting_name';
    await store.setSession(userId, session);
    await maxApi.sendMessage(
      { userId },
      'Ваше имя: ' + autoName + '. Всё верно?\n\nЕсли нет — просто напишите, как к вам обращаться.',
      withMenu([[maxApi.callbackButton('✅ Всё верно', 'name_confirm')]])
    );
  } else {
    session.step = 'order_awaiting_name';
    await store.setSession(userId, session);
    await maxApi.sendMessage({ userId }, 'Как вас зовут?', withMenu());
  }
}

async function finishOrder(userId, name, session) {
  const order = session.order;
  await notify.sendLeadNotification({
    source: 'Бот Max → ' + categoryDisplayName(order.category),
    name,
    phone: order.phone,
    productId: order.productId,
    productName: order.productName,
    siteRef: order.siteRef
  });
  await maxApi.sendMessage(
    { userId },
    'Спасибо, ' + name + '! Свяжемся с вами в ближайшее время',
    withMenu()
  );
  await store.clearSession(userId);
}

async function handleOrderAwaitingName(update, userId, session) {
  const callbackData = extractCallbackData(update);
  const text = extractMessageText(update);

  if (callbackData === 'name_confirm' && session.order.autoName) {
    await finishOrder(userId, session.order.autoName, session);
    return;
  }
  if (text && text.trim()) {
    await finishOrder(userId, text.trim(), session);
    return;
  }
  await maxApi.sendMessage({ userId }, 'Напишите, пожалуйста, ваше имя одним сообщением.', withMenu());
}

// ---------- «Заказать звонок» ----------

async function startCallFlow(userId) {
  await store.setSession(userId, { step: 'call_awaiting_consent' });
  await maxApi.sendMessage(
    { userId },
    'Для звонка нужно ваше согласие на обработку персональных данных (телефон) в соответствии с 152-ФЗ.\n' +
      'Ознакомиться: ' + consentUrl(),
    withMenu([[maxApi.callbackButton('✅ Согласен(на)', 'consent:call')]])
  );
}

async function proceedToCallContact(userId) {
  await store.setSession(userId, { step: 'call_awaiting_contact' });
  await maxApi.sendMessage(
    { userId },
    'Оставьте номер, перезвоним в течение часа. 🎁 Скидка 10% на первый заказ',
    withMenu([[maxApi.requestContactButton('📱 Поделиться контактом')]])
  );
}

async function handleCallAwaitingContact(update, userId) {
  const contact = extractContact(update);
  const text = extractMessageText(update);
  let phone = contact && contact.phone ? contact.phone : text;

  if (!phone || !isValidPhone(phone)) {
    await maxApi.sendMessage(
      { userId },
      'Не получилось распознать номер. Отправьте его ещё раз, например: +7 999 123-45-67',
      withMenu()
    );
    return;
  }

  await notify.sendLeadNotification({
    source: 'Заказать звонок',
    phone,
    interestedIn: 'просит перезвонить'
  });
  await maxApi.sendMessage({ userId }, 'Спасибо! Скоро перезвоним', withMenu());
  await store.clearSession(userId);
}

// ---------- «Задать вопрос» ----------

async function startQuestionFlow(userId) {
  await store.setSession(userId, { step: 'awaiting_question' });
  await maxApi.sendMessage({ userId }, 'Напишите ваш вопрос, ответим как можно скорее', withMenu());
}

// Покупатель нажал «Ответить» под ответом Олеси – продолжаем тот же вопрос
// (activeQuestionId), а не заводим новый с нуля.
async function startReplyFlow(userId, questionId) {
  await store.setSession(userId, { step: 'awaiting_question', activeQuestionId: questionId });
  await maxApi.sendMessage({ userId }, 'Напишите сообщение:', withMenu());
}

async function handleAwaitingQuestion(update, userId, session) {
  const text = extractMessageText(update);
  if (!text || !text.trim()) {
    await maxApi.sendMessage({ userId }, 'Напишите вопрос одним сообщением, пожалуйста.', withMenu());
    return;
  }

  // Если это продолжение диалога (кнопка «Ответить» у покупателя) – пишем в
  // ту же карточку вопроса, иначе заводим новую.
  const questionId = (session && session.activeQuestionId) || 'q' + Date.now();
  const askerName = extractAutoName(update);
  const askerUsername = extractUsername(update);
  await store.saveQuestion(questionId, userId, text.trim(), askerName, askerUsername);

  if (config.ownerChatId) {
    await maxApi.sendMessage(
      { userId: config.ownerChatId },
      formatAsker(askerName, userId, askerUsername) + '\n\n💬 Вопрос: ' + text.trim(),
      [[maxApi.callbackButton('Ответить', 'answer:' + questionId)]]
    );
  } else {
    console.warn('[bot] MAX_OWNER_CHAT_ID не настроен, вопрос не переслан Олесе:', text.trim());
  }

  await maxApi.sendMessage({ userId }, 'Спасибо, передали ваш вопрос!', withMenu());
  await store.clearSession(userId);
}

// Олеся нажала «Ответить» под вопросом
async function startAnswerFlow(ownerUserId, questionId) {
  const question = await store.getQuestion(questionId);
  if (!question) {
    await maxApi.sendMessage({ userId: ownerUserId }, 'Этот вопрос не найден — возможно, уже отвечен или устарел.');
    return;
  }
  await store.setSession(ownerUserId, { step: 'awaiting_answer', answeringQuestionId: questionId });
  await maxApi.sendMessage(
    { userId: ownerUserId },
    formatAsker(question.userName, question.userId, question.username) + '\n\nНапишите текст ответа:'
  );
}

async function handleAwaitingAnswer(update, ownerUserId, session) {
  const text = extractMessageText(update);
  if (!text || !text.trim()) {
    await maxApi.sendMessage({ userId: ownerUserId }, 'Напишите ответ одним сообщением, пожалуйста.');
    return;
  }
  const question = await store.getQuestion(session.answeringQuestionId);
  if (!question) {
    await maxApi.sendMessage({ userId: ownerUserId }, 'Не нашла исходный вопрос — возможно, он устарел.');
    await store.clearSession(ownerUserId);
    return;
  }

  // «Ответить» под ответом – чтобы покупатель мог продолжить диалог или
  // просто написать «Спасибо», не начиная вопрос с нуля.
  await maxApi.sendMessage(
    { userId: question.userId },
    '💬 Ответ на ваш вопрос:\n\n' + text.trim(),
    withMenu([[maxApi.callbackButton('Ответить', 'reply:' + session.answeringQuestionId)]])
  );
  await store.markQuestionAnswered(session.answeringQuestionId);
  await maxApi.sendMessage({ userId: ownerUserId }, 'Ответ отправлен!');
  await store.clearSession(ownerUserId);
}

// ---------- диспетчер апдейтов ----------

async function handleUpdate(update) {
  try {
    const userId = extractUserId(update);
    if (!userId) {
      console.warn('[bot] апдейт без определяемого user_id, пропущено:', JSON.stringify(update));
      return;
    }

    // Защита от повторной доставки одного и того же события Max (см.
    // store.wasRecentlyProcessed) – без этого при медленном ответе функции
    // Max мог прислать апдейт повторно, и Олеся получала один и тот же
    // вопрос/ответ по нескольку раз подряд.
    const dedupKey =
      update.update_type + ':' + userId + ':' +
      (extractCallbackData(update) || extractMessageText(update) || '') + ':' +
      (update.timestamp || '');
    if (await store.wasRecentlyProcessed(dedupKey)) {
      console.log('[bot] дубликат апдейта, пропущено:', dedupKey);
      return;
    }

    // Печатаем user_id для КАЖДОГО апдейта (не только bot_started) – это
    // единственный способ узнать chat_id Олеси для MAX_OWNER_CHAT_ID (бот не
    // может писать первым). Если её первое «Начать» пришлось на момент, когда
    // функция ещё падала на импорте, bot_started мог не долететь до этой
    // точки кода вообще – а любое следующее нажатие кнопки/сообщение всё
    // равно попадёт в этот лог.
    console.log('[bot] update_type=' + update.update_type + ', user_id=' + userId);

    // Олеся (MAX_OWNER_CHAT_ID) пишет боту в тот же чат, куда приходят
    // уведомления о заявках – без этой проверки бот показывал бы ей витрину
    // магазина точно так же, как обычному покупателю, стоит ей случайно
    // нажать кнопку или что-то написать. «Ответить» под вопросом покупателя
    // (answer:<id>) и сам ответ (шаг awaiting_answer) – её законные действия,
    // их не блокируем; всё остальное для неё – заглушка ниже.
    const isOwner = Boolean(config.ownerChatId) && String(userId) === String(config.ownerChatId);

    // Команда /start (Max показывает её подсказкой при вводе «/» — см.
    // scripts/set-commands.js) – всегда возвращает в главное меню, из
    // любого места сценария, не мешая при этом обычной переписке (это не
    // отдельная всегда-видимая кнопка в чате – в Max таких нет, см. README).
    if (update.update_type === 'message_created') {
      const cmdText = (extractMessageText(update) || '').trim().toLowerCase();
      if (cmdText === '/start' || cmdText === '/menu') {
        await store.clearSession(userId);
        if (isOwner) return sendOwnerGreeting(userId);
        await sendMainMenu(userId);
        return;
      }
    }

    if (update.update_type === 'bot_started') {
      const payload = extractStartPayload(update);
      if (payload) console.log('[bot] deep-link payload=' + payload);
      if (isOwner) return sendOwnerGreeting(userId);
      await sendMainMenu(userId);
      return;
    }

    if (update.update_type === 'message_callback') {
      const data = extractCallbackData(update);
      if (!data) {
        console.warn('[bot] message_callback без callback_data, апдейт целиком:', JSON.stringify(update));
        return;
      }

      // 'answer:' разрешён владелице всегда – это её кнопка под вопросом.
      if (data.indexOf('answer:') === 0) return startAnswerFlow(userId, data.slice('answer:'.length));
      // 'reply:' – покупатель продолжает диалог под ответом Олеси.
      if (data.indexOf('reply:') === 0) return startReplyFlow(userId, data.slice('reply:'.length));

      if (isOwner) return sendOwnerNotice(userId);

      // Префиксы разных типов кнопок НЕ должны пересекаться (раньше 'menu:call'
      // и 'menu:question' перехватывались общей проверкой data.indexOf('menu:'),
      // предназначенной для категорий, и уходили в sendCategory с несуществующим
      // слагом 'call'/'question' – отсюда и отдельный префикс 'category:').
      if (data === 'menu:root') return sendMainMenu(userId);
      if (data === 'menu:call') return startCallFlow(userId);
      if (data === 'menu:question') return startQuestionFlow(userId);
      if (data.indexOf('category:') === 0) return sendCategory(userId, data.slice('category:'.length));
      if (data.indexOf('order:') === 0) return startOrderFlow(userId, data.slice('order:'.length));
      if (data === 'consent:order') return proceedToOrderContact(userId);
      if (data === 'consent:call') return proceedToCallContact(userId);

      // name_confirm обрабатывается ниже, внутри шага order_awaiting_name –
      // callback тоже проходит через сессионный switch, поэтому падаем туда же.
    }

    // – всё остальное (текстовые сообщения и оставшиеся callback'и вроде
    //   name_confirm) разбирается по текущему шагу сессии пользователя –
    const session = await store.getSession(userId);

    if (isOwner && session.step !== 'awaiting_answer') {
      if (update.update_type === 'message_created') return sendOwnerNotice(userId);
      return;
    }

    switch (session.step) {
      case 'order_awaiting_consent':
        if (update.update_type === 'message_created') {
          return maxApi.sendMessage(
            { userId },
            'Чтобы продолжить оформление, нажмите «✅ Согласен(на)» выше.',
            withMenu()
          );
        }
        return;
      case 'call_awaiting_consent':
        if (update.update_type === 'message_created') {
          return maxApi.sendMessage(
            { userId },
            'Чтобы продолжить, нажмите «✅ Согласен(на)» выше.',
            withMenu()
          );
        }
        return;
      case 'order_awaiting_contact':
        return handleOrderAwaitingContact(update, userId, session);
      case 'order_awaiting_name':
        return handleOrderAwaitingName(update, userId, session);
      case 'call_awaiting_contact':
        return handleCallAwaitingContact(update, userId);
      case 'awaiting_question':
        return handleAwaitingQuestion(update, userId, session);
      case 'awaiting_answer':
        return handleAwaitingAnswer(update, userId, session);
      default:
        // Свободный текст без активного сценария – не оставляем пользователя
        // в тупике, показываем меню ещё раз. (isOwner сюда не попадает –
        // отсечено проверкой выше.)
        if (update.update_type === 'message_created') {
          await maxApi.sendMessage({ userId }, 'Не совсем поняла 🙂 Вот, что я умею:');
          await sendMainMenu(userId);
        }
    }
  } catch (err) {
    console.error('[bot] ошибка обработки апдейта:', err, JSON.stringify(update));
  }
}

module.exports = { handleUpdate, sendMainMenu };
