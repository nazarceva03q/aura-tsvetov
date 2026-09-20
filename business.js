/* Confirmed address: owner, 9 September 2026. Other values retained from the site. */
(function (root) {
  var business = {
    name: 'Аура',
    phone: '+79033676077',
    phoneDisplay: '+7 903 367-60-77',
    address: 'ул. С. Лазо, 8/1',
    city: 'Оренбург',
    hours: 'Ежедневно 8:00–20:00',
    email: 'aura-mc@mail.ru',
    maxUrl: 'https://max.ru/id560903131285_bot',
    leadWebhook: 'https://functions.yandexcloud.net/d4e6kng4d21ne34l3665',
    // JSON-файл каталога товаров в ПУБЛИЧНОМ бакете Yandex Object Storage —
    // сайт подгружает его поверх встроенного каталога ниже (index.html,
    // var CATALOG), чтобы показывать товары, добавленные/изменённые через
    // бота Max владелицей (bot/src/admin.js, bot/src/products.js). Пусто —
    // сайт продолжает работать со встроенным каталогом (ничего не ломается),
    // просто новые товары из бота на сайте не появятся, пока не заполните
    // эту ссылку после настройки бакета (bot/README.md, раздел «Публичный
    // бакет для каталога»). Формат:
    //   https://storage.yandexcloud.net/<имя бакета>/catalog.json
    catalogUrl: 'https://storage.yandexcloud.net/aura-catalog/catalog.json',
    mapsUrl: 'https://yandex.ru/maps/org/aura/235676666509/',
    reviewsUrl: 'https://yandex.ru/maps/org/aura/235676666509/reviews/',
    delivery: 'Доставляем в течение дня, с 8:00 до 20:00. Точное время и стоимость согласуем при подтверждении заказа.',
    deliveryOffer: 'Бесплатная доставка от 5 000 ₽.',
    payment: 'Наличными курьеру или переводом при получении.'
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = business;
  else root.AURA_BUSINESS = Object.freeze(business);
})(typeof window !== 'undefined' ? window : globalThis);
