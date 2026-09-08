const config = require('./config');

// TON API (грам). Провайдер: tonapi.io (по умолчанию) или toncenter.com — переключается TON_API_BASE.
const BASE = (config.TON_API_BASE || 'https://tonapi.io').replace(/\/$/, '');
const IS_TONAPI = BASE.includes('tonapi');

function headers() {
  const h = {};
  if (config.TON_API_KEY) {
    if (IS_TONAPI) h['Authorization'] = `Bearer ${config.TON_API_KEY}`;
    else h['X-API-Key'] = config.TON_API_KEY;
  }
  return h;
}

async function apiGet(pathname) {
  const res = await fetch(`${BASE}${pathname}`, {
    headers: headers(),
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { const j = await res.json(); msg = j.error?.message || j.error || msg; } catch {}
    const e = new Error(msg); e.status = res.status; throw e;
  }
  return res.json();
}

// ---- курс TON ----
async function tonPrice() {
  try {
    if (IS_TONAPI) {
      const d = await apiGet('/v2/rates?tokens=ton&currencies=usd,rub');
      const ton = d.rates && d.rates.TON;
      return {
        usd: ton && ton.USD ? ton.USD.value : null,
        rub: ton && ton.RUB ? ton.RUB.value : null,
        ts: Date.now(),
      };
    }
    const d = await apiGet('/v2/rates?currencies=ton&fiats=usd,rub');
    const p = d.rates && d.rates.TON && d.rates.TON.prices;
    return { usd: p ? p.USD : null, rub: p ? p.RUB : null, ts: Date.now() };
  } catch (e) {
    return { usd: null, rub: null, error: e.message };
  }
}

// ---- состояние кошелька ----
async function walletState(address) {
  try {
    if (IS_TONAPI) {
      const d = await apiGet(`/v2/accounts/${encodeURIComponent(address)}`);
      return { ok: true, balance: d.balance, status: d.status || 'active', name: d.name || null };
    }
    const d = await apiGet(`/v2/wallet?address=${encodeURIComponent(address)}`);
    return { ok: true, balance: d.balance, status: d.status || 'active' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Верификация владения кошельком через перевод:
 * юзер отправляет любую сумму на TREASURY_ADDRESS с комментарием-пазлом.
 * Ищем транзакцию через tonapi и сверяем отправителя.
 */
async function verifyByTransaction({ address, puzzle }) {
  if (!config.TREASURY_ADDRESS) return { verified: false, error: 'не задан TREASURY_ADDRESS' };
  try {
    if (IS_TONAPI) {
      const d = await apiGet(`/v2/accounts/${encodeURIComponent(config.TREASURY_ADDRESS)}/transactions?limit=50`);
      const txs = d.transactions || [];
      for (const tx of txs) {
        const inMsg = tx.in_msg || {};
        const src = inMsg.source && inMsg.source.address;
        if (!src || norm(src) !== norm(address)) continue;
        const comment = inMsg.decoded_comment || inMsg.comment || inMsg.raw_body || '';
        if (String(comment).includes(puzzle)) return { verified: true, tx: inMsg.hash || tx.hash };
      }
      return { verified: false, error: 'перевод пока не найден в блокчейне' };
    }
    // toncenter: без tx-индекса — не поддерживаем, нужен tonapi
    return { verified: false, error: 'для подтверждения переводом укажи TON_API_BASE=https://tonapi.io' };
  } catch (e) {
    return { verified: false, error: e.message };
  }
}

function norm(a) { return String(a || '').toUpperCase().replace(/^0:/, '-0:'); }

// Попытка серверной проверки подписи (если провайдер умеет)
async function verifySignature({ address, message, signature }) {
  if (config.ALLOW_DEMO && signature === 'demo') return { verified: true, demo: true };
  try {
    const d = await fetch(`${BASE}/v2/wallet/verifySignature`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, message, signature }),
      signal: AbortSignal.timeout(9000),
    });
    if (d.ok) { const j = await d.json(); return { verified: !!j.ok }; }
    return { verified: false, error: 'провайдер не поддерживает проверку подписи — подтверди переводом' };
  } catch (e) {
    return { verified: false, error: e.message };
  }
}

function isValidTonAddress(addr) {
  return /^-?0:[0-9a-fA-F]{64}$/.test(addr) || /^EQ[A-Za-z0-9_-]{46}$/.test(addr) || /^UQ[A-Za-z0-9_-]{46}$/.test(addr);
}

module.exports = { tonPrice, walletState, verifyByTransaction, verifySignature, isValidTonAddress };
