const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const config = require('./config');
const store = require('./db');
const ton = require('./ton');
const payments = require('./payments');
const { sendMessage } = require('./telegram');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// ---------- static ----------
app.get('/app', (req, res) => res.sendFile(path.join(config.paths.public, 'app.html')));
app.get('/app/', (req, res) => res.sendFile(path.join(config.paths.public, 'app.html')));
app.use('/app', express.static(config.paths.public, { index: 'app.html' }));
app.use('/uploads', express.static(config.paths.uploads, { maxAge: '7d' }));
app.use(express.static(config.paths.public, { index: 'index.html' }));

// ---------- auth (cookie: uid.exp.sig) ----------
function sign(payload) {
  return crypto.createHmac('sha256', config.SESSION_SECRET).update(payload).digest('base64url');
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1));
  });
  return out;
}
function setSession(res, userId) {
  const exp = Date.now() + 90 * 24 * 3600 * 1000;
  const payload = `${userId}.${exp}`;
  res.setHeader('Set-Cookie', `anb_session=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${90 * 24 * 3600}`);
}
function clearSession(res) {
  res.setHeader('Set-Cookie', 'anb_session=; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=0');
}
function currentUser(req) {
  const raw = parseCookies(req).anb_session;
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [uid, exp, sig] = parts;
  if (sign(`${uid}.${exp}`) !== sig || Number(exp) < Date.now()) return null;
  return store.getUserById(Number(uid));
}

