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

async function placeOrder(symbol, direction, stopLoss, targets) {
  const fullSymbol = symbol + 'USDT';
  const price = await getPrice(symbol);

  const riskPerUnit = Math.abs(price - stopLoss);
  let totalSize = RISK_USD / riskPerUnit;
  const notional = totalSize * price;
  if (notional > MAX_POSITION_USD) totalSize = MAX_POSITION_USD / price;

  console.log(`📐 Total Size: ${totalSize.toFixed(4)} ${symbol} | Notional: $${(totalSize * price).toFixed(2)}`);

  const mainBody = JSON.stringify({
    symbol: fullSymbol,
    productType: 'USDT-FUTURES',
    marginMode: 'isolated',
    marginCoin: 'USDT',
    size: totalSize.toFixed(4),
    side: direction === 'Long' ? 'buy' : 'sell',
    tradeSide: 'open',
    orderType: 'market',
    presetStopLossPrice: stopLoss.toString()
  });

  const mainPath = '/api/v2/mix/order/place-order';
  const mainTimestamp = Date.now().toString();
  await axios.post(`https://api.bitget.com${mainPath}`, mainBody, {
    headers: bitgetHeaders(mainTimestamp, mainPath, mainBody)
  });

  console.log(`✅ Haupt-Order platziert`);
  await new Promise(r => setTimeout(r, 5000));

  if (targets && targets.length > 0) {
    const distribution = getTPDistribution(targets.length);
    const holdSide = direction === 'Long' ? 'long' : 'short';

    for (let i = 0; i < targets.length; i++) {
      const tp = targets[i];
      const percent = distribution[i] / 100;
      const tpSize = (totalSize * percent).toFixed(4);

      await new Promise(r => setTimeout(r, 800));

      const tpTimestamp = Date.now().toString();
const tpBody = JSON.stringify({
  symbol: fullSymbol,
  productType: 'USDT-FUTURES',
  marginMode: 'isolated',
  marginCoin: 'USDT',
  side: direction === 'Long' ? 'sell' : 'buy',
  tradeSide: 'close',
  orderType: 'limit',
  size: tpSize,
  triggerPrice: tp.price.toString(),
  triggerType: 'mark_price',
  executePrice: tp.price.toString(),
  planType: 'normal_plan'
});

const tpPath = '/api/v2/mix/order/place-plan-order';
      await axios.post(`https://api.bitget.com${tpPath}`, tpBody, {
        headers: bitgetHeaders(tpTimestamp, tpPath, tpBody)
      });

      console.log(`🎯 TP${i + 1}: ${tpSize} ${symbol} @ $${tp.price} (${distribution[i]}%)`);
    }
  }
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

async function moveSlToBreakeven(symbol, direction, entryPrice) {
  const slTimestamp = Date.now().toString();
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
  const response = await axios.post(`https://api.bitget.com${slPath}`, slBody, {
    headers: bitgetHeaders(slTimestamp, slPath, slBody)
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
    { "price": 69500 },
    { "price": 71000 }
  ],
  "confidence": "Hoch"
}

Für Close Signal ("close", "exit", "raus", "close BTC"):
{ "signal": true, "action": "close", "asset": "BTC" }

Für Breakeven Signal ("BE", "move SL to BE", "breakeven"):
{ "signal": true, "action": "breakeven", "asset": "BTC", "entry": 67000 }

Falls kein Signal: { "signal": false }

Regeln:
- Extrahiere ALLE TPs die erkennbar sind (auch aus Bildern)
- targets ist ein Array mit allen TP Preisen als Zahlen
- entry, stopLoss sind Zahlen oder null
- Confidence ist Hoch nur wenn SL erkennbar ist
- Bei BE Signal: entry Preis aus Kontext nehmen falls bekannt`
  });

  const response = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
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
      console.log(`⏭️ Kein Signal – übersprungen`);
      return;
    }

    if (signal.action === 'close') {
      console.log(`🔴 Schließe Position: ${signal.asset}`);
      const result = await closePosition(signal.asset);
      console.log(`✅ Position geschlossen:`, JSON.stringify(result));
      return;
    }

    if (signal.action === 'breakeven') {
      if (!signal.entry) {
        console.log(`⏭️ Kein Entry Preis für BE – übersprungen`);
        return;
      }
      console.log(`↔️ Setze SL auf BE: ${signal.asset} @ ${signal.entry}`);
      const result = await moveSlToBreakeven(signal.asset, signal.direction || 'Long', signal.entry);
      console.log(`✅ SL auf BE gesetzt:`, JSON.stringify(result));
      return;
    }

    if (signal.confidence === 'Niedrig') {
      console.log(`⏭️ Confidence zu niedrig – übersprungen`);
      return;
    }

    if (!signal.stopLoss) {
      console.log(`⏭️ Kein SL – Trade übersprungen`);
      return;
    }

    await setLeverage(signal.asset);
    console.log(`⚙️ Leverage: ${LEVERAGE}x`);

    const tpCount = signal.targets?.length || 0;
    console.log(`🟢 ${signal.asset} ${signal.direction} | ${tpCount} TPs | Risk: $${RISK_USD}`);

    await placeOrder(signal.asset, signal.direction, signal.stopLoss, signal.targets);
    console.log(`✅ Alle Orders platziert`);

  } catch (err) {
    console.error(`❌ Fehler:`, err.response?.data || err.message);
  }
});

client.login(process.env.DISCORD_TOKEN);
