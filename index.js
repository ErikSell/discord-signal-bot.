require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');
const crypto = require('crypto');

const client = new Client();
const CHANNEL_ID = process.env.CHANNEL_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BITGET_API_KEY = process.env.BITGET_API_KEY;
const BITGET_SECRET = process.env.BITGET_SECRET;
const BITGET_PASSPHRASE = process.env.BITGET_PASSPHRASE;
const RISK_USD = 1;
const MAX_POSITION_USD = 100;
const LEVERAGE = '1';

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

async function getPrice(symbol) {
  const response = await axios.get('https://api.bitget.com/api/v2/mix/market/ticker', {
    params: { symbol: symbol + 'USDT', productType: 'USDT-FUTURES' }
  });
  return parseFloat(response.data.data[0].lastPr);
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

async function placeOrder(symbol, direction, stopLoss, takeProfit) {
  const timestamp = Date.now().toString();
  const fullSymbol = symbol + 'USDT';
  const price = await getPrice(symbol);

  const riskPerUnit = Math.abs(price - stopLoss);
  let size = RISK_USD / riskPerUnit;
  const notional = size * price;
  if (notional > MAX_POSITION_USD) size = MAX_POSITION_USD / price;
  size = size.toFixed(4);

  console.log(`📐 Size: ${size} ${symbol} | Notional: $${(parseFloat(size) * price).toFixed(2)}`);

  const orderBody = {
    symbol: fullSymbol,
    productType: 'USDT-FUTURES',
    marginMode: 'isolated',
    marginCoin: 'USDT',
    size,
    side: direction === 'Long' ? 'buy' : 'sell',
    tradeSide: 'open',
    orderType: 'market'
  };

  if (stopLoss) orderBody.presetStopLossPrice = stopLoss.toString();
  if (takeProfit) orderBody.presetStopSurplusPrice = takeProfit.toString();

  const body = JSON.stringify(orderBody);
  const path = '/api/v2/mix/order/place-order';
  const response = await axios.post(`https://api.bitget.com${path}`, body, {
    headers: bitgetHeaders(timestamp, path, body)
  });
  return response.data;
}

async function closePosition(symbol) {
  const timestamp = Date.now().toString();
  const path = '/api/v2/mix/order/close-positions';
  const body = JSON.stringify({
    symbol: symbol + 'USDT',
    productType: 'USDT-FUTURES',
    marginCoin: 'USDT'
  });
  const response = await axios.post(`https://api.bitget.com${path}`, body, {
    headers: bitgetHeaders(timestamp, path, body)
  });
  return response.data;
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
    text: `Du bist ein Trading Signal Analyzer. Analysiere diese Nachricht.

Nachricht: "${text}"

Antworte NUR in diesem JSON Format ohne Markdown:

Für ein neues Signal:
{
  "signal": true,
  "action": "open",
  "asset": "BTC",
  "direction": "Long",
  "entry": 67000,
  "stopLoss": 65000,
  "takeProfit": 70000,
  "confidence": "Hoch"
}

Für ein Close Signal (z.B. "close BTC", "exit", "close all", "raus"):
{
  "signal": true,
  "action": "close",
  "asset": "BTC"
}

Falls kein Trading Signal: { "signal": false }
Confidence ist Hoch nur wenn ein Stop Loss klar erkennbar ist.
entry, stopLoss, takeProfit sind Zahlen oder null.`
  });

  const response = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{ role: 'user', content }]
  }, {
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    }
  });

  const raw = response.data.content[0].text.replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}

client.on('ready', () => {
  console.log(`✅ Bot läuft! Eingeloggt als ${client.user.tag}`);
  console.log(`👀 Höre auf Kanal: ${CHANNEL_ID}`);
});

client.on('messageCreate', async (message) => {
  if (message.channel.id !== CHANNEL_ID) return;

  console.log(`\n📨 Neue Nachricht von: ${message.author.tag}`);
  console.log(`📝 Text: ${message.content}`);

  const imageUrl = message.attachments.size > 0 ? message.attachments.first().url : null;
  if (imageUrl) console.log(`🖼️ Bild gefunden`);
  if (!message.content && !imageUrl) return;

  try {
    console.log(`🤖 KI analysiert...`);
    const signal = await analyzeSignal(message.content, imageUrl);
    console.log(`📊 Signal:`, JSON.stringify(signal));

    if (!signal.signal) {
      console.log(`⏭️ Keine Trading Aktion – übersprungen`);
      return;
    }

    // CLOSE
    if (signal.action === 'close') {
      console.log(`🔴 Schließe Position: ${signal.asset}`);
      const result = await closePosition(signal.asset);
      console.log(`✅ Position geschlossen:`, JSON.stringify(result));
      return;
    }

    // OPEN
    if (signal.confidence === 'Niedrig') {
      console.log(`⏭️ Confidence zu niedrig – übersprungen`);
      return;
    }

    if (!signal.stopLoss) {
      console.log(`⏭️ Kein SL angegeben – Trade übersprungen`);
      return;
    }

    await setLeverage(signal.asset);
    console.log(`⚙️ Leverage: ${LEVERAGE}x gesetzt`);

    console.log(`🟢 ${signal.asset} ${signal.direction} | Risk: $${RISK_USD}`);
    const order = await placeOrder(signal.asset, signal.direction, signal.stopLoss, signal.takeProfit);
    console.log(`✅ Trade erfolgreich:`, JSON.stringify(order));

  } catch (err) {
    console.error(`❌ Fehler:`, err.response?.data || err.message);
  }
});

client.login(process.env.DISCORD_TOKEN);