// Telegram Mini App initData verification
function verifyInitData(initData) {
  const secret = crypto.createHmac('sha256', 'WebAppData').update(config.BOT_TOKEN).digest();
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`).join('\n');
  const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return { ok: computed === hash, params };
}

const h = fn => (req, res) => { Promise.resolve(fn(req, res)).catch(e => {
  console.error('[api]', e); res.status(500).json({ error: e.message || 'server error' });
}); };
function requireUser(req, res) {
  const u = currentUser(req);
  if (!u) { res.status(401).json({ error: 'auth required' }); return null; }
  return u;
}
function requireAdmin(req, res) {
  const u = requireUser(req, res);
  if (!u) return null;
  if (!config.isAdmin(u.tg_id)) { res.status(403).json({ error: 'admin only' }); return null; }
  return u;
}

// ---------- uploads ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.paths.uploads),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + crypto.randomBytes(4).toString('hex') + path.extname(file.originalname || '.jpg')),
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /image\/(jpeg|png|webp|gif)/.test(file.mimetype)),
});

// ================= AUTH =================
app.post('/api/auth/telegram', h(async (req, res) => {
  const { initData } = req.body;
  if (!config.BOT_TOKEN) return res.status(500).json({ error: 'BOT_TOKEN не настроен' });
  const v = verifyInitData(initData || '');
  if (!v.ok) return res.status(401).json({ error: 'подпись Telegram неверна' });
  const tgUser = JSON.parse(v.params.get('user'));
  const user = store.upsertTelegramUser({
    tg_id: tgUser.id, username: tgUser.username, first_name: tgUser.first_name,
    photo_url: tgUser.photo_url,
  });
  setSession(res, user.id);
  res.json({ ok: true, user: publicUser(user), is_admin: config.isAdmin(user.tg_id) });
}));

// dev/demo вход без реального Telegram (только когда ALLOW_DEMO=1)
app.post('/api/auth/dev', h(async (req, res) => {
  if (!config.ALLOW_DEMO) return res.status(403).json({ error: 'демо-вход выключен' });
  const tgId = Number(req.body.tg_id) || 666000001;
  const user = store.upsertTelegramUser({ tg_id: tgId, username: req.body.username || 'demo_user', first_name: req.body.first_name || 'Гость' });
  setSession(res, user.id);
  res.json({ ok: true, user: publicUser(user), is_admin: config.isAdmin(user.tg_id) });
}));

app.post('/api/auth/logout', h(async (req, res) => { clearSession(res); res.json({ ok: true }); }));

function publicUser(u) {
  return {
    id: u.id, tg_id: u.tg_id, username: u.username, first_name: u.first_name, photo_url: u.photo_url,
    is_artist: !!u.is_artist, artist_name: u.artist_name, artist_bio: u.artist_bio, artist_city: u.artist_city,
    balance_milli: u.balance_milli, wallet_address: u.wallet_address, wallet_verified: !!u.wallet_verified,
  };
}

// ================= ME / PROFILE =================
app.get('/api/me', h(async (req, res) => {
  const u = currentUser(req);
  if (!u) return res.json({ user: null });
  res.json({ user: publicUser(u), is_admin: config.isAdmin(u.tg_id), commission: config.COMMISSION_PERCENT });
}));

app.post('/api/me/profile', h(async (req, res) => {
  const u = requireUser(req, res); if (!u) return;
  const user = store.setArtistProfile(u.id, req.body);
  res.json({ ok: true, user: publicUser(user) });
}));

// ================= ARTWORKS =================
app.get('/api/artworks', h(async (req, res) => {
  const items = store.listArtworks({ q: req.query.q, category: req.query.category, art_type: req.query.art_type, sort: req.query.sort, artist_id: req.query.artist_id });
  const price = tonPriceCache;
  res.json({ items, ton_usd: price.usd });
}));

app.get('/api/artworks/mine', h(async (req, res) => {
  const u = requireUser(req, res); if (!u) return;
  res.json({ items: store.myArtworks(u.id) });
}));

app.get('/api/artworks/:id', h(async (req, res) => {
  const a = store.getArtwork(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const u = currentUser(req);
  const canSee = a.status === 'approved' || (u && (u.id === a.artist_id || config.isAdmin(u.tg_id)));
  if (!canSee) return res.status(404).json({ error: 'not found' });
  res.json({ artwork: a, nft: store.getNftByArtwork(a.id) || null });
}));

app.post('/api/artworks', upload.single('image'), h(async (req, res) => {
  const u = requireUser(req, res); if (!u) return;
  if (!req.file) return res.status(400).json({ error: 'нужно изображение' });
  const { title, description, category, art_type, medium, year, location } = req.body;
  const priceTon = parseFloat(String(req.body.price).replace(',', '.'));
  if (!title || !title.trim()) return res.status(400).json({ error: 'укажи название' });
  if (!(priceTon > 0)) return res.status(400).json({ error: 'укажи цену в TON' });
  const a = store.createArtwork(u.id, {
    title: title.trim(), description, category, art_type: art_type === 'physical' ? 'physical' : 'digital',
    medium, year: year ? parseInt(year, 10) : null, location, price_milli: Math.round(priceTon * 1000),
    image_path: '/uploads/' + req.file.filename,
  });
  store.setArtistProfile(u.id, { artist_name: u.artist_name || u.first_name, artist_bio: u.artist_bio, artist_city: u.artist_city });
  // уведомление админу о новой работе на модерации
  if (config.ADMIN_ID) {
    sendMessage(config.BOT_TOKEN, config.ADMIN_ID,
      `⏳ <b>Новая работа на модерации</b>\n#${a.id} · «${a.title}»\n${fmtTon(a.price_milli)} TON · ${a.art_type === 'physical' ? 'физическая' : 'NFT'}\nАвтор: ${u.artist_name || u.first_name}${u.username ? ' @' + u.username : ''}\n\n${config.PUBLIC_URL ? `${config.PUBLIC_URL}/app/#/admin` : 'Открой админку в мини-аппе'}`).catch(() => {});
  }
  res.json({ ok: true, artwork: a });
}));

app.delete('/api/artworks/:id', h(async (req, res) => {
  const u = requireUser(req, res); if (!u) return;
  const a = store.getArtwork(req.params.id);
  if (!a || a.artist_id !== u.id) return res.status(404).json({ error: 'not found' });
  if (a.is_sold) return res.status(400).json({ error: 'работа продана' });
  store.db.prepare('DELETE FROM artworks WHERE id=?').run(a.id);
  if (a.image_path && a.image_path.startsWith('/uploads/')) {
    fs.unlink(path.join(config.paths.uploads, path.basename(a.image_path)), () => {});
  }
  res.json({ ok: true });
}));

// ================= NFT =================
app.get('/api/nfts/mine', h(async (req, res) => {
  const u = requireUser(req, res); if (!u) return;
  res.json({ items: store.myNfts(u.id) });
}));

