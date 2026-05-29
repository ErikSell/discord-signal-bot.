require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');
const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');

const client = new Client();
const CHANNEL_ID = process.env.CHANNEL_ID;
const TEST_CHANNEL_ID = process.env.TEST_CHANNEL_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BITGET_API_KEY = process.env.BITGET_API_KEY;
const BITGET_SECRET = process.env.BITGET_SECRET;
const BITGET_PASSPHRASE = process.env.BITGET_PASSPHRASE;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let RISK_USD = parseFloat(process.env.RISK_USD) || 40;
let MAX_POSITION_USD = parseFloat(process.env.MAX_POSITION_USD) || 5000;
const LEVERAGE = '1';
let botPaused = false;
let waitingForRisk = false;

const tg = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

tg.on('polling_error', (error) => {
  console.error('TG Polling Error:', error.message);
  if (error.message.includes('401') || error.message.includes('Unauthorized')) {
    console.error('❌ Telegram Token ungültig – polling gestoppt');
    tg.stopPolling();
  }
});

async function notify(msg) {
  try {
    await tg.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('TG Error:', e.message);
  }
}

function createSignature(timestamp, method, requestPath, body) {
  const message = timestamp + method + requestPath + (body || '');
  return crypto.createHmac('sha256', BITGET_SECRET).update(message).digest('base64');
}

function bitgetHeaders(timestamp, path, body) {
  const sign = createSignature(timestamp, 'POST', path, body);
  return {
    'ACCESS-KEY': BITGET_API_KEY,
    'ACCESS-SIGN': sign,
    'ACCESS-TIMESTAMP': timestamp,
    'ACCESS-PASSPHRASE': BITGET_PASSPHRASE,
    'Content-Type': 'application/json',
    'locale': 'en-US'
  };
}

function bitgetGetHeaders(timestamp, path, queryString = '') {
  const sign = createSignature(timestamp, 'GET', path + queryString, '');
  return {
    'ACCESS-KEY': BITGET_API_KEY,
    'ACCESS-SIGN': sign,
    'ACCESS-TIMESTAMP': timestamp,
    'ACCESS-PASSPHRASE': BITGET_PASSPHRASE,
    'Content-Type': 'application/json',
    'locale': 'en-US'
  };
}

function getTPDistribution(count) {
  const distributions = {
    1: [100],
    2: [60, 40],
    3: [50, 30, 20],
    4: [40, 25, 20, 15],
    5: [30, 25, 20, 15, 10]
  };
  return distributions[count] || distributions[5];
}

async function getPrice(symbol) {
  const r = await axios.get('https://api.bitget.com/api/v2/mix/market/ticker', {
    params: { symbol: symbol + 'USDT', productType: 'USDT-FUTURES' }
  });
  return parseFloat(r.data.data[0].lastPr);
}

async function getSizePrecision(symbol) {
  const r = await axios.get('https://api.bitget.com/api/v2/mix/market/contracts', {
    params: { symbol: symbol + 'USDT', productType: 'USDT-FUTURES' }
  });
  return parseInt(r.data.data[0].volumePlace);
}

async function getBalance() {
  const timestamp = Date.now().toString();
  const path = '/api/v2/mix/account/accounts';
  const queryString = '?productType=USDT-FUTURES';
  const r = await axios.get(`https://api.bitget.com${path}${queryString}`, {
    headers: bitgetGetHeaders(timestamp, path, queryString)
  });
  const usdt = r.data.data.find(a => a.marginCoin === 'USDT');
  return usdt;
}

async function getPositions() {
  const timestamp = Date.now().toString();
  const path = '/api/v2/mix/position/all-position';
  const queryString = '?productType=USDT-FUTURES&marginCoin=USDT';
  const r = await axios.get(`https://api.bitget.com${path}${queryString}`, {
    headers: bitgetGetHeaders(timestamp, path, queryString)
  });
  return r.data.data.filter(p => parseFloat(p.total) > 0);
}

async function setLeverage(symbol) {
  const timestamp = Date.now().toString();
  const path = '/api/v2/mix/account/set-leverage';
  const body = JSON.stringify({
    symbol: symbol + 'USDT',
    productType: 'USDT-FUTURES',
    marginCoin: 'USDT',
    leverage: LEVERAGE
  });
  await axios.post(`https://api.bitget.com${path}`, body, {
    headers: bitgetHeaders(timestamp, path, body)
  });
}

