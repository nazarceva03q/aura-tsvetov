// Управление каталогом сайта из чата Max — доступно только владелице
// (MAX_OWNER_CHAT_ID, см. bot/src/bot.js — isOwner). Сценарии:
//   – меню (Добавить / Изменить / Удалить товар, Заявки)
//   – добавление товара (категория → название → цена → состав → фото →
//     предпросмотр с кнопками «Изменить» на каждую строку → «Сохранить»)
//   – изменение/удаление товара (поиск по названию среди уже существующих
//     товаров → «Этот товар» → тот же экран предпросмотра, что и при
//     добавлении, либо подтверждение удаления)
//   – «Заявки» – список заказов с сайта и вопросов из чата (bot/src/store.js,
//     saveLead/getLeadsPage), с кнопкой «Показать ещё»
//
// ВАЖНО про «бургер-меню»: в Max нет постоянно видимой в интерфейсе кнопки
// меню (в отличие от Telegram) – это подтверждённое ограничение платформы,
// уже описанное в bot.js. Ближайший рабочий аналог – кнопка «⬅️ В меню»,
// которая добавляется почти к каждому сообщению бота на каждом шаге, плюс
// команда /start, которая тоже всегда возвращает в меню (см. bot.js). Так
// меню фактически «всегда под рукой», просто не в виде отдельного элемента
// интерфейса Max, а как обычная кнопка внутри последнего сообщения бота.
//
// ВАЖНО про формат фото-вложений: ни формат ВХОДЯЩЕГО фото-вложения
// (message.body.attachments[].payload.url), ни формат ИСХОДЯЩЕГО фото по
// прямой ссылке (см. maxApi.sendPhotoUrlMessage) не были подтверждены живым
// запросом на момент написания кода (см. предупреждения в самих функциях).
// Всё разобрано защитно, с логированием сырого апдейта при неудаче —
// после первого реального теста смотрите логи функции в консоли Yandex
// Cloud и, если что-то называется иначе, правьте только
// extractPhotoAttachments() ниже (остальной код трогать не нужно).

const maxApi = require('./maxApi');
const store = require('./store');
const products = require('./products');

const FIELD_ORDER = ['name', 'price', 'composition', 'photos'];

function isAdminStep(step) {
  return typeof step === 'string' && step.indexOf('admin_') === 0;
}

function backRow() {
  return [maxApi.callbackButton('⬅️ В меню', 'admin:menu')];
}

// Защита от нажатия УСТАРЕВШЕЙ кнопки — Max не убирает кнопки из старых
// сообщений в истории чата, поэтому Олеся технически может нажать,
// например, «✏️ Название» под уже сохранённым/отменённым товаром, когда
// текущая сессия — снова меню (без черновика). Без этой проверки такие
// обработчики упали бы (session.draft.* от undefined) — вместо этого
// просто вежливо просим начать заново.
async function requireDraft(userId, session) {
  if (session && session.draft && typeof session.draft === 'object') return true;
  await sendMenu(userId, 'Эта кнопка уже устарела (черновик товара не сохранился). Начните заново:');
  return false;
}

function menuRows() {
  return [
    [maxApi.callbackButton('➕ Добавить товар', 'admin:add')],
    [maxApi.callbackButton('✏️ Изменить товар', 'admin:edit')],
    [maxApi.callbackButton('🗑 Удалить товар', 'admin:delete')],
    [maxApi.callbackButton('📋 Заявки', 'admin:leads')]
  ];
}

async function sendMenu(userId, text) {
  await store.setSession(userId, { step: 'admin_idle' });
  await maxApi.sendMessage(
    { userId },
    text || 'Здравствуйте! Это бот управления магазином «Аура цветов». Выберите действие:',
    menuRows()
  );
}

// ---------- добавление / изменение товара (общий экран предпросмотра) ----------

function fieldPrompt(field) {
  if (field === 'name') return 'Напишите название товара';
  if (field === 'price') return 'Напишите цену со знаком ₽';
  if (field === 'composition') {
    return 'Напишите состав букета по пунктам (каждый пункт с новой строки).\n' +
      'Если состав не нужно описывать, поставьте прочерк -.';
  }
  if (field === 'photos') return 'Загрузите одно или несколько фото товара. Когда закончите — нажмите «Готово».';
  return 'Напишите значение';
}

function stepForField(field) {
  return 'admin_field_' + field;
}

function photoStepRows() {
  return [[maxApi.callbackButton('✅ Готово', 'photos:done')], backRow()];
}

