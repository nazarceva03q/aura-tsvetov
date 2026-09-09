// Основная логика бота: разбор входящих апдейтов от Max и сценарий диалога
// (согласие на обработку данных → вопрос → телефон → свободная переписка
// с Олесей). Каталог/заказ/звонок из бота убраны — для этого на сайте есть
// обычная форма; бот в Max теперь работает только как канал связи с
// Олесей (согласие обязательно перед началом диалога, см. ТЗ).
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

// Кликабельная ссылка на профиль спрашивающего – через max://user/<id>
// (подтверждено документацией, формат упоминаний в markdown-сообщениях).
// Работает для ЛЮБОГО пользователя по одному user_id, публичный username
// для этого не нужен – раньше пробовали ссылку вида https://max.ru/<username>,
// но у большинства людей username вообще не задан, и ссылки не было.
// Отправляется ОТДЕЛЬНЫМ markdown-сообщением (а не вместе с текстом
// вопроса) – текст вопроса пишет сам покупатель и может случайно содержать
// символы вроде * или _, которые в markdown-режиме искажают вид сообщения.
async function sendAskerInfo(targetUserId, name, askerId, phone) {
  const label = name || ('Пользователь ' + askerId);
  const lines = [maxApi.userMention(label, askerId)];
  if (phone) lines.push('📞 ' + notify.formatPhone(phone));
  await maxApi.sendMarkdownMessage({ userId: targetUserId }, lines.join('\n'));
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

// ---------- вспомогательное ----------

function isValidPhone(rawPhone) {
  return notify.normalizePhone(rawPhone).length === 11;
}

// ---------- согласие на обработку персональных данных ----------

// Ссылка на «Согласие на обработку персональных данных» на сайте – тот же
// текст, что и в чекбоксе формы заказа на сайте (152-ФЗ). #doc=consent
// открывает этот документ напрямую (см. index.html, openFromSiteRef).
function consentUrl() {
  return config.siteBaseUrl + '/#doc=consent';
}

// Max не поддерживает настоящий чекбокс в клавиатуре бота (в отличие от
// формы на сайте) – ближайший рабочий аналог – кнопка-подтверждение
// («callback»), которую нужно нажать до того, как бот продолжит диалог.
function consentRows() {
  return [[maxApi.callbackButton('☑️ Согласен(на) на обработку персональных данных', 'consent:start')]];
}

async function sendGreeting(userId) {
  await store.setSession(userId, { step: 'awaiting_consent' });
  await maxApi.sendMessage(
    { userId },
    'Добрый день!\n\n' +
      'Чтобы начать диалог, пожалуйста, подтвердите согласие на обработку персональных данных ' +
      '(имя, телефон) в соответствии с 152-ФЗ.\n' +
      'Ознакомиться: ' + consentUrl(),
    consentRows()
  );
}

async function remindAboutConsent(userId) {
  await maxApi.sendMessage(
    { userId },
    'Чтобы продолжить, подтвердите, пожалуйста, согласие на обработку персональных данных — нажмите кнопку выше.',
    consentRows()
  );
}

async function proceedAfterConsent(userId) {
  await store.setSession(userId, { step: 'awaiting_message' });
  await maxApi.sendMessage({ userId }, 'Чем можем вам помочь? Ответим здесь в чате как можно скорее');
}

// ---------- служебный чат владелицы (MAX_OWNER_CHAT_ID) ----------
// Сюда приходят уведомления о заявках и пересланные вопросы – витрину
// магазина в этом чате не показываем, даже если она случайно что-то нажмёт.

async function sendOwnerGreeting(userId) {
  await maxApi.sendMessage(
    { userId },
    'Здравствуйте! Это служебный чат бота «Аура цветов» — сюда будут приходить вопросы покупателей. Витрина магазина здесь не открывается.'
  );
}

async function sendOwnerNotice(userId) {
  await maxApi.sendMessage(
    { userId },
    'Это служебный чат уведомлений — витрина магазина здесь не открывается. Ответить покупателю можно кнопкой «Ответить» под его вопросом.'
  );
}

// ---------- первый вопрос → запрос телефона → пересылка Олесе ----------

async function handleAwaitingMessage(update, userId, session) {
  const text = extractMessageText(update);
  if (!text || !text.trim()) {
    await maxApi.sendMessage({ userId }, 'Напишите, пожалуйста, ваш вопрос одним сообщением.');
    return;
  }

  session.step = 'awaiting_phone';
  session.pendingText = text.trim();
  await store.setSession(userId, session);

  await maxApi.sendMessage(
    { userId },
    'Чтобы передать ваш вопрос, поделитесь, пожалуйста, номером телефона.\n' +
      'Нажмите кнопку, чтобы поделиться номером одним тапом, либо просто напишите его в чат.',
    [[maxApi.requestContactButton('📱 Поделиться контактом')]]
  );
}

// Имя не спрашиваем отдельным шагом – берём то, что Max отдаёт сам
// (профиль пользователя или ФИО из vCard контакта), см. extractAutoName/
// parseVcfName. Если имени нет — Олесе просто не показываем строку «Имя».
async function handleAwaitingPhone(update, userId, session) {
  const contact = extractContact(update);
  const text = extractMessageText(update);
  const phone = contact && contact.phone ? contact.phone : text;

  if (!phone || !isValidPhone(phone)) {
    await maxApi.sendMessage(
      { userId },
      'Не получилось распознать номер. Отправьте его ещё раз, например: +7 999 123-45-67',
      [[maxApi.requestContactButton('📱 Поделиться контактом')]]
    );
    return;
  }

  const name = (contact && contact.name) || extractAutoName(update) || '';
  const normalizedPhone = notify.normalizePhone(phone);

  session.step = 'chatting';
  session.name = name;
  session.phone = normalizedPhone;
  const pendingText = session.pendingText;
  delete session.pendingText;
  await store.setSession(userId, session);

  await forwardToOwner(userId, pendingText, name, normalizedPhone);
  await maxApi.sendMessage(
    { userId },
    (name ? 'Спасибо, ' + name + '! ' : 'Спасибо! ') + 'Мы получили ваше сообщение, скоро ответим!'
  );
}

// После первого обмена (согласие + вопрос + телефон) клиент пишет свободно –
// каждое сообщение сразу уходит Олесе, без повторных запросов согласия/номера.
async function handleChatting(update, userId, session) {
  const text = extractMessageText(update);
  if (!text || !text.trim()) return;
  await forwardToOwner(userId, text.trim(), session.name, session.phone);
}

async function forwardToOwner(userId, text, name, phone) {
  if (!config.ownerChatId) {
    console.warn('[bot] MAX_OWNER_CHAT_ID не настроен, вопрос не переслан Олесе:', text);
    return;
  }
  const questionId = 'q' + Date.now();
  await store.saveQuestion(questionId, userId, text, name, phone);
  await sendAskerInfo(config.ownerChatId, name, userId, phone);
  await maxApi.sendMessage(
    { userId: config.ownerChatId },
    '❓ Вопрос: ' + text,
    [[maxApi.callbackButton('Ответить', 'answer:' + questionId)]]
  );
}

// Олеся нажала «Ответить» под вопросом
async function startAnswerFlow(ownerUserId, questionId) {
  const question = await store.getQuestion(questionId);
  if (!question) {
    await maxApi.sendMessage({ userId: ownerUserId }, 'Этот вопрос не найден — возможно, уже отвечен или устарел.');
    return;
  }
  await store.setSession(ownerUserId, { step: 'awaiting_answer', answeringQuestionId: questionId });
  await sendAskerInfo(ownerUserId, question.userName, question.userId, question.userPhone);
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

  // Клиенту приходит обычное сообщение без пометок «Ответ:» и без кнопок –
  // как если бы ей написал живой человек в чате (см. ТЗ).
  await maxApi.sendMessage({ userId: question.userId }, text.trim());
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
    // пересланные вопросы – без этой проверки бот вёл бы её через сценарий
    // согласия точно так же, как обычного покупателя. «Ответить» под
    // вопросом покупателя (answer:<id>) и сам ответ (шаг awaiting_answer) –
    // её законные действия, их не блокируем; всё остальное для неё –
    // заглушка ниже.
    const isOwner = Boolean(config.ownerChatId) && String(userId) === String(config.ownerChatId);

    // Команда /start – всегда возвращает к приветствию и заново запрашивает
    // согласие, из любого места сценария (это не отдельная всегда-видимая
    // кнопка в чате – в Max таких нет, см. README).
    if (update.update_type === 'message_created') {
      const cmdText = (extractMessageText(update) || '').trim().toLowerCase();
      if (cmdText === '/start') {
        await store.clearSession(userId);
        if (isOwner) return sendOwnerGreeting(userId);
        return sendGreeting(userId);
      }
    }

    if (update.update_type === 'bot_started') {
      if (isOwner) return sendOwnerGreeting(userId);
      return sendGreeting(userId);
    }

    if (update.update_type === 'message_callback') {
      const data = extractCallbackData(update);
      if (!data) {
        console.warn('[bot] message_callback без callback_data, апдейт целиком:', JSON.stringify(update));
        return;
      }

      // 'answer:' разрешён владелице всегда – это её кнопка под вопросом.
      if (data.indexOf('answer:') === 0) return startAnswerFlow(userId, data.slice('answer:'.length));

      if (isOwner) return sendOwnerNotice(userId);

      if (data === 'consent:start') return proceedAfterConsent(userId);
      // остальные callback'и в текущем сценарии не ожидаются – падаем в
      // обработку по шагу сессии ниже (там для message_callback ничего не
      // предусмотрено, апдейт будет тихо проигнорирован).
    }

    // – всё остальное (текстовые сообщения и не распознанные выше callback'и) –
    const session = await store.getSession(userId);

    if (isOwner && session.step !== 'awaiting_answer') {
      if (update.update_type === 'message_created') return sendOwnerNotice(userId);
      return;
    }

    switch (session.step) {
      case 'awaiting_consent':
        // Реально нельзя начать диалог без согласия – на любое сообщение
        // до нажатия кнопки просто напоминаем про неё, дальше сценарий не
        // пускаем.
        if (update.update_type === 'message_created') return remindAboutConsent(userId);
        return;
      case 'awaiting_message':
        return handleAwaitingMessage(update, userId, session);
      case 'awaiting_phone':
        return handleAwaitingPhone(update, userId, session);
      case 'chatting':
        return handleChatting(update, userId, session);
      case 'awaiting_answer':
        return handleAwaitingAnswer(update, userId, session);
      default:
        // Нет сессии (самое первое сообщение без bot_started, или сессию
        // сбросили) – начинаем с приветствия и согласия, как и в любом
        // другом месте без активного согласия.
        if (update.update_type === 'message_created') return sendGreeting(userId);
    }
  } catch (err) {
    console.error('[bot] ошибка обработки апдейта:', err, JSON.stringify(update));
  }
}

module.exports = { handleUpdate };
