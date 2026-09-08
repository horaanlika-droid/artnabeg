const fs = require('fs');
const path = require('path');
const { Bot, InlineKeyboard } = require('grammy');
const config = require('./config');
const store = require('./db');
const { sendMessage } = require('./telegram');

const WEBAPP_URL = config.PUBLIC_URL ? `${config.PUBLIC_URL}/app` : '';

function mainMenuKeyboard() {
  const kb = new InlineKeyboard();
  if (WEBAPP_URL) kb.webApp('🖼 Открыть АРТНАБЕГ', WEBAPP_URL);
  kb.text('🎨 Мои работы', 'my_works').row();
  kb.text('📦 Мои заказы', 'my_orders').text('💬 Поддержка', 'support').row();
  kb.text('💰 Кошелёк', 'wallet').text('ℹ️ О площадке', 'about').row();
  return kb;
}

function adminKeyboard() {
  const kb = new InlineKeyboard();
  if (WEBAPP_URL) kb.webApp('🛠 Админ-панель', `${config.PUBLIC_URL}/app/#/admin`);
  kb.text('⏳ Модерация', 'adm_queue').row();
  kb.text('📬 Тикеты', 'adm_tickets').text('📊 Статистика', 'adm_stats').row();
  return kb;
}

function fmtTon(milli) { return (milli / 1000).toFixed(2); }

async function notifyUser(dbUser, text) {
  if (dbUser && dbUser.tg_id) {
    try { await sendMessage(config.BOT_TOKEN, dbUser.tg_id, text); } catch (e) { /* юзер не писал боту */ }
  }
}