// ================= ORDERS =================
app.post('/api/orders', h(async (req, res) => {
  const u = requireUser(req, res); if (!u) return;
  const a = store.getArtwork(req.body.artwork_id);
  if (!a || a.status !== 'approved' || a.is_sold) return res.status(400).json({ error: 'работа недоступна' });
  if (a.artist_id === u.id) return res.status(400).json({ error: 'нельзя купить свою работу' });
  const o = store.createOrder({ artwork: a, buyer: u });
  const invoice = await payments.createInvoice(o);
  res.json({ ok: true, order: o, pay_url: invoice ? invoice.pay_url : null, demo: !invoice });
}));

// демо-оплата (когда CRYPTO_BOT_TOKEN не задан)
app.post('/api/orders/:id/pay-demo', h(async (req, res) => {
  if (!config.ALLOW_DEMO) return res.status(403).json({ error: 'выключено' });
  const u = requireUser(req, res); if (!u) return;
  const o = store.getOrder(req.params.id);
  if (!o || o.buyer_id !== u.id || o.status !== 'created') return res.status(400).json({ error: 'заказ нельзя оплатить' });
  await markPaid(o, 'demo-tx-' + crypto.randomBytes(5).toString('hex'));
  res.json({ ok: true, order: store.getOrder(o.id) });
}));

// оплата существующего заказа (инвойс или демо)
app.post('/api/orders/:id/pay', h(async (req, res) => {
  const u = requireUser(req, res); if (!u) return;
  const o = store.getOrder(req.params.id);
  if (!o || o.buyer_id !== u.id || o.status !== 'created') return res.status(400).json({ error: 'заказ нельзя оплатить' });
  const invoice = await payments.createInvoice(o);
  if (invoice) return res.json({ pay_url: invoice.pay_url });
  if (!config.ALLOW_DEMO) return res.status(400).json({ error: 'платежи не настроены' });
  await markPaid(o, 'demo-tx-' + crypto.randomBytes(5).toString('hex'));
  res.json({ ok: true, demo: true, order: store.getOrder(o.id) });
}));

app.post('/api/orders/:id/ship', h(async (req, res) => {
  const u = requireUser(req, res); if (!u) return;
  const o = store.getOrder(req.params.id);
  if (!o || o.seller_id !== u.id || o.kind !== 'physical' || o.status !== 'paid') return res.status(400).json({ error: 'нельзя отправить' });
  const upd = store.setOrderStatus(o.id, 'shipped', 'Продавец отправил работу. Средства заморожены в гаранте до подтверждения получения.', { tracking: req.body.tracking || '' });
  notifyOrder(u, o, `📦 Покупатель отправил работу? Нет — <b>ты отправил</b> работу «${o.title}». Деньги придут после подтверждения покупателем.`);
  res.json({ ok: true, order: upd });
}));

app.post('/api/orders/:id/confirm', h(async (req, res) => {
  const u = requireUser(req, res); if (!u) return;
  const o = store.getOrder(req.params.id);
  if (!o || o.buyer_id !== u.id) return res.status(400).json({ error: 'нет доступа' });
  if (!['paid', 'shipped'].includes(o.status)) return res.status(400).json({ error: 'заказ не в этом статусе' });
  completeOrder(o, 'Покупатель подтвердил получение');
  res.json({ ok: true, order: store.getOrder(o.id) });
}));

app.post('/api/orders/:id/cancel', h(async (req, res) => {
  const u = requireUser(req, res); if (!u) return;
  const o = store.getOrder(req.params.id);
  if (!o || o.buyer_id !== u.id) return res.status(400).json({ error: 'нет доступа' });
  if (o.status !== 'created') return res.status(400).json({ error: 'заказ уже оплачен — отмена через поддержку' });
  store.setOrderStatus(o.id, 'cancelled', 'Отменён покупателем');
  res.json({ ok: true });
}));

app.get('/api/orders', h(async (req, res) => {
  const u = requireUser(req, res); if (!u) return;
  const items = store.listOrders(u.id).map(o => ({ ...o, role: o.buyer_id === u.id ? 'buy' : 'sell', events: store.getOrderEvents(o.id) }));
  res.json({ items });
}));

app.get('/api/orders/:id', h(async (req, res) => {
  const u = requireUser(req, res); if (!u) return;
  const o = store.getOrder(req.params.id);
  if (!o || (o.buyer_id !== u.id && o.seller_id !== u.id && !config.isAdmin(u.tg_id))) return res.status(404).json({ error: 'not found' });
  res.json({ order: o, events: store.getOrderEvents(o.id) });
}));

