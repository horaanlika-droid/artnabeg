const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.dirname(config.paths.db), { recursive: true });
fs.mkdirSync(config.paths.uploads, { recursive: true });

const db = new Database(config.paths.db);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER UNIQUE,
  username TEXT,
  first_name TEXT,
  photo_url TEXT,
  is_artist INTEGER DEFAULT 0,
  artist_name TEXT,
  artist_bio TEXT,
  artist_city TEXT,
  balance_milli INTEGER DEFAULT 0,
  wallet_address TEXT,
  wallet_verified INTEGER DEFAULT 0,
  wallet_verified_at INTEGER,
  wallet_puzzle TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS artworks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  category TEXT DEFAULT 'art',
  art_type TEXT DEFAULT 'digital',           -- digital | physical
  medium TEXT DEFAULT '',
  year INTEGER,
  location TEXT DEFAULT '',
  price_milli INTEGER NOT NULL,
  image_path TEXT NOT NULL,
  status TEXT DEFAULT 'pending',             -- pending | approved | rejected
  reject_reason TEXT,
  featured INTEGER DEFAULT 0,
  is_sold INTEGER DEFAULT 0,
  created_at INTEGER,
  moderated_at INTEGER,
  moderated_by INTEGER
);

CREATE TABLE IF NOT EXISTS nft_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artwork_id INTEGER UNIQUE REFERENCES artworks(id),
  owner_id INTEGER REFERENCES users(id),
  token_str TEXT,
  mint_tx TEXT,
  network TEXT DEFAULT 'ton',
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artwork_id INTEGER NOT NULL REFERENCES artworks(id),
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  seller_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,                        -- nft | physical
  amount_milli INTEGER NOT NULL,
  commission_milli INTEGER NOT NULL,
  payout_milli INTEGER NOT NULL,
  status TEXT DEFAULT 'created',             -- created | paid | shipped | completed | cancelled | refunded
  delivery_address TEXT,
  tracking TEXT,
  tx TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  status TEXT,
  note TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS support_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT DEFAULT 'open',                -- open | answered | closed
  created_at INTEGER,
  last_message_at INTEGER
);

CREATE TABLE IF NOT EXISTS support_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES support_threads(id),
  sender TEXT NOT NULL,                      -- user | admin
  text TEXT NOT NULL,
  created_at INTEGER
);
`);

const now = () => Date.now();

// ---------- users ----------
function upsertTelegramUser(u) {
  const existing = db.prepare('SELECT * FROM users WHERE tg_id = ?').get(u.tg_id);
  if (existing) {
    db.prepare(`UPDATE users SET username=?, first_name=?, photo_url=? WHERE id=?`)
      .run(u.username || existing.username, u.first_name || existing.first_name,
           u.photo_url || existing.photo_url, existing.id);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
  }
  const info = db.prepare(`INSERT INTO users (tg_id, username, first_name, photo_url, created_at)
                           VALUES (?,?,?,?,?)`)
    .run(u.tg_id, u.username || null, u.first_name || null, u.photo_url || null, now());
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

function getUserById(id) { return db.prepare('SELECT * FROM users WHERE id = ?').get(id); }
function getUserByTgId(tgId) { return db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tgId); }
function getUserByAnyTgId(tgId) {
  // админ мог ещё ни разу не заходить в мини-апп — создаём «теневой» аккаунт для переписки
  let u = getUserByTgId(tgId);
  if (!u && String(tgId) === String(config.ADMIN_ID)) {
    const info = db.prepare(`INSERT INTO users (tg_id, first_name, is_artist, created_at) VALUES (?,?,1,?)`)
      .run(tgId, 'Админ', now());
    u = getUserById(info.lastInsertRowid);
  }
  return u;
}

function setArtistProfile(userId, { artist_name, artist_bio, artist_city }) {
  db.prepare(`UPDATE users SET is_artist=1, artist_name=?, artist_bio=?, artist_city=? WHERE id=?`)
    .run(artist_name || null, artist_bio || null, artist_city || null, userId);
  return getUserById(userId);
}

function setArtistPhoto(userId, photoUrl) {
  db.prepare('UPDATE users SET photo_url=? WHERE id=?').run(photoUrl, userId);
}

// ---------- artworks ----------
function createArtwork(artistId, data) {
  const info = db.prepare(`INSERT INTO artworks
    (artist_id, title, description, category, art_type, medium, year, location, price_milli, image_path, status, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', ?)`)
    .run(artistId, data.title, data.description || '', data.category || 'art',
         data.art_type || 'digital', data.medium || '', data.year || new Date().getFullYear(),
         data.location || '', data.price_milli, data.image_path, now());
  return db.prepare('SELECT * FROM artworks WHERE id=?').get(info.lastInsertRowid);
}

