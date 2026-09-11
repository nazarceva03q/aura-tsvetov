const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(__dirname,'..');
test('sitemap destinations have canonical URLs, valid schemas and local image assets',()=>{
 const sitemap=fs.readFileSync(path.join(root,'sitemap.xml'),'utf8');
 const urls=[...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(m=>m[1]);assert.equal(urls.length,29);
 for(const url of urls){
 const file=path.join(root,new URL(url).pathname,'index.html');const html=fs.readFileSync(file,'utf8');
 assert.ok(html.includes('href="'+url+'"'),url);assert.equal((html.match(/<h1[> ]/g)||[]).length,1);
 for(const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g))JSON.parse(m[1]);
 for(const m of html.matchAll(/<img[^>]+src="(\/[^" ]+)"/g))assert.ok(fs.existsSync(path.join(root,m[1])),m[1]);
 assert.ok(!html.includes('Р‘СѓРє'),'broken UTF-8');
 }
});
test('pink hydrangea is present in static product page with correct price and composition',()=>{
 const html=fs.readFileSync(path.join(root,'catalog/bukety/buket-rozovoy-gortenzii/index.html'),'utf8');
 for(const value of ['Букет из розовой гортензии','1500 ₽','Гортензия – 1 шт.','Гипсофил – 2 шт.','/#category=bukety&product=buket-rozovoy-gortenzii'])assert.ok(html.includes(value));
});
