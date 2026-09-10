// Preview exposes only website assets, never bot files, credentials or Git data.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const assets = new Set(['index.html', 'business.js', 'storefront.css', 'max-icon.svg', 'catalog.css', 'favicon.ico', 'robots.txt', 'sitemap.xml',
  'favicon-32.png', 'favicon-512.png', 'apple-touch-icon.png', 'og-image.jpg']);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8' };
const server = http.createServer((req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
  let name;
  try { name = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.html'; }
  catch { res.writeHead(400).end(); return; }
  if (/^catalog\/(bukety|kompozitsii|poshtuchno)\/(?:[a-z0-9-]+\/)?$/.test(name)) name += 'index.html';
  if (!assets.has(name) && !/^products\/[a-z0-9-]+\.(webp|png|jpg)$/.test(name) && !/^catalog\/(bukety|kompozitsii|poshtuchno)\/(?:[a-z0-9-]+\/)?index\.html$/.test(name)) { res.writeHead(404).end(); return; }
  fs.readFile(path.join(root, name), (error, data) => {
    if (error) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});
server.listen(Number(process.env.PREVIEW_PORT) || 8090, '0.0.0.0', () => {
  console.log('Preview: http://localhost:' + server.address().port);
});