// ---------- платёжные события ----------
async function markPaid(o, tx) {
  const a = store.getArtwork(o.artwork_id);
  store.setOrderStatus(o.id, o.kind === 'physical' ? 'paid' : 'completed',
    o.kind === 'physical' ? 'Оплата получена. Средства заморожены в гаранте площадки до доставки.' : 'Оплата получена, NFT передан покупателю.', { tx });
  store.markSold(o.artwork_id);
  if (o.kind === 'nft') {
    const tok = store.getNftByArtwork(o.artwork_id) || store.mintNft(o.artwork_id, o.seller_id);
    store.transferNft(o.artwork_id, o.buyer_id);
  }
  const buyer = store.getUserById(o.buyer_id);
  const seller = store.getUserById(o.seller_id);
  notifyOrder(buyer, o, o.kind === 'physical'
    ? `✅ Оплата прошла. <b>${fmtTon(o.amount_milli)} TON</b> заморожены в гаранте АРТНАБЕГ. Продавец отправит работу — подтверди получение, и продавец получит деньги.`
    : `✅ Оплата прошла. NFT «${o.title}» теперь твой. Токен: ${store.getNftByArtwork(o.artwork_id)?.token_str || '—'}`);
  notifyOrder(seller, o, `💸 Продана работа «${o.title}» за ${fmtTon(o.amount_milli)} TON.\nТвоя выплата после комиссии ${config.COMMISSION_PERCENT}%: <b>${fmtTon(o.payout_milli)} TON</b>${o.kind === 'physical' ? '\nСредства заморожены в гаранте до подтверждения доставки покупателем.' : ' — уже на балансе.'}${o.kind === 'nft' ? '' : '\nПосле отправки укажи трек-номер в разделе Заказы.'}`);
  if (o.kind !== 'nft' && seller && seller.wallet_verified) {
    // в реальной системе здесь был бы автопейаут по завершении; пока — зачисление на внутренний баланс
  }
}

function completeOrder(o, note) {
  store.setOrderStatus(o.id, 'completed', note || 'Сделка завершена');
  store.creditSeller(o.seller_id, o.payout_milli);
  const seller = store.getUserById(o.seller_id);
  const buyer = store.getUserById(o.buyer_id);
  notifyOrder(seller, o, `💰 Гаранта завершена. Выплата <b>${fmtTon(o.payout_milli)} TON</b> зачислена на баланс (комиссия площадки ${config.COMMISSION_PERCENT}% учтена).`);
  notifyOrder(buyer, o, `🤝 Сделка по «${o.title}» завершена. Спасибо, что поддерживаешь независимое искусство!`);
}

function notifyOrder(byUser, o, text) {
  if (byUser && byUser.tg_id && config.BOT_TOKEN) {
    sendMessage(config.BOT_TOKEN, byUser.tg_id, text).catch(() => {});
  }
}

app.post('/payments/webhook', h(async (req, res) => {
  if (config.CRYPTO_BOT_TOKEN) {
    const sig = req.headers['crypto-pay-api-signature'];
    const bodyStr = JSON.stringify(req.body);
    const check = crypto.createHmac('sha256', config.CRYPTO_BOT_TOKEN).update(bodyStr).digest('hex');
    if (sig !== check) return res.status(403).json({ error: 'bad signature' });
  }
  const b = req.body || {};
  if (b.update_type === 'invoice_paid' && String(b.payload || '').startsWith('order:')) {
    const orderId = parseInt(b.payload.split(':')[1], 10);
    const o = store.getOrder(orderId);
    if (o && o.status === 'created') await markPaid(o, 'cryptobot:' + b.invoice_id);
  }
  res.json({ ok: true });
}));

// ================= WALLET (грам через TON API) =================
const tonPriceCache = { usd: null, rub: null, ts: 0 };
async function refreshPrice() {
  const p = await ton.tonPrice();
  if (p.usd) { tonPriceCache.usd = p.usd; tonPriceCache.rub = p.rub; tonPriceCache.ts = Date.now(); }
}
refreshPrice().catch(() => {});
setInterval(refreshPrice, 5 * 60 * 1000).unref();

