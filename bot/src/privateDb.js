'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
function createPrivateDb(config, storage, directory) {
  const remote = Boolean(config.bucket);
  function file(key) {
    if (!/^(customers|questions|leads|sessions|recent_updates)\.json$|^retention\/[a-zA-Z0-9/_-]+\.json$/.test(key)) throw Error('PRIVATE_KEY');
    return path.join(directory, ...key.split('/'));
  }
  async function get(key) {
    if (remote) return storage.getVersioned(config, key);
    try { const bytes = fs.readFileSync(file(key)); return { data: JSON.parse(bytes), etag: crypto.createHash('sha256').update(bytes).digest('hex') }; }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async function update(key, fn) {
    if (remote) {
      for (let n = 0; n < 6; n++) {
        const old = await get(key), next = fn(old?.data ?? null);
        if (next === undefined) return old?.data;
        if (await storage.putConditional(config, key, next, old?.etag)) return next;
      }
      throw Error('STORAGE_CONTENTION');
    }
    const target = file(key); fs.mkdirSync(path.dirname(target), { recursive: true });
    const lock = target + '.lock'; let fd;
    // No async work inside the lock: process cannot interleave read/modify/write.
    try {
      fd = fs.openSync(lock, 'wx');
      let old = null;
      try { old = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const next = fn(old);
      if (next === undefined) return old;
      const tmp = target + '.' + crypto.randomUUID() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(next)); fs.renameSync(tmp, target); return next;
    } finally { if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(lock); } }
  }
  async function remove(key) {
    if (!key.startsWith('retention/messages/')) throw Error('DELETE_SCOPE');
    if (remote) return storage.removePrivate(config, key);
    try { fs.unlinkSync(file(key)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  async function list(prefix, after) {
    if (prefix !== 'retention/messages/') throw Error('LIST_SCOPE');
    if (remote) return storage.listPrivate(config, prefix, after);
    let names; try { names = fs.readdirSync(path.join(directory, 'retention', 'messages')); } catch (e) { if (e.code === 'ENOENT') return { keys: [], more: false }; throw e; }
    const keys = names.filter(n => n.endsWith('.json')).map(n => prefix + n).sort().filter(k => k > (after || ''));
    return { keys: keys.slice(0, 100), more: keys.length > 100 };
  }
  return { get, update, remove, list };
}
module.exports = { createPrivateDb };
