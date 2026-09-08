// Наполняет базу демо-контентом: художники, работы из репо, выставки.
// Запуск: npm run seed
const fs = require('fs');
const path = require('path');
const config = require('./config');
const store = require('./db');

const IMG = [
  { file: 'IMG_6710.jpeg', title: 'flow_of_light.vol 2', artist: 'ogonek team', city: 'Санкт-Петербург', price: 0.35, type: 'physical', cat: 'photo', desc: 'Стрит-фотография с выставки flow_of_light.vol 2. Ломоносова, 2. Отпечаток на баритовой бумаге, подписанный автором.', medium: 'фотопечать, баритовая бумага', location: 'Санкт-Петербург' },
  { file: 'IMG_6711.jpeg', title: 'sebastianfolter.vol 3', artist: 'ogonek team', city: 'Санкт-Петербург', price: 0.5, type: 'physical', cat: 'graphics', desc: 'Коллаж/графика с третьей части выставочной серии. Аналоговый процесс, ручная печать.', medium: 'коллаж, ручная печать', location: 'Санкт-Петербург' },
  { file: 'IMG_1588.png', title: 'not here', artist: 'whale.bones', city: 'Санкт-Петербург', price: 0.42, type: 'digital', cat: 'graphics', desc: 'Работа о том, как легко потеряться в шуме. Холст, акрил, спрей — теперь on-chain.', medium: 'цифровая версия оригинала' },
  { file: 'IMG_1607.png', title: 'after the rave', artist: 'mashkov', city: 'Москва', price: 0.28, type: 'digital', cat: 'photo', desc: 'Утро после. Серия снимков с квартирников и рейвов — то, что не попадает в афиши.', medium: 'плёнка 35мм, скан' },
  { file: 'IMG_6684.jpeg', title: 'цдхой. открытo', artist: 'ogonek team', city: 'Санкт-Петербург', price: 0.18, type: 'physical', cat: 'photo', desc: 'Вход в кофейню, где начинались наши выставки. Афиша на зеркале — памятник месту и времени.', medium: 'фотопечать, 30×40', location: 'Санкт-Петербург' },
  { file: 'IMG_6685.jpeg', title: 'арка на ломоносова', artist: 'ogonek team', city: 'Санкт-Петербург', price: 0.22, type: 'physical', cat: 'photo', desc: 'Двор-колодец, арки и первые постеры галереи. Всё началось здесь.', medium: 'фотопечать, 40×60', location: 'Санкт-Петербург' },
];

fs.mkdirSync(config.paths.uploads, { recursive: true });

const created = [];
for (const item of IMG) {
  const src = path.join(__dirname, '..', item.file);
  if (!fs.existsSync(src)) { console.warn('нет файла', item.file); continue; }
  const dest = path.join(config.paths.uploads, 'seed-' + item.file);
  if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);

  // художник
  let artist = store.db.prepare('SELECT * FROM users WHERE artist_name=?').get(item.artist);
  if (!artist) {
    const tgId = 700000000 + Math.floor(Math.random() * 99999999);
    const info = store.db.prepare('INSERT INTO users (tg_id, username, first_name, is_artist, artist_name, artist_bio, artist_city, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(tgId, item.artist.replace(/[.\s]+/g, '_'), item.artist, 1, item.artist,
        'Независимый художник. Уличная культура, шум и память.', item.city, Date.now());
    artist = store.getUserById(info.lastInsertRowid);
  }

  const a = store.createArtwork(artist.id, {
    title: item.title,
    description: item.desc,
    category: item.cat,
    art_type: item.type,
    medium: item.medium,
    year: 2025,
    location: item.location || '',
    price_milli: Math.round(item.price * 1000),
    image_path: '/uploads/seed-' + item.file,
  });
  store.moderateArtwork(a.id, 'approved', null, 0);
  if (item.type === 'digital') store.mintNft(a.id, artist.id);
  created.push(`${a.id} · ${item.title} (${item.type})`);
}

//featured — первая и третья
store.setFeatured(1, true);

// демо-пользователь для входа без Telegram
store.upsertTelegramUser({ tg_id: 666000001, username: 'demo_user', first_name: 'Демо' });

console.log('Сид готов:\n' + created.map(s => '  ✅ ' + s).join('\n'));