async function startAdd(userId) {
  const rows = products.CATEGORY_NAMES.map((name, i) => [maxApi.callbackButton(name, 'add:cat:' + i)]);
  rows.push(backRow());
  await store.setSession(userId, { step: 'admin_add_category', adminAction: 'add', draft: { id: null, photos: [] } });
  await maxApi.sendMessage({ userId }, 'Выберите категорию товара на сайте:', rows);
}

async function pickCategory(userId, session, categoryIndex) {
  if (!(await requireDraft(userId, session))) return;
  const category = products.CATEGORY_NAMES[categoryIndex];
  if (!category) {
    await maxApi.sendMessage({ userId }, 'Не поняла выбор категории, попробуйте ещё раз.');
    return;
  }
  session.draft.category = category;
  if (session.editingFromPreview) {
    session.editingFromPreview = false;
    session.step = 'admin_preview';
    await store.setSession(userId, session);
    await sendPreview(userId, session);
    return;
  }
  session.step = stepForField('name');
  await store.setSession(userId, session);
  await maxApi.sendMessage({ userId }, fieldPrompt('name'), [backRow()]);
}

function parseComposition(text) {
  if (/^-+$/.test(text.trim())) return [];
  return text
    .split('\n')
    .map((line) => line.replace(/^[\s•*-]+/, '').trim())
    .filter(Boolean);
}

async function advanceAfterField(userId, session, field) {
  if (session.editingFromPreview) {
    session.editingFromPreview = false;
    session.step = 'admin_preview';
    await store.setSession(userId, session);
    await sendPreview(userId, session);
    return;
  }
  const next = FIELD_ORDER[FIELD_ORDER.indexOf(field) + 1];
  if (!next) {
    session.step = 'admin_preview';
    await store.setSession(userId, session);
    await sendPreview(userId, session);
    return;
  }
  session.step = stepForField(next);
  await store.setSession(userId, session);
  await maxApi.sendMessage({ userId }, fieldPrompt(next), next === 'photos' ? photoStepRows() : [backRow()]);
}

async function handleTextField(userId, session, field, text) {
  if (!text || !text.trim()) {
    await maxApi.sendMessage({ userId }, 'Напишите текст, пожалуйста.', [backRow()]);
    return;
  }
  const value = text.trim();
  if (field === 'name') {
    session.draft.name = value;
  } else if (field === 'price') {
    if (!/\d/.test(value)) {
      await maxApi.sendMessage({ userId }, 'Не вижу цифр в цене. Напишите ещё раз, например: 2500 ₽', [backRow()]);
      return;
    }
    session.draft.price = value.indexOf('₽') !== -1 ? value : value + ' ₽';
  } else if (field === 'composition') {
    session.draft.composition = parseComposition(value);
  }
  await advanceAfterField(userId, session, field);
}

// Разбор входящих фото-вложений — см. предупреждение в шапке файла.
function extractPhotoAttachments(update) {
  const attachments = (update.message && update.message.body && update.message.body.attachments) || [];
  const photoAtts = attachments.filter((a) => a && a.type === 'image');
  const urls = [];
  photoAtts.forEach((a) => {
    const payload = a.payload || a;
    let url = payload.url || null;
    if (!url && payload.photos && typeof payload.photos === 'object') {
      const first = Object.values(payload.photos)[0];
      if (first && first.url) url = first.url;
    }
    if (url) urls.push(url);
  });
  if (photoAtts.length && !urls.length) {
    console.warn('[admin] фото-вложение без распознанного URL, апдейт целиком:', JSON.stringify(update));
  }
  return urls;
}

async function handlePhotosStep(update, userId, session) {
  const urls = extractPhotoAttachments(update);
  if (!urls.length) {
    await maxApi.sendMessage({ userId }, 'Пришлите фото товара (одно или несколько) или нажмите «Готово».', photoStepRows());
    return;
  }
  session.draft.photos = session.draft.photos || [];
  for (const url of urls) {
    try {
      const { buffer, contentType } = await maxApi.downloadBinary(url);
      const publicUrl = await products.uploadPhoto(buffer, contentType);
      if (publicUrl) session.draft.photos.push(publicUrl);
      else await maxApi.sendMessage({ userId }, '⚠️ Не удалось сохранить фото, попробуйте прислать ещё раз.');
    } catch (e) {
      console.error('[admin] ошибка загрузки фото:', e.message);
      await maxApi.sendMessage({ userId }, '⚠️ Не удалось загрузить фото, попробуйте ещё раз.');
    }
  }
  await store.setSession(userId, session);
  const count = session.draft.photos.length;
  await maxApi.sendMessage({ userId }, 'Фото добавлено (' + count + ' шт.). Пришлите ещё или нажмите «Готово».', photoStepRows());
}