const APPROVED = `status='approved'`;

function listArtworks({ q, category, art_type, sort, artist_id, limit = 60 } = {}) {
  let sql = `SELECT a.*, u.artist_name, u.username AS artist_username, u.photo_url AS artist_photo
             FROM artworks a JOIN users u ON u.id = a.artist_id WHERE ${APPROVED}`;
  const args = [];
  if (art_type) { sql += ' AND a.art_type = ?'; args.push(art_type); }
  if (category && category !== 'all') { sql += ' AND a.category = ?'; args.push(category); }
  if (artist_id) { sql += ' AND a.artist_id = ?'; args.push(artist_id); }
  if (q) { sql += ' AND (a.title LIKE ? OR a.description LIKE ? OR u.artist_name LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += sort === 'cheap' ? ' AND a.is_sold=0 ORDER BY a.price_milli ASC'
       : sort === 'expensive' ? ' AND a.is_sold=0 ORDER BY a.price_milli DESC'
       : ' AND a.is_sold=0 ORDER BY a.featured DESC, a.created_at DESC';
  sql += ' LIMIT ?'; args.push(limit);
  return db.prepare(sql).all(...args);
}

function getArtwork(id) {
  return db.prepare(`SELECT a.*, u.artist_name, u.username AS artist_username, u.photo_url AS artist_photo,
                            u.artist_bio, u.artist_city, u.wallet_address AS artist_wallet
                     FROM artworks a JOIN users u ON u.id=a.artist_id WHERE a.id=?`).get(id);
}

function myArtworks(userId) {
  return db.prepare(`SELECT * FROM artworks WHERE artist_id=? ORDER BY created_at DESC`).all(userId);
}

function moderateArtwork(id, status, reason, adminId) {
  db.prepare(`UPDATE artworks SET status=?, reject_reason=?, moderated_at=?, moderated_by=? WHERE id=?`)
    .run(status, reason || null, now(), adminId, id);
  return getArtwork(id);
}

function setFeatured(id, val) {
  db.prepare('UPDATE artworks SET featured=? WHERE id=?').run(val ? 1 : 0, id);
}

// ---------- nft ----------
function mintNft(artworkId, ownerId) {
  const existing = db.prepare('SELECT * FROM nft_tokens WHERE artwork_id=?').get(artworkId);
  if (existing) return existing;
  const tokenStr = 'ANB-' + String(artworkId).padStart(4, '0') + '/' + String(Math.floor(Math.random() * 9000) + 1000);
  const info = db.prepare(`INSERT INTO nft_tokens (artwork_id, owner_id, token_str, network, created_at)
                           VALUES (?,?,?,?,?)`)
    .run(artworkId, ownerId, tokenStr, 'ton', now());
  return db.prepare('SELECT * FROM nft_tokens WHERE id=?').get(info.lastInsertRowid);
}

function getNftByArtwork(artworkId) { return db.prepare('SELECT * FROM nft_tokens WHERE artwork_id=?').get(artworkId); }
function transferNft(artworkId, toUserId) {
  db.prepare('UPDATE nft_tokens SET owner_id=? WHERE artwork_id=?').run(toUserId, artworkId);
}
function myNfts(userId) {
  return db.prepare(`SELECT n.*, a.title, a.image_path, a.price_milli, a.artist_id
                     FROM nft_tokens n JOIN artworks a ON a.id=n.artwork_id
                     WHERE n.owner_id=? ORDER BY n.created_at DESC`).all(userId);
}

// ---------- orders ----------
function commissionSplit(amountMilli) {
  const commission = Math.round(amountMilli * config.COMMISSION_PERCENT / 100);
  return { commission_milli: commission, payout_milli: amountMilli - commission };
}

function createOrder({ artwork, buyer }) {
  const { commission_milli, payout_milli } = commissionSplit(artwork.price_milli);
  const kind = artwork.art_type === 'physical' ? 'physical' : 'nft';
  const info = db.prepare(`INSERT INTO orders
    (artwork_id, buyer_id, seller_id, kind, amount_milli, commission_milli, payout_milli, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?, 'created', ?, ?)`)
    .run(artwork.id, buyer.id, artwork.artist_id, kind, artwork.price_milli,
         commission_milli, payout_milli, now(), now());
  addOrderEvent(info.lastInsertRowid, 'created', 'Заказ создан, ожидает оплаты');
  return getOrder(info.lastInsertRowid);
}

function getOrder(id) {
  return db.prepare(`SELECT o.*, a.title, a.image_path, a.art_type, a.category,
                            seller.artist_name AS seller_name, seller.username AS seller_username,
                            seller.wallet_address AS seller_wallet,
                            buyer.first_name AS buyer_name, buyer.username AS buyer_username
                     FROM orders o
                     JOIN artworks a ON a.id=o.artwork_id
                     JOIN users seller ON seller.id=o.seller_id
                     JOIN users buyer ON buyer.id=o.buyer_id
                     WHERE o.id=?`).get(id);
}

function setOrderStatus(id, status, note, extra = {}) {
  const sets = ['status=?', 'updated_at=?'];
  const args = [status, now()];
  for (const k of ['tx', 'tracking', 'delivery_address']) {
    if (extra[k] !== undefined) { sets.push(`${k}=?`); args.push(extra[k]); }
  }
  args.push(id);
  db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id=?`).run(...args);
  addOrderEvent(id, status, note || '');
  return getOrder(id);
}

function addOrderEvent(orderId, status, note) {
  db.prepare('INSERT INTO order_events (order_id, status, note, created_at) VALUES (?,?,?,?)')
    .run(orderId, status, note || '', now());
}

function getOrderEvents(orderId) {
  return db.prepare('SELECT * FROM order_events WHERE order_id=? ORDER BY id ASC').all(orderId);
}

function listOrders(userId) {
  return db.prepare(`SELECT o.*, a.title, a.image_path, a.art_type,
                            seller.artist_name AS seller_name,
                            buyer.first_name AS buyer_name
                     FROM orders o
                     JOIN artworks a ON a.id=o.artwork_id
                     JOIN users seller ON seller.id=o.seller_id
                     JOIN users buyer ON buyer.id=o.buyer_id
                     WHERE o.buyer_id=? OR o.seller_id=?
                     ORDER BY o.updated_at DESC LIMIT 100`).all(userId, userId);
}

function markSold(artworkId) {
  db.prepare('UPDATE artworks SET is_sold=1 WHERE id=?').run(artworkId);
}

// ---------- support ----------
function getOpenThread(userId) {
  let t = db.prepare(`SELECT * FROM support_threads WHERE user_id=? AND status!='closed' ORDER BY id DESC LIMIT 1`).get(userId);
  if (!t) {
    const info = db.prepare('INSERT INTO support_threads (user_id, created_at, last_message_at) VALUES (?,?,?)')
      .run(userId, now(), now());
    t = db.prepare('SELECT * FROM support_threads WHERE id=?').get(info.lastInsertRowid);
  }
  return t;
}

function addSupportMessage(threadId, sender, text) {
  const info = db.prepare('INSERT INTO support_messages (thread_id, sender, text, created_at) VALUES (?,?,?,?)')
    .run(threadId, sender, text, now());
  db.prepare('UPDATE support_threads SET last_message_at=? WHERE id=?').run(now(), threadId);
  if (sender === 'admin') {
    db.prepare(`UPDATE support_threads SET status='answered' WHERE id=? AND status='open'`).run(threadId);
  }
  return db.prepare('SELECT * FROM support_messages WHERE id=?').get(info.lastInsertRowid);
}

function getThreadWithUser(threadId) {
  return db.prepare(`SELECT t.*, u.first_name, u.username, u.tg_id
                     FROM support_threads t JOIN users u ON u.id=t.user_id WHERE t.id=?`).get(threadId);
}

function listThreads() {
  return db.prepare(`SELECT t.*, u.first_name, u.username,
       (SELECT text FROM support_messages m WHERE m.thread_id=t.id ORDER BY m.id DESC LIMIT 1) AS last_text,
       (SELECT COUNT(*) FROM support_messages m WHERE m.thread_id=t.id AND m.sender='user') AS user_msgs
     FROM support_threads t JOIN users u ON u.id=t.user_id
     WHERE t.status!='closed' OR t.last_message_at > ?
     ORDER BY t.last_message_at DESC LIMIT 50`).all(now() - 7 * 24 * 3600 * 1000);
}

function getMessages(threadId) {
  return db.prepare('SELECT * FROM support_messages WHERE thread_id=? ORDER BY id ASC').all(threadId);
}

// ---------- wallet ----------
function setWalletPuzzle(userId, puzzle) {
  db.prepare('UPDATE users SET wallet_puzzle=? WHERE id=?').run(puzzle, userId);
}
function verifyWallet(userId, address) {
  db.prepare(`UPDATE users SET wallet_address=?, wallet_verified=1, wallet_verified_at=?, wallet_puzzle=NULL WHERE id=?`)
    .run(address, now(), userId);
}
function setWalletAddress(userId, address) {
  db.prepare(`UPDATE users SET wallet_address=?, wallet_verified=0, wallet_verified_at=NULL WHERE id=?`)
    .run(address, userId);
}
function creditSeller(sellerId, payoutMilli) {
  db.prepare('UPDATE users SET balance_milli = balance_milli + ? WHERE id=?').run(payoutMilli, sellerId);
}

// ---------- stats ----------
function stats() {
  const one = (sql, ...args) => db.prepare(sql).get(...args).v;
  return {
    users: one('SELECT COUNT(*) v FROM users'),
    pending: one(`SELECT COUNT(*) v FROM artworks WHERE status='pending'`),
    approved: one(`SELECT COUNT(*) v FROM artworks WHERE status='approved'`),
    sold: one('SELECT COUNT(*) v FROM artworks WHERE is_sold=1'),
    orders: one('SELECT COUNT(*) v FROM orders'),
    volume: one(`SELECT COALESCE(SUM(amount_milli),0) v FROM orders WHERE status IN ('paid','shipped','completed')`),
    commission: one(`SELECT COALESCE(SUM(commission_milli),0) v FROM orders WHERE status='completed'`),
    escrow: one(`SELECT COALESCE(SUM(amount_milli),0) v FROM orders WHERE status='paid' AND kind='physical'`),
    threads: one(`SELECT COUNT(*) v FROM support_threads WHERE status!='closed'`),
  };
}

module.exports = {
  db, now,
  upsertTelegramUser, getUserById, getUserByTgId, getUserByAnyTgId,
  setArtistProfile, setArtistPhoto,
  createArtwork, listArtworks, getArtwork, myArtworks, moderateArtwork, setFeatured,
  mintNft, getNftByArtwork, transferNft, myNfts,
  commissionSplit, createOrder, getOrder, setOrderStatus, addOrderEvent, getOrderEvents, listOrders, markSold,
  getOpenThread, addSupportMessage, getThreadWithUser, listThreads, getMessages,
  setWalletPuzzle, verifyWallet, setWalletAddress, creditSeller,
  stats,
};
