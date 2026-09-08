const https = require('https');

function callTelegram(method, token, payload) {
  return new Promise((resolve, reject) => {
    if (!token) return reject(new Error('BOT_TOKEN не задан'));
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          j.ok ? resolve(j.result) : reject(new Error(j.description || 'Telegram error'));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

function sendMessage(token, chatId, text, extra = {}) {
  return callTelegram('sendMessage', token, { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
}
function sendPhoto(token, chatId, photo, caption, extra = {}) {
  return callTelegram('sendPhoto', token, { chat_id: chatId, photo, caption, parse_mode: 'HTML', ...extra });
}

module.exports = { callTelegram, sendMessage, sendPhoto };