async function finishPhotos(userId, session) {
  if (!(await requireDraft(userId, session))) return;
  const count = (session.draft.photos || []).length;
  if (!count) {
    await maxApi.sendMessage({ userId }, 'Нужно хотя бы одно фото. Пришлите фото товара.', photoStepRows());
    return;
  }
  await advanceAfterField(userId, session, 'photos');
}

// ---------- предпросмотр ----------

function formatPreviewText(draft) {
  const lines = ['Проверьте товар перед публикацией:', '', 'Категория: ' + draft.category, 'Название: ' + draft.name, 'Цена: ' + draft.price];
  if (draft.composition && draft.composition.length) {
    lines.push('Состав:');
    draft.composition.forEach((line) => lines.push('• ' + line));
  } else {
    lines.push('Состав: не указан');
  }
  const photoCount = (draft.photos || []).length;
  lines.push('Фото: ' + photoCount + ' шт.');
  return lines.join('\n');
}

function previewRows() {
  return [
    [maxApi.callbackButton('✏️ Категория', 'edit:field:category')],
    [maxApi.callbackButton('✏️ Название', 'edit:field:name')],
    [maxApi.callbackButton('✏️ Цена', 'edit:field:price')],
    [maxApi.callbackButton('✏️ Состав', 'edit:field:composition')],
    [maxApi.callbackButton('✏️ Фото', 'edit:field:photos')],
    [maxApi.callbackButton('💾 Сохранить', 'preview:save')],
    [maxApi.callbackButton('❌ Отмена', 'preview:cancel')]
  ];
}

async function sendPreview(userId, session) {
  const text = formatPreviewText(session.draft);
  const photoUrl = (session.draft.photos || [])[0];
  if (photoUrl) {
    const result = await maxApi.sendPhotoUrlMessage({ userId }, text, previewRows(), photoUrl);
    if (!result.ok) await maxApi.sendMessage({ userId }, text, previewRows());
  } else {
    await maxApi.sendMessage({ userId }, text, previewRows());
  }
}

async function editField(userId, session, field) {
  if (!(await requireDraft(userId, session))) return;
  if (field === 'category') {
    session.editingFromPreview = true;
    session.step = 'admin_add_category';
    await store.setSession(userId, session);
    const rows = products.CATEGORY_NAMES.map((name, i) => [maxApi.callbackButton(name, 'add:cat:' + i)]);
    rows.push(backRow());
    await maxApi.sendMessage({ userId }, 'Выберите новую категорию товара:', rows);
    return;
  }
  if (field === 'photos') {
    await sendPhotoManageMenu(userId, session);
    return;
  }
  session.editingFromPreview = true;
  session.step = stepForField(field);
  await store.setSession(userId, session);
  await maxApi.sendMessage({ userId }, fieldPrompt(field), [backRow()]);
}

function photoManageRows(photos) {
  const rows = photos.map((url, i) => [maxApi.callbackButton('🗑 Удалить фото ' + (i + 1), 'photos:remove:' + i)]);
  rows.push([maxApi.callbackButton('➕ Добавить фото', 'photos:add')]);
  rows.push([maxApi.callbackButton('⬅️ Назад к предпросмотру', 'photos:back')]);
  return rows;
}

async function sendPhotoManageMenu(userId, session) {
  session.step = 'admin_manage_photos';
  await store.setSession(userId, session);
  const photos = session.draft.photos || [];
  await maxApi.sendMessage({ userId }, 'Фото товара (' + photos.length + ' шт.). Что сделать?', photoManageRows(photos));
}

async function removePhoto(userId, session, index) {
  if (!(await requireDraft(userId, session))) return;
  const photos = session.draft.photos || [];
  if (index >= 0 && index < photos.length) photos.splice(index, 1);
  session.draft.photos = photos;
  await store.setSession(userId, session);
  await maxApi.sendMessage({ userId }, 'Фото удалено.', photoManageRows(photos));
}

async function addMorePhotos(userId, session) {
  if (!(await requireDraft(userId, session))) return;
  session.editingFromPreview = true;
  session.step = stepForField('photos');
  await store.setSession(userId, session);
  await maxApi.sendMessage({ userId }, 'Пришлите фото товара. Когда закончите — нажмите «Готово».', photoStepRows());
}

