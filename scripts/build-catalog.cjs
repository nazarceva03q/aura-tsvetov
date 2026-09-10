// Generate crawlable pages from the same catalog used by the storefront.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const catalog = vm.runInNewContext('(' + html.match(/var CATALOG = (\{[\s\S]*?\n  \});/)[1] + ')');
const business = require('../business.js');
const base = 'https://aura-flower.shop';
const slugs = { 'Букеты': 'bukety', 'Цветочные композиции': 'kompozitsii', 'Цветы поштучно': 'poshtuchno' };
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const json = data => JSON.stringify(data).replace(/</g, '\\u003c');
const urls = [{url:base+'/'}];
function write(url, title, description, content, schema) {
 const dir = path.join(root, url); fs.mkdirSync(dir, {recursive:true});
 fs.writeFileSync(path.join(dir,'index.html'), `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title><meta name="description" content="${escape(description)}"><meta name="robots" content="index, follow, max-image-preview:large">
<link rel="canonical" href="${base}/${url}/"><link rel="icon" href="/favicon.ico" sizes="32x32"><link rel="icon" type="image/png" sizes="512x512" href="/favicon-512.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:type" content="website"><meta property="og:locale" content="ru_RU"><meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description)}"><meta property="og:url" content="${base}/${url}/"><meta property="og:image" content="${base}${schema.image || '/og-image.jpg'}"><meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=PT+Serif:wght@400;700&amp;family=Inter:wght@400;500;600;700&amp;subset=cyrillic,cyrillic-ext,latin&amp;display=swap">
<link rel="stylesheet" href="/catalog.css"><script type="application/ld+json">${json({'@context':'https://schema.org',...schema,image:schema.image ? base+schema.image : undefined})}</script>
</head><body><header><a class="brand" href="/">Аура</a><span>Цветочный магазин · Оренбург</span><a href="tel:${business.phone}">${business.phoneDisplay}</a></header>
<main>${content}</main><footer><p>Аура · ${escape(business.city)}, ${escape(business.address)} · ${escape(business.hours)}</p><p>${escape(business.delivery)} ${escape(business.deliveryOffer)}</p><p>${escape(business.payment)}</p><a href="/">На главную</a> · <a href="${business.mapsUrl}">Мы на карте</a> · <a href="/#doc=privacy">Политика конфиденциальности</a></footer></body></html>\n`);
 urls.push({url:base+'/'+url+'/',image:schema.image ? base+schema.image : undefined});
}
for (const [category, items] of Object.entries(catalog)) {
 const slug=slugs[category];
 const cards=items.map(item=>{
  const url=`catalog/${slug}/${item.id}`;
  const photos=item.photos?.length ? item.photos : [item.photo];
  if (!photos[0] || !fs.existsSync(path.join(root,photos[0]))) throw Error('Missing image: '+item.id);
  const composition=(item.composition || []).map(line=>`<li>${escape(line)}</li>`).join('');
  const desc=`${item.name} — ${item.price} в цветочном магазине Аура, Оренбург. ${item.composition.length ? 'Состав: '+item.composition.join(', ')+'. ' : ''}Фото перед отправкой. Заказ с доставкой или самовывозом.`;
  const ref=`/#category=${slug}&product=${item.id}`;
  write(url,`${item.name} — ${item.price} в Оренбурге | Аура`,desc,
   `<nav aria-label="Хлебные крошки"><a href="/">Главная</a> / <a href="/catalog/${slug}/">${category}</a> / ${escape(item.name)}</nav><article class="detail"><div>${photos.map((photo,i)=>`<img class="detail-photo" src="${photo}" alt="${escape(item.name)}${i ? ', фото '+(i+1) : ''}" ${i?'loading="lazy"':'fetchpriority="high"'} width="640" height="853">`).join('')}</div><div><h1>${escape(item.name)}</h1><p class="price">${item.price}</p>${composition?'<h2>Состав</h2><ul>'+composition+'</ul>':''}<p>Закажите в цветочном магазине «Аура» в Оренбурге. Перед отправкой присылаем фото готового букета.</p><a class="button" href="${ref}">Выбрать и заказать</a><p>На странице заказа нажмите «Хочу такой» или «Хочу похожий» — выбранный товар сохранится в заявке.</p><p>Наличие, время и стоимость доставки согласуем при подтверждении заказа.</p></div></article>`,
   {'@type':'Product',name:item.name,sku:item.id,description:desc,image:photos[0],url:base+'/'+url+'/',offers:{'@type':'Offer',url:base+'/'+url+'/',priceCurrency:'RUB',price:Number(item.price.replace(/\D/g,'')),seller:{'@type':'Florist',name:business.name,url:base+'/'}}});
  return `<article class="product-card"><a href="/${url}/"><img src="${photos[0]}" alt="${escape(item.name)}" width="640" height="853" loading="lazy"><h2>${escape(item.name)}</h2></a><p class="price">${item.price}</p>${composition?'<details><summary>Состав букета</summary><ul>'+composition+'</ul></details>':''}<a class="button" href="${ref}">Хочу такой</a></article>`;
 }).join('');
 write('catalog/'+slug,`${category} с доставкой в Оренбурге — цены и фото | Аура`,`${category} в Оренбурге: фото, цены и состав. Заказ в цветочном магазине Аура, доставка и самовывоз с ул. С. Лазо, 8/1.`, `<nav aria-label="Хлебные крошки"><a href="/">Главная</a> / ${category}</nav><h1>${category} с доставкой по Оренбургу</h1><p>Выберите ${category==='Цветы поштучно'?'цветы для своего букета':'букет по фото и составу'}. Детали заказа согласуем с вами, перед отправкой пришлём фото.</p><nav>${Object.entries(slugs).map(([name,s])=>`<a href="/catalog/${s}/">${name}</a>`).join(' · ')}</nav><div class="grid">${cards}</div>`,{'@type':'CollectionPage',name:category,url:base+'/catalog/'+slug+'/',mainEntity:{'@type':'ItemList',itemListElement:items.map((p,i)=>({'@type':'ListItem',position:i+1,url:base+'/catalog/'+slug+'/'+p.id+'/',name:p.name}))}});
}
fs.writeFileSync(path.join(root,'sitemap.xml'),`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${urls.map(item=>`  <url><loc>${item.url}</loc>${item.image?'<image:image><image:loc>'+item.image+'</image:loc></image:image>':''}</url>`).join('\n')}\n</urlset>\n`);
console.log(`Generated ${urls.length-1} catalog pages and sitemap.`);
