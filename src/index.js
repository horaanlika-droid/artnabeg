const config = require('./config');
const { app } = require('./server');
const { setupBot } = require('./bot');

(async () => {
  if (config.BOT_TOKEN) {
    try { await setupBot(); }
    catch (e) { console.error('[bot] не запустился:', e.message); }
  }
  app.listen(config.PORT, '0.0.0.0', () => {
    console.log(`[артнабег] http://0.0.0.0:${config.PORT}`);
    console.log(`  лендинг:  /`);
    console.log(`  мини-апп: /app`);
    console.log(`  демо-вход: ${config.ALLOW_DEMO ? 'включен' : 'выключен'}`);
    console.log(`  кошелёк(грам): ${config.TON_API_BASE} ${config.TON_API_KEY ? '(ключ есть)' : '(без ключа)'}`);
    console.log(`  комиссия площадки: ${config.COMMISSION_PERCENT}%`);
  });
})();