app.get('/api/ton/price', h(async (req, res) => {
  if (Date.now() - tonPriceCache.ts > 60000) await refreshPrice();
  res.json(tonPriceCache);
}));

app.get('/api/wallet/status', h(async (req, res) => {
  const u = requireUser(req, res); if (!u) return;
  const state = u.wallet_address ? await ton.walletState(u.wallet_address) : null;
  res.json({
    address: u.wallet_address, verified: !!u.wallet_verified,
    balance: state && state.ok ? state.balance : null,
    network: config.TON_API_BASE.includes('testnet') ? 'testnet' : 'mainnet',
  });
}));

app.post('/api/wallet/connect', h(async (req, res) => {
  const u = requireUser(req, res); if (!u) return;
  const address = String(req.body.address || '').trim();
  if (!ton.isValidTonAddress(address)) return res.status(400).json({ error: 'неверный формат TON-адреса' });
  const puzzle = `АРТНАБЕГ :: привязка кошелька :: ${u.id} :: ${crypto.randomBytes(8).toString('hex')}`;
  store.setWalletPuzzle(u.id, puzzle);
  store.setWalletAddress(u.id, address);
  res.json({ ok: true, puzzle });
}));

app.post('/api/wallet/verify', h(async (req, res) => {
  const u = requireUser(req, res); if (!u) return;
  if (!u.wallet_address || !u.wallet_puzzle) return res.status(400).json({ error: 'сначала привяжи адрес' });
  const r = await ton.verifySignature({ address: u.wallet_address, message: u.wallet_puzzle, signature: String(req.body.signature || '') });
  if (!r.verified) return res.status(400).json({ error: 'подпись не подтвердилась' + (r.error ? ': ' + r.error : '') });
  store.verifyWallet(u.id, u.wallet_address);
  res.json({ ok: true, demo: !!r.demo });
}));

// подтверждение переводом: юзер отправляет перевод на TREASURY_ADDRESS с пазлом в комментарии
app.post('/api/wallet/verify-tx', h(async (req, res) => {
  const u = requireUser(req, res); if (!u) return;
  if (!u.wallet_address || !u.wallet_puzzle) return res.status(400).json({ error: 'сначала привяжи адрес' });
  const r = await ton.verifyByTransaction({ address: u.wallet_address, puzzle: u.wallet_puzzle });
  if (!r.verified) return res.status(400).json({ error: r.error || 'не найдено' });
  store.verifyWallet(u.id, u.wallet_address);
  res.json({ ok: true, tx: r.tx || null });
}));

app.post('/api/wallet/unbind', h(async (req, res) => {
  const u = requireUser(req, res); if (!u) return;
  store.setWalletAddress(u.id, null);
  store.setWalletPuzzle(u.id, null);
  res.json({ ok: true });
}));

// ================= SUPPORT =================
app.get('/api/support', h(async (req, res) => {
  const u = requireUser(req, res); if (!u) return;
  const t = store.getOpenThread(u.id);
  res.json({ thread: t, messages: store.getMessages(t.id) });
}));

app.post('/api/support', h(async (req, res) => {
  const u = requireUser(req, res); if (!u) return;
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'пустое сообщение' });
  const t = store.getOpenThread(u.id);
  const m = store.addSupportMessage(t.id, 'user', text);
  if (config.ADMIN_ID) {
    const who = u.username ? '@' + u.username : (u.first_name || 'юзер');
    sendMessage(config.BOT_TOKEN, config.ADMIN_ID,
      `📬 <b>Тикет #${t.id}</b> · ${who}\n\n${text}\n\n<i>Ответ: reply на это сообщение, или /re ${t.id} текст</i>`).catch(() => {});
  }
  res.json({ ok: true, message: m });
}));

