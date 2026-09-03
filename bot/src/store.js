// Хранилище данных бота: клиенты (для проверки повторных заказов), вопросы
// (пара «вопрос → user_id», без истории переписки) и сессии диалога (на
// каком шаге сценария сейчас человек).
//
// Два режима, переключаются автоматически по наличию YC_S3_BUCKET:
//   – ЛОКАЛЬНЫЕ ФАЙЛЫ (bot/data/*.json) – для VM/локальной разработки,
//     где процесс работает постоянно и диск не исчезает между запросами.
//   – Yandex Object Storage (S3-совместимое API) – ОБЯЗАТЕЛЬНО для Cloud
//     Functions: там нет постоянного диска между вызовами функции, и без
//     внешнего хранилища бот «забывал» бы, на каком шаге диалога находится
//     собеседник, уже между двумя соседними сообщениями.
//
// Все функции асинхронные (даже локально-файловый режим — для единообразия
// вызовов что на VM, что в Cloud Functions).

const fs = require('fs');
const path = require('path');
const config = require('./config');
const objectStorage = require('./objectStorage');

const USE_S3 = Boolean(config.s3.bucket);

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!USE_S3 && !fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

async function readJson(name, fallback) {
  if (USE_S3) {
    return objectStorage.getJson(config.s3, name + '.json', fallback);
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name + '.json'), 'utf8'));
  } catch (e) {
    return fallback;
  }
}

async function writeJson(name, data) {
  if (USE_S3) {
    return objectStorage.putJson(config.s3, name + '.json', data);
  }
  const filePath = path.join(DATA_DIR, name + '.json');
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
  return true;
}

// – Повторные заказы: телефон (11 цифр, без форматирования) → дата первого обращения –
async function checkAndRecordCustomer(phoneDigits) {
  const customers = await readJson('customers', {});
  const existing = customers[phoneDigits];
  if (existing) {
    return { isRepeat: true, firstSeen: existing.firstSeen };
  }
  customers[phoneDigits] = { firstSeen: new Date().toISOString() };
  await writeJson('customers', customers);
  return { isRepeat: false, firstSeen: null };
}

// – Вопросы: пара «вопрос → user_id автора» (+ имя, если знаем), без истории переписки –
async function saveQuestion(questionId, userId, questionText, userName) {
  const questions = await readJson('questions', {});
  const existing = questions[questionId];
  questions[questionId] = {
    userId,
    userName: userName || (existing && existing.userName) || '',
    question: questionText,
    answered: false,
    createdAt: (existing && existing.createdAt) || new Date().toISOString()
  };
  await writeJson('questions', questions);
}

async function getQuestion(questionId) {
  const questions = await readJson('questions', {});
  return questions[questionId] || null;
}

async function markQuestionAnswered(questionId) {
  const questions = await readJson('questions', {});
  if (questions[questionId]) {
    questions[questionId].answered = true;
    await writeJson('questions', questions);
  }
}

// – Состояние диалога с конкретным пользователем (шаг сценария, что уже собрано) –
async function getSession(userId) {
  const sessions = await readJson('sessions', {});
  return sessions[userId] || { step: 'idle' };
}

async function setSession(userId, session) {
  const sessions = await readJson('sessions', {});
  sessions[userId] = session;
  await writeJson('sessions', sessions);
}

async function clearSession(userId) {
  const sessions = await readJson('sessions', {});
  delete sessions[userId];
  await writeJson('sessions', sessions);
}

// – Защита от повторной обработки одного и того же апдейта –
// Наблюдался реальный случай: Max присылал один и тот же message_callback
// несколько раз подряд (видимо, повторная доставка, если функция не
// ответила достаточно быстро), и бот несколько раз пересылал Олесе одно и
// то же. У Update-объекта нет отдельного update_id (подтверждено
// документацией), поэтому дедуп – по составному ключу (тип + user_id +
// содержимое + исходный timestamp события). Ключи протухают через 15
// минут, чтобы файл не рос бесконечно и чтобы одинаковое повторное
// действие человека (не ретрай, а реальное повторное нажатие спустя время)
// не блокировалось навсегда.
const DEDUP_WINDOW_MS = 15 * 60 * 1000;

async function wasRecentlyProcessed(key) {
  const seen = await readJson('recent_updates', {});
  const now = Date.now();
  for (const k of Object.keys(seen)) {
    if (now - seen[k] > DEDUP_WINDOW_MS) delete seen[k];
  }
  if (seen[key] !== undefined) {
    return true;
  }
  seen[key] = now;
  await writeJson('recent_updates', seen);
  return false;
}

module.exports = {
  checkAndRecordCustomer,
  saveQuestion,
  getQuestion,
  markQuestionAnswered,
  getSession,
  setSession,
  clearSession,
  wasRecentlyProcessed
};