async function backToPreview(userId, session) {
  if (!(await requireDraft(userId, session))) return;
  session.step = 'admin_preview';
  await store.setSession(userId, session);
  await sendPreview(userId, session);
}

async function saveDraft(userId, session) {
  if (!(await requireDraft(userId, session))) return;
  const draft = session.draft;
  try {
    const product = await products.saveProduct(draft.category, draft.id, {
      name: draft.name,
      price: draft.price,
      composition: draft.composition,
      photos: draft.photos
    });
    await sendMenu(userId, '✅ Товар «' + product.name + '» опубликован на сайте (' + draft.category + ').');
  } catch (e) {
    console.error('[admin] ошибка сохранения товара:', e.message);
    await maxApi.sendMessage({ userId }, '⚠️ Не удалось сохранить товар: ' + e.message, previewRows());
  }
}

async function cancelDraft(userId) {
  await sendMenu(userId, 'Действие отменено.');
}

// ---------- поиск товара (для «Изменить»/«Удалить») ----------

async function startFind(userId, action) {
  await store.setSession(userId, { step: 'admin_find_name', adminAction: action });
  const verb = action === 'delete' ? 'удалить' : 'изменить';
  await maxApi.sendMessage({ userId }, 'Напишите название товара, который нужно ' + verb + '.', [backRow()]);
}

function matchCardText(product, category) {
  const lines = [product.name, product.price];
  if (product.composition && product.composition.length) {
    lines.push('');
    product.composition.forEach((line) => lines.push('• ' + line));
  }
  lines.push('');
  lines.push('Категория: ' + category);
  return lines.join('\n');
}

async function handleFindName(userId, session, text) {
  if (!text || !text.trim()) {
    await maxApi.sendMessage({ userId }, 'Напишите название товара текстом.', [backRow()]);
    return;
  }
  const query = text.trim();
  const matches = await products.searchByName(query, 5);
  if (!matches.length) {
    await maxApi.sendMessage({ userId }, 'Ничего не найдено похожего на «' + query + '». Попробуйте написать по-другому.', [backRow()]);
    return;
  }
  session.matches = matches.map((m) => ({ category: m.category, id: m.product.id }));
  await store.setSession(userId, session);
  for (let i = 0; i < matches.length; i += 1) {
    const { category, product } = matches[i];
    const photoUrl = product.photo || (product.photos && product.photos[0]);
    const text2 = matchCardText(product, category);
    const rows = [[maxApi.callbackButton('Этот товар', 'find:pick:' + i)]];
    if (photoUrl) {
      const result = await maxApi.sendPhotoUrlMessage({ userId }, text2, rows, photoUrl);
      if (!result.ok) await maxApi.sendMessage({ userId }, text2, rows);
    } else {
      await maxApi.sendMessage({ userId }, text2, rows);
    }
  }
}

async function pickMatch(userId, session, index) {
  const match = (session.matches || [])[index];
  if (!match) {
    await sendMenu(userId);
    return;
  }
  const product = await products.getProductById(match.id);
  if (!product) {
    await maxApi.sendMessage({ userId }, 'Этот товар уже не найден — возможно, его удалили.');
    await sendMenu(userId);
    return;
  }

  if (session.adminAction === 'delete') {
    session.step = 'admin_confirm_delete';
    session.deleteTarget = { id: product.id, name: product.name };
    await store.setSession(userId, session);
    await maxApi.sendMessage(
      { userId },
      'Удалить товар «' + product.name + '»?',
      [[maxApi.callbackButton('Да', 'delete:confirm:yes'), maxApi.callbackButton('Нет', 'delete:confirm:no')]]
    );
    return;
  }

  session.step = 'admin_preview';
  session.adminAction = 'edit';
  session.draft = {
    id: product.id,
    category: match.category,
    name: product.name,
    price: product.price,
    composition: product.composition || [],
    photos: product.photos || (product.photo ? [product.photo] : [])
  };
  await store.setSession(userId, session);
  await sendPreview(userId, session);
}

async function confirmDelete(userId, session, yes) {
  if (!yes) {
    await sendMenu(userId, 'Отменено.');
    return;
  }
  const target = session.deleteTarget;
  if (!target) {
    await sendMenu(userId);
    return;
  }
  await products.deleteProductById(target.id);
  await sendMenu(userId, '🗑 Товар «' + target.name + '» удалён.');
}

