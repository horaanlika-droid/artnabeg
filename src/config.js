require('dotenv').config();
const path = require('path');

const config = {
  // Telegram
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  ADMIN_ID: parseInt(process.env.ADMIN_ID || '0', 10),

  // TON / грам API (tonapi.io)
  TON_API_KEY: process.env.TON_API_KEY || '',
  TON_API_BASE: process.env.TON_API_BASE || 'https://tonapi.io',
  TREASURY_ADDRESS: process.env.TREASURY_ADDRESS || '',

  // App
  PORT: parseInt(process.env.PORT || '3000', 10),
  PUBLIC_URL: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  SESSION_SECRET: process.env.SESSION_SECRET || 'artnabeg-dev-secret-change-me',
  ALLOW_DEMO: process.env.ALLOW_DEMO !== '0',

  // Platform
  COMMISSION_PERCENT: 8,
  NAME: 'АРТНАБЕГ',

  paths: {
    db: path.join(__dirname, '..', 'data', 'artnabeg.db'),
    uploads: path.join(__dirname, '..', 'uploads'),
    public: path.join(__dirname, '..', 'public'),
  },
};

config.isAdmin = (tgId) => config.ADMIN_ID && Number(tgId) === config.ADMIN_ID;

module.exports = config;