async function placeOrder(symbol, direction, stopLoss, targets) {
  const fullSymbol = symbol + 'USDT';
  const price = await getPrice(symbol);
  const precision = await getSizePrecision(symbol);

  const riskPerUnit = Math.abs(price - stopLoss);
  let totalSize = RISK_USD / riskPerUnit;
  const notional = totalSize * price;
  if (notional > MAX_POSITION_USD) totalSize = MAX_POSITION_USD / price;

  console.log(`📐 Size: ${totalSize.toFixed(precision)} ${symbol} | Notional: $${(totalSize * price).toFixed(2)} | Risk: $${(totalSize * riskPerUnit).toFixed(2)}`);

  const mainBody = JSON.stringify({
    symbol: fullSymbol,
    productType: 'USDT-FUTURES',
    marginMode: 'isolated',
    marginCoin: 'USDT',
    size: totalSize.toFixed(precision),
    side: direction === 'Long' ? 'buy' : 'sell',
    tradeSide: 'open',
    orderType: 'market',
    presetStopLossPrice: stopLoss.toString()
  });

  const mainPath = '/api/v2/mix/order/place-order';
  await axios.post(`https://api.bitget.com${mainPath}`, mainBody, {
    headers: bitgetHeaders(Date.now().toString(), mainPath, mainBody)
  });

  console.log(`✅ Haupt-Order platziert`);
  await new Promise(r => setTimeout(r, 5000));

  if (targets && targets.length > 0) {
    const distribution = getTPDistribution(targets.length);
    for (let i = 0; i < targets.length; i++) {
      const tp = targets[i];
      const tpSize = (totalSize * distribution[i] / 100).toFixed(precision);
      await new Promise(r => setTimeout(r, 800));
      const tpBody = JSON.stringify({
        symbol: fullSymbol,
        productType: 'USDT-FUTURES',
        marginMode: 'isolated',
        marginCoin: 'USDT',
        side: direction === 'Long' ? 'sell' : 'buy',
        tradeSide: 'close',
        orderType: 'market',
        size: tpSize,
        triggerPrice: tp.price.toString(),
        triggerType: 'mark_price',
        planType: 'normal_plan'
      });
      const tpPath = '/api/v2/mix/order/place-plan-order';
      await axios.post(`https://api.bitget.com${tpPath}`, tpBody, {
        headers: bitgetHeaders(Date.now().toString(), tpPath, tpBody)
      });
      console.log(`🎯 TP${i + 1}: ${tpSize} ${symbol} @ $${tp.price} (${distribution[i]}%)`);
    }
  }

  return { totalSize, price };
}

async function closePosition(symbol) {
  const timestamp = Date.now().toString();
  const path = '/api/v2/mix/order/close-positions';
  const body = JSON.stringify({
    symbol: symbol + 'USDT',
    productType: 'USDT-FUTURES',
    marginCoin: 'USDT'
  });
  const r = await axios.post(`https://api.bitget.com${path}`, body, {
    headers: bitgetHeaders(timestamp, path, body)
  });
  return r.data;
}

async function moveSlToBreakeven(symbol, direction, entryPrice) {
  const slPath = '/api/v2/mix/order/place-tpsl';
  const slBody = JSON.stringify({
    symbol: symbol + 'USDT',
    productType: 'USDT-FUTURES',
    marginCoin: 'USDT',
    planType: 'loss_plan',
    triggerPrice: entryPrice.toString(),
    triggerType: 'mark_price',
    holdSide: direction === 'Long' ? 'long' : 'short'
  });
  const r = await axios.post(`https://api.bitget.com${slPath}`, slBody, {
    headers: bitgetHeaders(Date.now().toString(), slPath, slBody)
  });
  return r.data;
}

async function analyzeSignal(text, imageUrl) {
  const content = [];
  if (imageUrl) {
    const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const base64 = Buffer.from(imageResponse.data).toString('base64');
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } });
  }
  content.push({
    type: 'text',
    text: `Du bist ein Trading Signal Analyzer. Analysiere diese Nachricht/Bild genau.

Nachricht: "${text}"

Antworte NUR in JSON ohne Markdown.

Für ein neues Trade Signal:
{
  "signal": true,
  "action": "open",
  "asset": "BTC",
  "direction": "Long",
  "entry": 67000,
  "stopLoss": 65000,
  "targets": [
    { "price": 68000 },
    { "price": 69500 }
  ],
  "confidence": "Hoch"
}

Für Close Signal: { "signal": true, "action": "close", "asset": "BTC" }
Für Breakeven Signal: { "signal": true, "action": "breakeven", "asset": "BTC", "entry": 67000 }
Falls kein Signal: { "signal": false }

Regeln:
- Das Asset ist das ERSTE WORT vor Long/Short (z.B. "Hype Long" = asset: "HYPE")
- Asset immer in GROSSBUCHSTABEN
- Extrahiere ALLE TPs EXAKT wie angegeben – keine eigenen Zahlen erfinden
- Bei Bildern: lies Pre​​​​​​​​​​​​​​​​