// ---------- заявки ----------

function formatLead(lead) {
  let when = lead.createdAt || '';
  try {
    const d = new Date(lead.createdAt);
    when = d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  } catch (e) { /* оставляем как есть */ }

  const lines = [when, lead.kind === 'question' ? '❓ Вопрос в чате' : '🛒 Заказ с сайта'];
  lines.push('Источник: ' + (lead.source || '—'));
  if (lead.name) lines.push('Имя: ' + lead.name);
  if (lead.phone) lines.push('Телефон: ' + lead.phone);
  if (lead.productName) lines.push('Товар: ' + lead.productName);
  if (lead.question) lines.push('Вопрос: ' + lead.question);
  lines.push(lead.isRepeat ? '👤 Повторное обращение' : '🆕 Первое обращение');
  return lines.join('\n');
}

async function sendLeads(userId, offset) {
  const page = await store.getLeadsPage(offset || 0, 10);
  if (!page.items.length) {
    await maxApi.sendMessage({ userId }, offset ? 'Больше заявок нет.' : 'Заявок пока нет.', [backRow()]);
    return;
  }
  const text = page.items.map(formatLead).join('\n\n———\n\n');
  const rows = [];
  const shown = (offset || 0) + page.items.length;
  if (shown < page.total) rows.push([maxApi.callbackButton('Показать ещё', 'admin:leads:' + shown)]);
  rows.push(backRow());
  await maxApi.sendMessage({ userId }, 'Заявки (' + ((offset || 0) + 1) + '–' + shown + ' из ' + page.total + '):\n\n' + text, rows);
}

// ---------- диспетчер ----------

async function handleCallback(userId, session, data) {
  if (data === 'admin:menu') { await sendMenu(userId); return true; }
  if (data === 'admin:add') { await startAdd(userId); return true; }
  if (data === 'admin:edit') { await startFind(userId, 'edit'); return true; }
  if (data === 'admin:delete') { await startFind(userId, 'delete'); return true; }
  if (data === 'admin:leads') { await sendLeads(userId, 0); return true; }
  if (data.indexOf('admin:leads:') === 0) { await sendLeads(userId, parseInt(data.slice('admin:leads:'.length), 10) || 0); return true; }

  if (data.indexOf('add:cat:') === 0) { await pickCategory(userId, session, parseInt(data.slice('add:cat:'.length), 10)); return true; }
  if (data.indexOf('edit:field:') === 0) { await editField(userId, session, data.slice('edit:field:'.length)); return true; }
  if (data === 'preview:save') { await saveDraft(userId, session); return true; }
  if (data === 'preview:cancel') { await cancelDraft(userId); return true; }
  if (data === 'photos:done') { await finishPhotos(userId, session); return true; }
  if (data === 'photos:add') { await addMorePhotos(userId, session); return true; }
  if (data === 'photos:back') { await backToPreview(userId, session); return true; }
  if (data.indexOf('photos:remove:') === 0) { await removePhoto(userId, session, parseInt(data.slice('photos:remove:'.length), 10)); return true; }
  if (data.indexOf('find:pick:') === 0) { await pickMatch(userId, session, parseInt(data.slice('find:pick:'.length), 10)); return true; }
  if (data === 'delete:confirm:yes') { await confirmDelete(userId, session, true); return true; }
  if (data === 'delete:confirm:no') { await confirmDelete(userId, session, false); return true; }
  return false;
}

async function handleMessage(update, userId, session) {
  const text = (update.message && update.message.body && update.message.body.text) || null;
  switch (session.step) {
    case 'admin_field_name': return handleTextField(userId, session, 'name', text);
    case 'admin_field_price': return handleTextField(userId, session, 'price', text);
    case 'admin_field_composition': return handleTextField(userId, session, 'composition', text);
    case 'admin_field_photos': return handlePhotosStep(update, userId, session);
    case 'admin_find_name': return handleFindName(userId, session, text);
    default:
      // Шаги с кнопками (выбор категории/подтверждение/предпросмотр/меню
      // фото) не ждут текст — не сбрасываем черновик, просто напоминаем
      // про кнопки, чтобы случайное сообщение не потеряло уже собранные
      // данные товара.
      await maxApi.sendMessage({ userId }, 'Пожалуйста, воспользуйтесь кнопками выше (или «⬅️ В меню»).', [backRow()]);
  }
}

module.exports = {
  isAdminStep,
  sendMenu,
  handleCallback,
  handleMessage
};
