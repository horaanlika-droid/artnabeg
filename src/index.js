const config = require('./config');
const { app } = require('./server');
const { setupBot } = require('./bot');

// ---------- диагностика конфига при старте ----------
function mask(s, keep = 4) {
  if (!s) return '❌ не задан';
  const tail = s.length > keep + 4 ? '…' + s.slice(-keep) : '';
  return '✅ ' + s.slice(0, keep) + tail;
}
function diag() {
  const lines = [];
  lines.push('────────── КОНФИГ АРТНАБЕГ ──────────');
  lines.push(`BOT_TOKEN         ${config.BOT_TOKEN ? '✅ задан (' + config.BOT_TOKEN.split(':')[0] + ':…)' : '❌ НЕ ЗАДАН — бот выключен'}`);
  lines.push(`ADMIN_ID          ${config.ADMIN_ID ? '✅ ' + config.ADMIN_ID : '❌ НЕ ЗАДАН — админка и поддержка не заработают'}`);
  lines.push(`PUBLIC_URL        ${config.PUBLIC_URL || '⚠️  не задан — кнопка мини-аппа в боте не появится'}`);
  lines.push(`TON_API_BASE      ${config.TON_API_BASE}`);
  lines.push(`TON_API_KEY       ${config.TON_API_KEY ? '✅ задан' : '⚠️  нет ключа — рискуешь упереться в лимиты tonapi'}`);
  lines.push(`TREASURY_ADDRESS  ${config.TREASURY_ADDRESS || '❌ НЕ ЗАДАН — приём оплат и привязка кошельков переводом не работают'}`);
  lines.push(`CRYPTO_BOT_TOKEN  ${config.CRYPTO_BOT_TOKEN ? '✅ оплаты через Crypto Pay' : '⚠️  нет — работает демо-оплата'}`);
  lines.push(`SESSION_SECRET    ${config.SESSION_SECRET.includes('dev-secret') || config.SESSION_SECRET === 'сменить-на-случайную-строку' ? '⚠️  дефолт — замени на случайную строку' : '✅ задан'}`);
  lines.push(`ALLOW_DEMO        ${config.ALLOW_DEMO ? '⚠️  1 (демо-вход и демо-оплата ВКЛЮЧЕНЫ — в проде поставь 0)' : '✅ 0'}`);
  lines.push(`PORT              ${config.PORT}`);
  lines.push('──────────────────────────────────────');
  console.log(lines.join('\n'));
  if (!config.BOT_TOKEN || !config.ADMIN_ID) {
    console.warn('⚠️  Создай .env в корне проекта (он не хранится в git!) или задай переменные в панели хостинга. Шаблон — .env.example');
  }
}

(async () => {
  diag();
  if (config.BOT_TOKEN) {
    try { await setupBot(); }
    catch (e) { console.error('[bot] не запустился:', e.message); }
  }
  app.listen(config.PORT, '0.0.0.0', () => {
    console.log(`[артнабег] http://0.0.0.0:${config.PORT}`);
    console.log(`  лендинг:  /`);
    console.log(`  мини-апп: /app`);
    console.log(`  комиссия площадки: ${config.COMMISSION_PERCENT}%`);
  });
})();
