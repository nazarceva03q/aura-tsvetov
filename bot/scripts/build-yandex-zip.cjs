// Node.js equivalent of build-yandex-zip.py for machines without Python.
// Keep explicit Unix directory entries required by the Cloud Functions extractor.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const root = path.resolve(__dirname, '..');
const files = ['index.js', 'src/bot.js', 'src/catalog.js', 'src/config.js',
  'src/maxApi.js', 'src/notify.js', 'src/objectStorage.js', 'src/store.js',
  'src/photoTokens.json', 'certs/russian-trusted-ca-bundle.pem'];

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const entries = ['src/', 'certs/'].map(name => ({ name, data: Buffer.alloc(0), directory: true }));
for (const name of files) {
  const file = path.join(root, name);
  if (name === 'src/photoTokens.json' && !fs.existsSync(file)) continue;
  entries.push({ name, data: fs.readFileSync(file) });
}
entries.push({ name: 'package.json', data: Buffer.from(JSON.stringify({ name: 'aura-max-bot', version: '1.0.0', private: true, main: 'index.js' }, null, 2)) });
const localParts = [], centralParts = [];
let offset = 0;
for (const entry of entries) {
  const name = Buffer.from(entry.name);
  const packed = entry.directory ? entry.data : zlib.deflateRawSync(entry.data);
  const method = entry.directory ? 0 : 8;
  const crc = crc32(entry.data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8); local.writeUInt16LE(33, 12);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(entry.data.length, 22); local.writeUInt16LE(name.length, 26);
  localParts.push(local, name, packed);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10);
  central.writeUInt16LE(33, 14); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(entry.data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(((entry.directory ? 0o40755 : 0o100644) * 65536 + (entry.directory ? 16 : 0)) >>> 0, 38);
  central.writeUInt32LE(offset, 42); centralParts.push(central, name);
  offset += local.length + name.length + packed.length;
}
const central = Buffer.concat(centralParts), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12);
end.writeUInt32LE(offset, 16);
fs.writeFileSync(path.join(root, 'yandex-deploy.zip'), Buffer.concat([...localParts, central, end]));
console.log('Built bot/yandex-deploy.zip with ' + entries.length + ' entries (no .env).');
