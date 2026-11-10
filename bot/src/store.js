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
const crypto = require('crypto');
const path = require('path');
const config = require('./config');
const objectStorage = require('./objectStorage');

const USE_S3 = Boolean(config.s3.bucket);

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!USE_S3 && !fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const { createPrivateDb } = require('./privateDb');
const { createRetention, TTL } = require('./retention');
const operation = require('./operation');
const db = createPrivateDb(config.s3, objectStorage, DATA_DIR);
const retention = createRetention({ db });
async function readJson(name, fallback) { return retention.read(name, fallback); }
async function active(name, row) {
  if (!row) return null;
  const ctl = await retention.control();
  return retention.expiry(row, name, ctl.activatedAt) > Date.now() ? row : null;
}
function stamp(row, createdAt = Date.now()) { return { ...row, createdAt: new Date(createdAt).toISOString(), expiresAt: createdAt + TTL }; }
async function checkAndRecordCustomer(phoneDigits) {
  const ctl = await retention.control(); let result;
  await db.update('customers.json', old => {
    const customers = old || {}, row = customers[phoneDigits];
    if (row && retention.expiry(row, 'customers', ctl.activatedAt) > Date.now()) { result = { isRepeat: true, firstSeen: row.firstSeen }; return; }
    const firstSeen = new Date().toISOString();
    customers[phoneDigits] = stamp({ firstSeen }); result = { isRepeat: false, firstSeen: null }; return customers;
  }); return result;
}
async function saveQuestion(questionId, userId, questionText, userName, userPhone) {
  const ctl = await retention.control();
  await db.update('questions.json', old => {
    const rows = old || {}, existing = rows[questionId];
    if (existing && retention.expiry(existing, 'questions', ctl.activatedAt) <= Date.now()) throw Error('QUESTION_EXPIRED');
    rows[questionId] = { ...stamp({ userId, userName: userName || existing?.userName || '', userPhone: userPhone || existing?.userPhone || '', question: questionText, answered: false }), ...(existing ? { createdAt: existing.createdAt, expiresAt: retention.expiry(existing, 'questions', ctl.activatedAt) } : {}) };
    return rows;
  });
}
async function getQuestion(questionId) { const row = await active('questions', (await readJson('questions', {}))[questionId]);if(row){const ctl=await retention.control();operation.limit(retention.expiry(row,'questions',ctl.activatedAt))}return row; }
async function markQuestionAnswered(questionId) {
  const ctl = await retention.control();
  await db.update('questions.json', old => { if (!old?.[questionId] || retention.expiry(old[questionId], 'questions', ctl.activatedAt) <= Date.now()) return; old[questionId].answered = true; return old; });
}
async function saveLead(entry) {
  const ctl = await retention.control();
  await db.update('leads.json', old => {
    const rows = (old || []).filter(row => retention.expiry(row, 'leads', ctl.activatedAt) > Date.now());
    if (entry.id && rows.some(row => row.id === entry.id)) return;
    rows.push(stamp(entry)); return rows;
  });
}
async function getLeadsPage(offset, limit) {
  const ctl = await retention.control();
  const rows = (await readJson('leads', [])).filter(row => retention.expiry(row, 'leads', ctl.activatedAt) > Date.now()).reverse();
  const items=rows.slice(offset || 0, (offset || 0) + (limit || 10));for(const row of items)operation.limit(retention.expiry(row,'leads',ctl.activatedAt));return { items, total: rows.length };
}
async function getSession(userId) {const row=await active('sessions',(await readJson('sessions',{}))[userId]);if(row){const ctl=await retention.control();operation.limit(retention.expiry(row,'sessions',ctl.activatedAt));return {...row,expiresAt:retention.expiry(row,'sessions',ctl.activatedAt)}}return {step:'idle'};}
async function setSession(userId, session) {
  const ctl = await retention.control();
  await db.update('sessions.json', old => {
    const sessions = old || {}, previous = sessions[userId];
    if (session.expiresAt && session.expiresAt <= Date.now()) throw Error('SESSION_EXPIRED');
    const existing = previous && retention.expiry(previous, 'sessions', ctl.activatedAt) > Date.now() ? previous : null;
    sessions[userId] = { ...stamp(session), ...(existing ? { createdAt: existing.createdAt, expiresAt: retention.expiry(existing, 'sessions', ctl.activatedAt) } : {}) };
    return sessions;
  });
}
async function clearSession(userId) { await db.update('sessions.json', old => { if (!old || !(userId in old)) return; delete old[userId]; return old; }); }

// Stable message/callback IDs are claimed atomically and retained across restarts.
// Legacy events without IDs use the existing 15-minute fallback below.
const DEDUP_WINDOW_MS = 15 * 60 * 1000;

async function wasRecentlyProcessed(key, stableId = false) {
  if (stableId) {
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    if (USE_S3) return !(await objectStorage.createJsonOnce(config.s3, 'processed_updates/' + hash + '.json', { claimedAt: new Date().toISOString() }));
    const directory = path.join(DATA_DIR, 'processed_updates');
    fs.mkdirSync(directory, { recursive: true });
    try {
      fs.writeFileSync(path.join(directory, hash + '.json'), JSON.stringify({ claimedAt: new Date().toISOString() }), { flag: 'wx' });
      return false;
    } catch (error) {
      if (error.code === 'EEXIST') return true;
      throw error;
    }
  }
  let duplicate = false;
  await db.update('recent_updates.json', old => {
    const seen = old || {}, now = Date.now();
    for (const k of Object.keys(seen)) if (now - seen[k] > DEDUP_WINDOW_MS) delete seen[k];
    duplicate = seen[key] !== undefined;
    if (!duplicate) seen[key] = now;
    return seen;
  }); return duplicate;
}

module.exports = {
  db, retention,
  checkAndRecordCustomer,
  saveQuestion,
  getQuestion,
  markQuestionAnswered,
  saveLead,
  getLeadsPage,
  getSession,
  setSession,
  clearSession,
  wasRecentlyProcessed
};
