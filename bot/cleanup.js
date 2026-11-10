'use strict';
// Must remain PRIVATE in Cloud Functions; invoke only with IAM (timer service account).
exports.handler = async function () {
  const config = require('./src/config');
  if (!config.s3.bucket || !config.s3.accessKey || !config.s3.secretKey || !config.botToken) throw Error('CLEANUP_CONFIG');
  const store = require('./src/store');
  const { createRetention } = require('./src/retention');
  const max = require('./src/maxApi');
  if (process.env.CLEANUP_SMOKE === 'true') {
    if (!config.ownerChatId) throw Error('OWNER_CONFIG');
    const result = await max.sendMessage({ userId: config.ownerChatId }, 'Служебная проверка очистки «Аура цветов». Без данных покупателей. Это сообщение будет удалено автоматически сейчас.');
    const mid = result.body?.message?.body?.mid ?? result.body?.body?.mid;
    if (!result.ok || !mid) {
      const status = Number.isInteger(result.status) ? result.status : 0;
      // MAX's machine code only: exclude response text, tokens and recipient IDs.
      const code = result.body?.code;
      const safeCode = typeof code === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(code) ? '_' + code : '';
      throw Error('SMOKE_SEND_FAILED_HTTP_' + status + safeCode + (result.ok && !mid ? '_MISSING_MESSAGE_ID' : ''));
    }
    const deleted = await max.deleteMessage(String(mid));
    const summary = { mode: 'SMOKE', at: Date.now(), maxDeleted: deleted };
    await store.db.update('retention/last-smoke.json', () => summary);
    return summary;
  }
  return createRetention({ db: store.db, removeMessage: max.deleteMessage }).cleanup({ apply: process.env.CLEANUP_APPLY === 'true' });
};
