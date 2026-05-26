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
const TRADE_SIZE_USD = 10;
const LEVERAGE = '1';

function createSignature(timestamp, method, requestPath, body) {
  const message = timestamp + method + requestPath + (body || '');
  return crypto.createHmac('sha256', BITGET_SECRET).update(message).digest('base64');
}

async function getPrice(symbol) {
  const response = await axios.get('https://api.bitget.com/api/v2/mix/market/ticker', {
    params: { symbol: symbol + 'USDT', productType: 'USDT-FUTURES' }
  });
  return parseFloat(response.data.data[0].lastPr);
}

async function placeOrder(symbol, direction) {
  const timestamp = Date.now().toString();
  const fullSymbol = symbol + 'USDT';
  const price = await getPrice(symbol);
  const size = (TRADE_SIZE_USD / price).toFixed(6);

  const body = JSON.stringify({
    symbol: fullSymbol,
    productType: 'USDT-FUTURES',
    marginMode: 'isolated',
    marginCoin: 'USDT',
    size: size,
    side: direction === 'Long' ? 'buy' : 'sell',
    tradeSide: 'open',
    orderType: 'market',
    leverage: LEVERAGE
  });

  const path = '/api/v2/mix/order/place-order';
  const sign = createSignature(timestamp, 'POST', path, body);

  const response = await axios.post(`https://api.bitget.com${path}`, body, {
    headers: {
      'ACCESS-KEY': BITGET_API_KEY,
      'ACCESS-SIGN': sign,
      'ACCESS-TIMESTAMP': timestamp,
      'ACCESS-PASSPHRASE': BITGET_PASSPHRASE,
      'Content-Type': 'application/json',
      'locale': 'en-US'
    }
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
    text: `Du bist ein Trading Signal Analyzer. Analysiere diese Nachricht und extrahiere das Trading Signal.

Nachricht: "${text}"

Antworte NUR in diesem JSON Format ohne Markdown:
{
  "signal": true,
  "asset": "BTC",
  "direction": "Long",
  "confidence": "Hoch"
}

Falls kein klares Trading Signal: { "signal": false }
Confidence ist Hoch wenn Entry + SL oder TP klar erkennbar sind, sonst Niedrig.`
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

    if (!signal.signal || signal.confidence === 'Niedrig') {
      console.log(`⏭️ Kein valides Signal – übersprungen`);
      return;
    }

    console.log(`🚀 Öffne Trade: ${signal.asset} ${signal.direction} mit $${TRADE_SIZE_USD}`);
    const order = await placeOrder(signal.asset, signal.direction);
    console.log(`✅ Trade erfolgreich:`, JSON.stringify(order));

  } catch (err) {
    console.error(`❌ Fehler:`, err.response?.data || err.message);
  }
});

client.login(process.env.DISCORD_TOKEN);