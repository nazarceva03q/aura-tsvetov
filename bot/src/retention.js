'use strict';
// No contacts or message bodies in delivery receipts. All time comparisons use UTC milliseconds.
const crypto = require('crypto');
const DAY = 86400000, TTL = 30 * DAY, RECEIPT_TTL = 37 * DAY;
const DATA_FILES = ['customers', 'questions', 'leads', 'sessions'];
function timestamp(value) { const n = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(n) ? n : null; }
function createRetention({ db, now = Date.now, removeMessage, pause = ms => new Promise(r => setTimeout(r, ms)) }) {
  const key = name => name + '.json';
  async function control() {
    let result;
    await db.update('retention/control.json', old => { result = old || { schema: 1, activatedAt: now() }; return old ? undefined : result; });
    return result;
  }
  function expiry(row, name, activatedAt) {
    if (timestamp(row?.expiresAt) !== null) return timestamp(row.expiresAt);
    const first = timestamp(row?.createdAt ?? row?.firstSeen);
    // Unknown legacy ages are explicit, not silently reported as new submissions.
    return (first ?? activatedAt) + TTL;
  }
  async function read(name, fallback) { const r = await db.get(key(name)); return r?.data ?? fallback; }
  async function update(name, fn) { return db.update(key(name), fn); }
  async function send(send, operation, options = {}) {
    await control();
    const id = operation ? crypto.createHash('sha256').update(operation).digest('hex') : crypto.randomUUID();
    const path = 'retention/messages/' + id + '.json';
    let claimed = false, previous;
    await db.update(path, old => {
      claimed = false; previous = old;
      if (old) { if (old.fingerprint && old.fingerprint !== options.fingerprint) throw Error('MESSAGE_CONFLICT'); return; }
      claimed = true;
      const expiresAt = Math.min(now() + TTL, options.expiresAt || now() + TTL);
      if (expiresAt <= now()) throw Error('MESSAGE_EXPIRED');
      return { schema: 1, createdAt: now(), expiresAt, technicalUntil: expiresAt + (RECEIPT_TTL - TTL), state: 'intent', attempts: 0, ...(options.fingerprint ? { fingerprint: options.fingerprint } : {}) };
    });
    if (!claimed) {
      if (previous.state === 'sent' && now() < previous.expiresAt) return { ok: true, status: 200, body: { message: { body: { mid: previous.mid } } } };
      throw Error('DELIVERY_PREVIOUS_OUTCOME_UNKNOWN_OR_EXPIRED');
    }
    let response;
    try { response = await send(); }
    catch (error) {
      await db.update(path, r => ({ ...r, state: 'unknown' }));
      // Only known transport codes are safe to expose; never include request details.
      const code = error?.code || error?.cause?.code || error?.message;
      const safeCodes = ['MAX_TIMEOUT', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID'];
      const safeCode = safeCodes.includes(code) || (typeof (error?.code || error?.cause?.code) === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(code));
      throw Error('DELIVERY_OUTCOME_UNKNOWN' + (safeCode ? '_' + code : '_UNCLASSIFIED'));
    }
    const mid = response.body?.message?.body?.mid ?? response.body?.body?.mid;
    // A send can have succeeded even when its response has no usable message ID.
    await db.update(path, r => ({ ...r, state: response.ok && mid ? 'sent' : response.ok || response.status >= 500 ? 'unknown' : 'rejected', ...(mid ? { mid: String(mid) } : {}) }));
    if ((response.ok && !mid) || response.status >= 500) throw Error('DELIVERY_OUTCOME_UNKNOWN');
    return response;
  }
  async function request(id, fingerprint, fn) {
    if (!id) return fn(); // Compatibility for already-open old website forms.
    await control();
    const path = 'retention/messages/request-' + crypto.createHash('sha256').update(id).digest('hex') + '.json';
    let claimed = false, previous;
    await db.update(path, old => {
      claimed = false; previous = old;
      if (old) { if (old.fingerprint !== fingerprint) throw Error('REQUEST_CONTENT_CONFLICT'); return; }
      claimed = true;
      return { kind: 'request', fingerprint, createdAt: now(), expiresAt: now() + TTL, technicalUntil: now() + RECEIPT_TTL, state: 'processing' };
    });
    if (!claimed) {
      if (previous.state === 'complete' && now() < previous.expiresAt) return { ok: previous.ok };
      throw Error('REQUEST_OUTCOME_UNKNOWN_OR_EXPIRED');
    }
    const result = await fn();
    await db.update(path, old => ({ ...old, state: 'complete', ok: Boolean(result.ok) }));
    return result;
  }
  async function run({ apply = false, budgetMs = 45000 } = {}) {
    const started = now(), ctl = await control();
    const summary = { mode: apply ? 'APPLY' : 'PREVIEW', at: started, scanComplete: false, cloudRemoved: 0, legacyUndated: 0, messagesDue: 0, maxDeleted: 0, maxPending: 0, unknownDelivery: 0, receiptsRemoved: 0, errors: 0 };
    for (const name of DATA_FILES) {
      const prune = old => {
        if (old === null || old === undefined) return;
        const entries = Array.isArray(old) ? old.map((v, i) => [i, v]) : Object.entries(old);
        const keep = [];
        for (const [id, row] of entries) {
          if (timestamp(row?.createdAt ?? row?.firstSeen) === null && timestamp(row?.expiresAt) === null) summary.legacyUndated++;
          if (expiry(row, name, ctl.activatedAt) <= now()) summary.cloudRemoved++;
          else keep.push([id, row]);
        }
        return Array.isArray(old) ? keep.map(([, row]) => row) : Object.fromEntries(keep);
      };
      // Recompute from the most recent ETag on conflicts; no stale snapshot may overwrite new records.
      try {
        const baseRemoved = summary.cloudRemoved, baseUndated = summary.legacyUndated;
        if (apply) await db.update(key(name), old => { summary.cloudRemoved = baseRemoved; summary.legacyUndated = baseUndated; return prune(old); });
        else prune((await db.get(key(name)))?.data);
      } catch { summary.errors++; }
    }
    const cursorPath = 'retention/cursor.json';
    const cursor = await db.get(cursorPath);
    let after = cursor?.data?.after || '', more = true;
    while (more && now() - started < budgetMs) {
      const page = await db.list('retention/messages/', after);
      for (const path of page.keys) {
        if (now() - started >= budgetMs) { more = false; break; }
        try {
          let record = (await db.get(path))?.data;
          if (record && record.expiresAt <= now()) {
            summary.messagesDue++;
            if (!record.mid && record.state !== 'rejected' && !(record.kind === 'request' && record.state === 'complete')) summary.unknownDelivery++;
            if (apply && record.technicalUntil <= now()) { await db.remove(path); summary.receiptsRemoved++; }
            else if (record.mid && record.state !== 'deleted') {
              summary.maxPending++;
              if (apply && record.attempts < 5 && (!record.retryAt || record.retryAt <= now()) && (!record.leaseUntil || record.leaseUntil <= now())) {
                const token = crypto.randomUUID(); let claimed = false;
                await db.update(path, old => {
                  claimed = false;
                  if (!old || old.state === 'deleted' || old.attempts >= 5 || old.retryAt > now() || old.leaseUntil > now()) return;
                  claimed = true; return { ...old, lease: token, leaseUntil: now() + 60000, attempts: old.attempts + 1, retryAt: now() + DAY };
                });
                if (claimed) {
                  // Global lease below serializes cleanup invocations; pacing respects MAX's 2/s per chat.
                  await pause(550);
                  let deleted = false;
                  try { deleted = await removeMessage(record.mid); } catch { /* Own data is already purged. */ }
                  await db.update(path, old => old?.lease === token ? { ...old, state: deleted ? 'deleted' : old.attempts >= 5 ? 'review' : 'pending', lease: null, leaseUntil: 0 } : undefined);
                  if (deleted) { summary.maxDeleted++; summary.maxPending--; }
                }
              }
            }
          }
        } catch { summary.errors++; }
        after = path;
        if (apply) await db.update(cursorPath, () => ({ after }));
      }
      if (!more) break;
      more = page.more;
      if (!more) { summary.scanComplete = true; if (apply) await db.update(cursorPath, () => ({ after: '' })); }
    }
    if (apply) await db.update('retention/last-result.json', () => summary);
    return summary;
  }
  async function cleanup(options) {
    if (!options?.apply) return run(options);
    const token = crypto.randomUUID(); let claimed = false;
    await db.update('retention/worker-lock.json', old => { claimed = false; if (old?.until > now()) return; claimed = true; return { token, until: now() + 300000 }; });
    if (!claimed) return { mode: 'APPLY', busy: true };
    try { return await run(options); }
    finally { await db.update('retention/worker-lock.json', old => old?.token === token ? { until: 0 } : undefined); }
  }
  return { read, update, control, expiry, send, request, cleanup };
}
module.exports = { createRetention, TTL, RECEIPT_TTL, DATA_FILES };
