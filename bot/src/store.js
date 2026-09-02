// Простое файловое хранилище на JSON – без базы данных, как и просили
// в ТЗ («не полноценная CRM», «без долгой истории переписки»). Для объёма
// заявок цветочного магазина этого достаточно; если объём вырастет,
// заменить на настоящую БД – все обращения идут через этот единственный
// модуль, переделать будет несложно.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function filePath(name) {
  return path.join(DATA_DIR, name + '.json');
}

function readJson(name, fallback) {
  try {
    const raw = fs.readFileSync(filePath(name), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function writeJson(name, data) {
  // Запись через временный файл + rename – чтобы не оставить битый JSON,
  // если процесс упадёт посреди записи.
  const tmp = filePath(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath(name));
}

// – Повторные заказы: телефон (11 цифр, без форматирования) → дата первого обращения –
function checkAndRecordCustomer(phoneDigits) {
  const customers = readJson('customers', {});
  const existing = customers[phoneDigits];
  if (existing) {
    return { isRepeat: true, firstSeen: existing.firstSeen };
  }
  customers[phoneDigits] = { firstSeen: new Date().toISOString() };
  writeJson('customers', customers);
  return { isRepeat: false, firstSeen: null };
}

// – Вопросы: пара «вопрос → user_id автора», без истории переписки –
function saveQuestion(questionId, userId, questionText) {
  const questions = readJson('questions', {});
  questions[questionId] = {
    userId,
    question: questionText,
    answered: false,
    createdAt: new Date().toISOString()
  };
  writeJson('questions', questions);
}

function getQuestion(questionId) {
  const questions = readJson('questions', {});
  return questions[questionId] || null;
}

function markQuestionAnswered(questionId) {
  const questions = readJson('questions', {});
  if (questions[questionId]) {
    questions[questionId].answered = true;
    writeJson('questions', questions);
  }
}

// – Состояние диалога с конкретным пользователем (шаг сценария, что уже собрано) –
function getSession(userId) {
  const sessions = readJson('sessions', {});
  return sessions[userId] || { step: 'idle' };
}

function setSession(userId, session) {
  const sessions = readJson('sessions', {});
  sessions[userId] = session;
  writeJson('sessions', sessions);
}

function clearSession(userId) {
  const sessions = readJson('sessions', {});
  delete sessions[userId];
  writeJson('sessions', sessions);
}

module.exports = {
  checkAndRecordCustomer,
  saveQuestion,
  getQuestion,
  markQuestionAnswered,
  getSession,
  setSession,
  clearSession
};
