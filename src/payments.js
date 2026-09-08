const config = require('./config');

// Приём платежей в TON ("грам") через Crypto Bot API (pay.crypt.bot).
// Если CRYPTO_BOT_TOKEN не задан — работаем в демо-режиме оплаты.
async function createInvoice(order) {
  if (!config.CRYPTO_BOT_TOKEN) return null;
  try {
    const res = await fetch('https://pay.crypt.bot/api/createInvoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Crypto-Pay-API-Token': config.CRYPTO_BOT_TOKEN },
      body: JSON.stringify({
        asset: 'TON',
        amount: String(order.amount_milli / 1000),
        description: `АРТНАБЕГ: заказ #${order.id}`,
        payload: `order:${order.id}`,
        allow_comments: false,
        allow_anonymous: false,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    if (data.ok) return { pay_url: data.result.pay_url, invoice_id: data.result.invoice_id };
    console.error('cryptobot:', data.error);
    return null;
  } catch (e) {
    console.error('cryptobot error:', e.message);
    return null;
  }
}

async function getInvoices(ids) {
  if (!config.CRYPTO_BOT_TOKEN) return [];
  try {
    const res = await fetch(`https://pay.crypt.bot/api/getInvoices?invoice_ids=${ids.join(',')}`, {
      headers: { 'Crypto-Pay-API-Token': config.CRYPTO_BOT_TOKEN },
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    return data.ok ? data.result.items : [];
  } catch { return []; }
}

module.exports = { createInvoice, getInvoices };