// ================= ARTISTS =================
app.get('/api/artists/:id', h(async (req, res) => {
  const a = store.getUserById(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const works = store.listArtworks({ artist_id: a.id });
  res.json({ artist: { id: a.id, artist_name: a.artist_name || a.first_name, username: a.username, photo_url: a.photo_url, artist_bio: a.artist_bio, artist_city: a.artist_city }, works });
}));

// ================= ADMIN =================
app.get('/api/admin/overview', h(async (req, res) => {
  const adm = requireAdmin(req, res); if (!adm) return;
  const pending = store.db.prepare(`SELECT a.*, u.artist_name, u.username FROM artworks a JOIN users u ON u.id=a.artist_id WHERE a.status='pending' ORDER BY a.created_at ASC`).all();
  const orders = store.db.prepare(`SELECT o.*, a.title, a.image_path, seller.artist_name AS seller_name, buyer.first_name AS buyer_name
     FROM orders o JOIN artworks a ON a.id=o.artwork_id JOIN users seller ON seller.id=o.seller_id JOIN users buyer ON buyer.id=o.buyer_id
     ORDER BY o.updated_at DESC LIMIT 100`).all();
  res.json({ stats: store.stats(), pending, orders, threads: store.listThreads(), commission: config.COMMISSION_PERCENT });
}));

app.post('/api/admin/artworks/:id/moderate', h(async (req, res) => {
  const adm = requireAdmin(req, res); if (!adm) return;
  const status = req.body.status === 'approved' ? 'approved' : 'rejected';
  const a = store.moderateArtwork(req.params.id, status, req.body.reason, adm.id);
  const author = store.getUserById(a.artist_id);
  notifyOrder(author, { title: a.title }, status === 'approved'
    ? `✅ Работа «${a.title}» прошла модерацию и уже в галерее АРТНАБЕГ.`
    : `❌ Работа «${a.title}» не прошла модерацию.\nПричина: ${req.body.reason || 'не указана'}`);
  res.json({ ok: true, artwork: a });
}));

app.post('/api/admin/artworks/:id/feature', h(async (req, res) => {
  const adm = requireAdmin(req, res); if (!adm) return;
  store.setFeatured(req.params.id, !!req.body.featured);
  res.json({ ok: true });
}));

app.post('/api/admin/orders/:id/status', h(async (req, res) => {
  const adm = requireAdmin(req, res); if (!adm) return;
  const o = store.getOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'not found' });
  const st = req.body.status;
  if (st === 'completed') completeOrder(o, 'Завершено администрацией АРТНАБЕГ');
  else if (st === 'refunded') {
    store.setOrderStatus(o.id, 'refunded', 'Возврат покупателю по решению администрации');
    store.db.prepare('UPDATE artworks SET is_sold=0 WHERE id=?').run(o.artwork_id);
    const buyer = store.getUserById(o.buyer_id);
    notifyOrder(buyer, o, '↩️ По твоему заказу оформлен возврат. Средства вернутся на твой счёт.');
  } else if (st === 'cancelled') {
    store.setOrderStatus(o.id, 'cancelled', 'Отменено администрацией');
    store.db.prepare('UPDATE artworks SET is_sold=0 WHERE id=?').run(o.artwork_id);
  } else return res.status(400).json({ error: 'bad status' });
  res.json({ ok: true, order: store.getOrder(o.id) });
}));

app.get('/api/admin/support/:id/messages', h(async (req, res) => {
  const adm = requireAdmin(req, res); if (!adm) return;
  res.json({ messages: store.getMessages(req.params.id) });
}));

app.post('/api/admin/support/:id/reply', h(async (req, res) => {
  const adm = requireAdmin(req, res); if (!adm) return;
  const thread = store.getThreadWithUser(req.params.id);
  if (!thread) return res.status(404).json({ error: 'not found' });
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'пусто' });
  store.addSupportMessage(thread.id, 'admin', text);
  if (config.BOT_TOKEN && thread.tg_id) {
    sendMessage(config.BOT_TOKEN, thread.tg_id, `💬 <b>Поддержка АРТНАБЕГ</b>\n\n${text}\n\n<i>Тикет #${thread.id}</i>`).catch(() => {});
  }
  res.json({ ok: true });
}));

function fmtTon(milli) { return (milli / 1000).toFixed(2); }

app.get('/api/config', (req, res) => res.json({
  commission: config.COMMISSION_PERCENT,
  demo: !!config.ALLOW_DEMO,
  payments: !!config.CRYPTO_BOT_TOKEN,
  name: config.NAME,
}));

// ================= SPA fallback (hash-routing, просто на всякий) =================
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
  res.sendFile(path.join(config.paths.public, 'index.html'));
});

// error handler (multer и прочее)
app.use((err, req, res, next) => {
  console.error('[err]', err.message || err);
  res.status(err.status || 500).json({ error: err.message || 'error' });
});

module.exports = { app, refreshPrice };