async function setupBot() {
  if (!config.BOT_TOKEN) {
    console.warn('[bot] BOT_TOKEN не задан — бот выключен');
    return null;
  }
  const bot = new Bot(config.BOT_TOKEN);

  bot.catch((err) => console.error('[bot]', err.error || err));

  bot.command('start', async (ctx) => {
    const isAdm = ctx.from && config.isAdmin(ctx.from.id);
    const text = isAdm
      ? `<b>АРТНАБЕГ · панель админа</b>\n\nОтвечай в поддержке: просто жми «Ответить» (reply) на сообщение тикета и пиши текст.\n\nКоманды:\n/admin — панель\n/tickets — открытые тикеты\n/re R123 текст — ответ на заказ`
      : `<b>АРТНАБЕГ</b> — искусство вне системы. Теперь on-chain.\n\nГалерея независимых художников: NFT и физические работы с гарантией сделки.\nКомиссия площадки — ${config.COMMISSION_PERCENT}%.`;
    await ctx.reply(text, { reply_markup: isAdm ? adminKeyboard() : mainMenuKeyboard() });
  });

  bot.command('help', (ctx) => ctx.reply(
    `Команды:\n/me — профиль\n/wallet — привязка кошелька\n/orders — заказы\n/support — поддержка\n/about — о площадке`,
    { reply_markup: mainMenuKeyboard() }));

  bot.command('about', (ctx) => ctx.reply(
    `<b>АРТНАБЕГ</b> — NFT-галерея андеграунд художников.\nИскусство вне стен. Теперь on-chain.\n\n• NFT и физические работы\n• Гарантия сделки: деньги замораживаются на время доставки\n• Комиссия площадки ${config.COMMISSION_PERCENT}%\n• Публикация только через модерацию`,
    { reply_markup: mainMenuKeyboard() }));

  bot.command('admin', async (ctx) => {
    if (!config.isAdmin(ctx.from.id)) return;
    await ctx.reply('<b>Панель админа</b>', { reply_markup: adminKeyboard() });
  });

  bot.command('me', async (ctx) => {
    const u = store.getUserByTgId(ctx.from.id);
    if (!u) return ctx.reply('Открой мини-апп, чтобы войти.', { reply_markup: mainMenuKeyboard() });
    const wallet = u.wallet_address ? `${u.wallet_verified ? '✅' : '⏳'} <code>${u.wallet_address}</code>` : 'не привязан';
    await ctx.reply(
      `<b>${u.artist_name || u.first_name}</b>${u.username ? ' @' + u.username : ''}\n` +
      `Роль: ${u.is_artist ? 'художник' : 'зритель'}\nБаланс: ${fmtTon(u.balance_milli)} TON\nКошелёк: ${wallet}`,
      { reply_markup: mainMenuKeyboard() });
  });

  bot.command('wallet', async (ctx) => {
    const addr = (ctx.match || '').trim();
    if (!addr) {
      return ctx.reply(
        'Привяжи TON-кошелёк (грам):\n1. Открой мини-апп → Профиль → Кошелёк\n2. Введи адрес и подтверди подписью\n\nИли пришли адрес прямо сюда: <code>/wallet EQ…</code>');
    }
    const u = store.getUserByTgId(ctx.from.id);
    if (!u) return ctx.reply('Сначала открой мини-апп, чтобы войти.');
    if (!/^(EQ|UQ)[A-Za-z0-9_-]{46}$/.test(addr) && !/^-?1:[0-9a-fA-F]{64}$/.test(addr)) {
      return ctx.reply('Не похоже на TON-адрес. Адрес должен начинаться с EQ/UQ.');
    }
    store.setWalletAddress(u.id, addr);
    await ctx.reply(`Адрес сохранён: <code>${addr}</code>\nЧтобы верифицировать владельца — подтверди подписью в мини-апп (Профиль → Кошелёк).`);
  });

  bot.command('orders', async (ctx) => {
    const u = store.getUserByTgId(ctx.from.id);
    if (!u) return ctx.reply('Открой мини-апп, чтобы войти.');
    const orders = store.listOrders(u.id).filter(o => !['completed', 'cancelled', 'refunded'].includes(o.status));
    if (!orders.length) return ctx.reply('Активных заказов нет.');
    for (const o of orders.slice(0, 5)) {
      const role = o.buyer_id === u.id ? 'покупка' : 'продажа';
      await ctx.reply(`#${o.id} · ${role} · ${o.title}\n${fmtTon(o.amount_milli)} TON · ${o.status}\n${o.kind === 'physical' ? '📦 физическая работа — средства в гаранте' : '🖼 NFT'}`);
    }
  });

  bot.command('support', async (ctx) => {
    const u = store.getUserByAnyTgId(ctx.from.id);
    if (!u) return ctx.reply('Открой мини-апп, чтобы войти.');
    const text = (ctx.match || '').trim();
    if (!text) return ctx.reply('Напиши вопрос: <code>/support вопрос</code> — или открой чат поддержки в мини-аппе.');
    const t = store.getOpenThread(u.id);
    store.addSupportMessage(t.id, 'user', text);
    await notifyAdminsNewTicket(ctx, t, u, text);
    await ctx.reply('Отправлено в поддержку. Ответ придёт сюда и в мини-апп.');
  });

  async function notifyAdminsNewTicket(ctx, thread, user, text) {
    if (!config.ADMIN_ID) return;
    const who = user.username ? '@' + user.username : user.first_name;
    try {
      await sendMessage(config.BOT_TOKEN, config.ADMIN_ID,
        `📬 <b>Тикет #${thread.id}</b> · ${who}\n\n${text}\n\nОтвет: reply на это сообщение, или /re ${thread.id} текст`);
    } catch (e) { console.error('[bot] admin notify:', e.message); }
  }

  // ---------- inline buttons ----------
  bot.on('callback_query:data', async (ctx) => {
    const cb = ctx.callbackQuery.data;
    const u = store.getUserByTgId(ctx.from.id);
    try {
      if (cb === 'my_works') {
        if (!u || !u.is_artist) return ctx.answerCallbackQuery({ text: 'Ты ещё не художник — заполни профиль в мини-аппе' });
        const works = store.myArtworks(u.id);
        await ctx.reply(works.length
          ? works.slice(0, 10).map(w => `${w.status === 'approved' ? '✅' : w.status === 'pending' ? '⏳' : '❌'} ${w.title} — ${fmtTon(w.price_milli)} TON${w.is_sold ? ' · ПРОДАНО' : ''}`).join('\n')
          : 'Работ пока нет. Выложи первую через мини-апп!');
      } else if (cb === 'my_orders') {
        if (!u) return ctx.answerCallbackQuery({ text: 'Сначала войди через мини-апп' });
        const orders = store.listOrders(u.id);
        await ctx.reply(orders.length
          ? orders.slice(0, 10).map(o => `#${o.id} · ${o.buyer_id === u.id ? 'покупка' : 'продажа'} · ${o.title} · ${fmtTon(o.amount_milli)} TON · ${o.status}`).join('\n')
          : 'Заказов пока нет.');
      } else if (cb === 'support') {
        await ctx.reply('Напиши в мини-апп чат поддержки (Профиль → Поддержка) или командой: /support твой вопрос');
      } else if (cb === 'wallet') {
        await ctx.reply(u && u.wallet_address
          ? `Кошелёк: ${u.wallet_verified ? '✅ верифицирован' : '⏳ не верифицирован'}\n<code>${u.wallet_address}</code>`
          : 'Кошелёк не привязан. Профиль → Кошелёк в мини-аппе.');
      } else if (cb === 'about') {
        await ctx.reply('АРТНАБЕГ — искусство вне системы. Комиссия площадки ' + config.COMMISSION_PERCENT + '%.');
      } else if (cb.startsWith('adm_')) {
        if (!config.isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'Только для админа' });
        if (cb === 'adm_queue') {
          const q = store.db.prepare(`SELECT a.id, a.title, u.artist_name FROM artworks a JOIN users u ON u.id=a.artist_id WHERE a.status='pending' ORDER BY a.created_at ASC LIMIT 10`).all();
          await ctx.reply(q.length
            ? 'Очередь модерации:\n' + q.map(w => `#${w.id} · ${w.title} · ${w.artist_name || '—'}`).join('\n') + '\n\nСмотреть: мини-апп → Админ'
            : 'Очередь пуста 🎉');
        } else if (cb === 'adm_tickets') {
          const ts = store.listThreads().slice(0, 10);
          await ctx.reply(ts.length
            ? ts.map(t => `#${t.id} · ${t.username ? '@' + t.username : t.first_name}: ${(t.last_text || '').slice(0, 60)}`).join('\n') + '\n\nОтвет: reply на сообщение тикета или /re ID текст'
            : 'Открытых тикетов нет.');
        } else if (cb === 'adm_stats') {
          const s = store.stats();
          await ctx.reply(`📊 Статистика\nЮзеров: ${s.users}\nНа модерации: ${s.pending}\nВ галерее: ${s.approved}\nПродано: ${s.sold}\nЗаказов: ${s.orders}\nОборот: ${fmtTon(s.volume)} TON\nКомиссия (завершённые): ${fmtTon(s.commission)} TON\nВ гаранте: ${fmtTon(s.escrow)} TON`);
        }
      }
      await ctx.answerCallbackQuery();
    } catch (e) {
      console.error('[bot] callback:', e.message);
      try { await ctx.answerCallbackQuery({ text: 'Ошибка' }); } catch {}
    }
  });

  // ---------- reply-режим: админ отвечает на сообщения тикетов ----------
  bot.on('message:text', async (ctx) => {
    const msg = ctx.message;

    // /re <threadId> текст — ответ на тикет
    if (msg.text.startsWith('/re')) {
      if (!config.isAdmin(msg.from.id)) return;
      const m = msg.text.match(/^\/re\s+(\d+)\s+([\s\S]+)/);
      if (!m) return ctx.reply('Формат: /re ID_тикета текст');
      try {
        await adminAnswer(parseInt(m[1], 10), m[2].trim(), null);
        await ctx.reply(`✅ Отправлено в тикет #${m[1]}`);
      } catch (e) { await ctx.reply('⚠️ ' + e.message); }
      return;
    }

    // reply на сообщение тикета — ответ юзеру (только админ)
    if (!msg.reply_to_message || !config.isAdmin(msg.from.id)) return;
    const replied = msg.reply_to_message.text || msg.reply_to_message.caption || '';
    const m = replied.match(/Тикет #(\d+)/);
    if (!m) return;
    try {
      await adminAnswer(parseInt(m[1], 10), msg.text, null);
      await ctx.reply(`✅ Отправлено в тикет #${m[1]}`);
    } catch (e) { await ctx.reply('⚠️ ' + e.message); }
  });

  bot.on('message:photo', async (ctx) => {
    const msg = ctx.message;
    if (!msg.reply_to_message || !config.isAdmin(msg.from.id)) return;
    const replied = msg.reply_to_message.text || msg.reply_to_message.caption || '';
    const m = replied.match(/Тикет #(\d+)/);
    if (!m) return;
    try {
      const file = await ctx.getFile(msg.photo[msg.photo.length - 1].file_id);
      const url = `https://api.telegram.org/file/bot${config.BOT_TOKEN}/${file.file_path}`;
      await adminAnswer(parseInt(m[1], 10), msg.caption || '📷 Фото', url);
      await ctx.reply(`✅ Фото отправлено в тикет #${m[1]}`);
    } catch (e) { await ctx.reply('⚠️ ' + e.message); }
  });

  async function adminAnswer(threadId, text, photoUrl) {
    const thread = store.getThreadWithUser(threadId);
    if (!thread) throw new Error('Тикет не найден');
    store.addSupportMessage(threadId, 'admin', text);
    if (photoUrl) {
      const { sendPhoto } = require('./telegram');
      await sendPhoto(config.BOT_TOKEN, thread.tg_id, photoUrl, text).catch(() => {});
    } else {
      await notifyUser(thread, `💬 <b>Поддержка АРТНАБЕГ</b>\n\n${text}\n\n<i>Тикет #${threadId}</i>`);
    }
    return true;
  }
  bot._adminAnswer = adminAnswer;

  bot.start({ onStart: () => console.log('[bot] long polling запущен') });
  return bot;
}

module.exports = { setupBot, notifyUser };
