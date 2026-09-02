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

function extractContact(update) {
  const attachments = (update.message && update.message.body && update.message.body.attachments) || [];
  const contactAtt = attachments.find((a) => a && a.type === 'contact');
  if (!contactAtt) return null;
  const payload = contactAtt.payload || contactAtt;
  return {
    phone: payload.phone_number || payload.phone || payload.vcf_phone || null,
    name: payload.name || payload.first_name || null
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

// ---------- главное меню ----------

const WELCOME_TEXT = 'Добрый день! Что вас интересует?';

function mainMenuRows() {
  const c = catalog.CATEGORIES;
  return [
    [
      maxApi.callbackButton(c[0].emoji + ' ' + c[0].name + ' от ' + c[0].fromPrice, 'category:' + c[0].slug),
      maxApi.callbackButton(c[1].emoji + ' ' + c[1].name + ' от ' + c[1].fromPrice, 'category:' + c[1].slug)
    ],
    [
      maxApi.callbackButton(c[2].emoji + ' ' + c[2].name + ' от ' + c[2].fromPrice, 'category:' + c[2].slug),
      maxApi.callbackButton('📞 Заказать звонок', 'menu:call'),
      maxApi.callbackButton('💬 Задать вопрос', 'menu:question')
    ]
  ];
}

async function sendMainMenu(userId) {
  await maxApi.sendMessage({ userId }, WELCOME_TEXT, mainMenuRows());
}

// ---------- категория → карточки товаров ----------

async function sendCategory(userId, slug) {
  const category = catalog.getCategoryBySlug(slug);
  if (!category) return sendMainMenu(userId);

  const products = catalog.getProductsByCategory(slug);
  await maxApi.sendMessage({ userId }, category.emoji + ' ' + category.name + ' — выберите, что понравится:');

  // Фото у товаров пока не отправляем: на сайте фото хранятся как data-URI
  // прямо в HTML, отдельных публичных ссылок на картинки нет. Как только
  // появится хостинг изображений (например, Yandex Object Storage), сюда
  // легко добавить attachments типа "image" — структура карточек уже готова.
  for (const p of products) {
    await maxApi.sendMessage(
      { userId },
      p.name + '\n' + p.price,
      [[maxApi.callbackButton('Хочу такой', 'order:' + p.id)]]
    );
  }

  await maxApi.sendMessage({ userId }, ' ', [[maxApi.callbackButton('⬅️ В меню', 'menu:root')]]);
}

// ---------- сценарий заказа (после «Хочу такой») ----------

async function startOrderFlow(userId, productId) {
  const product = catalog.getProductById(productId);
  if (!product) return sendMainMenu(userId);

  await store.setSession(userId, {
    step: 'order_awaiting_contact',
    order: {
      productId: product.id,
      productName: product.name,
      category: product.category,
      siteRef: catalog.siteRefFor(product)
    }
  });

  await maxApi.sendMessage(
    userId ? { userId } : {},
    'Отлично! Оставьте, пожалуйста, имя и телефон, и мы уточним детали. 🎁 Скидка 10% на первый заказ\n\n' +
      'Нажмите кнопку, чтобы поделиться номером одним тапом, либо просто напишите его в чат.',
    [[maxApi.requestContactButton('📱 Поделиться контактом')]]
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
      'Не получилось распознать номер. Отправьте его ещё раз, например: +7 999 123-45-67'
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
      [[maxApi.callbackButton('✅ Всё верно', 'name_confirm')]]
    );
  } else {
    session.step = 'order_awaiting_name';
    await store.setSession(userId, session);
    await maxApi.sendMessage({ userId }, 'Как вас зовут?');
  }
}

async function finishOrder(userId, name, session) {
  const order = session.order;
  await notify.sendLeadNotification({
    source: 'Бот Max → ' + categoryDisplayName(order.category),
    name,
    phone: order.phone,
    productName: order.productName,
    siteRef: order.siteRef
  });
  await maxApi.sendMessage(
    { userId },
    'Спасибо, ' + name + '! Свяжемся с вами в ближайшее время, а перед отправкой пришлём фото букета'
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
  await maxApi.sendMessage({ userId }, 'Напишите, пожалуйста, ваше имя одним сообщением.');
}

// ---------- «Заказать звонок» ----------

async function startCallFlow(userId) {
  await store.setSession(userId, { step: 'call_awaiting_contact' });
  await maxApi.sendMessage(
    { userId },
    'Оставьте номер, перезвоним в течение часа. 🎁 Скидка 10% на первый заказ',
    [[maxApi.requestContactButton('📱 Поделиться контактом')]]
  );
}

async function handleCallAwaitingContact(update, userId) {
  const contact = extractContact(update);
  const text = extractMessageText(update);
  let phone = contact && contact.phone ? contact.phone : text;

  if (!phone || !isValidPhone(phone)) {
    await maxApi.sendMessage(
      { userId },
      'Не получилось распознать номер. Отправьте его ещё раз, например: +7 999 123-45-67'
    );
    return;
  }

  await notify.sendLeadNotification({
    source: 'Заказать звонок',
    phone,
    interestedIn: 'просит перезвонить'
  });
  await maxApi.sendMessage({ userId }, 'Спасибо! Скоро перезвоним');
  await store.clearSession(userId);
}

// ---------- «Задать вопрос» ----------

async function startQuestionFlow(userId) {
  await store.setSession(userId, { step: 'awaiting_question' });
  await maxApi.sendMessage({ userId }, 'Напишите ваш вопрос, ответим как можно скорее');
}

async function handleAwaitingQuestion(update, userId) {
  const text = extractMessageText(update);
  if (!text || !text.trim()) {
    await maxApi.sendMessage({ userId }, 'Напишите вопрос одним сообщением, пожалуйста.');
    return;
  }

  const questionId = 'q' + Date.now();
  await store.saveQuestion(questionId, userId, text.trim());

  if (config.ownerChatId) {
    await maxApi.sendMessage(
      { userId: config.ownerChatId },
      '💬 Вопрос: ' + text.trim(),
      [[maxApi.callbackButton('Ответить', 'answer:' + questionId)]]
    );
  } else {
    console.warn('[bot] MAX_OWNER_CHAT_ID не настроен, вопрос не переслан Олесе:', text.trim());
  }

  await maxApi.sendMessage({ userId }, 'Спасибо, передали ваш вопрос!');
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
  await maxApi.sendMessage({ userId: ownerUserId }, 'Напишите текст ответа:');
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

  await maxApi.sendMessage({ userId: question.userId }, '💬 Ответ на ваш вопрос:\n\n' + text.trim());
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

    if (update.update_type === 'bot_started') {
      const payload = extractStartPayload(update);
      // Печатаем user_id заметно – это единственный способ узнать chat_id
      // Олеси для MAX_OWNER_CHAT_ID (бот не может писать первым, поэтому
      // узнать id можно только после того, как человек сам нажал «Начать»).
      console.log('[bot] bot_started: user_id=' + userId + (payload ? ', deep-link payload=' + payload : ''));
      await sendMainMenu(userId);
      return;
    }

    if (update.update_type === 'message_callback') {
      const data = extractCallbackData(update);
      if (!data) {
        console.warn('[bot] message_callback без callback_data, апдейт целиком:', JSON.stringify(update));
        return;
      }

      // Префиксы разных типов кнопок НЕ должны пересекаться (раньше 'menu:call'
      // и 'menu:question' перехватывались общей проверкой data.indexOf('menu:'),
      // предназначенной для категорий, и уходили в sendCategory с несуществующим
      // слагом 'call'/'question' – отсюда и отдельный префикс 'category:').
      if (data === 'menu:root') return sendMainMenu(userId);
      if (data === 'menu:call') return startCallFlow(userId);
      if (data === 'menu:question') return startQuestionFlow(userId);
      if (data.indexOf('category:') === 0) return sendCategory(userId, data.slice('category:'.length));
      if (data.indexOf('order:') === 0) return startOrderFlow(userId, data.slice('order:'.length));
      if (data.indexOf('answer:') === 0) return startAnswerFlow(userId, data.slice('answer:'.length));

      // name_confirm обрабатывается ниже, внутри шага order_awaiting_name –
      // callback тоже проходит через сессионный switch, поэтому падаем туда же.
    }

    // – всё остальное (текстовые сообщения и оставшиеся callback'и вроде
    //   name_confirm) разбирается по текущему шагу сессии пользователя –
    const session = await store.getSession(userId);

    switch (session.step) {
      case 'order_awaiting_contact':
        return handleOrderAwaitingContact(update, userId, session);
      case 'order_awaiting_name':
        return handleOrderAwaitingName(update, userId, session);
      case 'call_awaiting_contact':
        return handleCallAwaitingContact(update, userId);
      case 'awaiting_question':
        return handleAwaitingQuestion(update, userId);
      case 'awaiting_answer':
        return handleAwaitingAnswer(update, userId, session);
      default:
        // Свободный текст без активного сценария – не оставляем пользователя
        // в тупике, показываем меню ещё раз.
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
