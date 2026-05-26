require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');
const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');

const client = new Client();
const CHANNEL_ID = process.env.CHANNEL_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BITGET_API_KEY = process.env.BITGET_API_KEY;
const BITGET_SECRET = process.env.BITGET_SECRET;
const BITGET_PASSPHRASE = process.env.BITGET_PASSPHRASE;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let RISK_USD = parseFloat(process.env.RISK_USD) || 40;
const MAX_POSITION_USD = 500;
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

  console.log(`📐 Size: ${totalSize.toFixed(precision)} ${symbol} | Notional: $${(totalSize * price).toFixed(2)}`);

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
- Das Asset ist das ERSTE WORT vor Long/Short (z.B. "Hype Long" = asset: "HYPE", "BTC long" = asset: "BTC")
- Asset immer in GROSSBUCHSTABEN
- Extrahiere ALLE TPs (auch aus Bildern)
- targets ist Array mit TP Preisen als Zahlen
- entry, stopLoss sind Zahlen oder null
- Confidence ist Hoch nur wenn SL erkennbar ist`
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

tg.onText(/\/h/, (msg) => {
  tg.sendMessage(msg.chat.id, `
📖 <b>Commands Übersicht</b>

/d — Dashboard
/positions — Offene Positionen mit Close Button
/balance — Kontostand
/pnl — Unrealisiertes PnL
/risk — Risiko pro Trade ändern
/close [ASSET] — Position schließen
/pause — Bot pausieren
/resume — Bot reaktivieren
/status — Bot Status
/h — Diese Übersicht
  `, { parse_mode: 'HTML' });
});

tg.onText(/\/status/, (msg) => {
  tg.sendMessage(msg.chat.id, `
🤖 <b>Bot Status</b>

Status: ${botPaused ? '⏸ Pausiert' : '✅ Aktiv'}
Risiko: $${RISK_USD} pro Trade
Leverage: ${LEVERAGE}x
  `, { parse_mode: 'HTML' });
});

tg.onText(/\/pause/, (msg) => {
  botPaused = true;
  tg.sendMessage(msg.chat.id, '⏸ <b>Bot pausiert</b> – keine neuen Trades.', { parse_mode: 'HTML' });
});

tg.onText(/\/resume/, (msg) => {
  botPaused = false;
  tg.sendMessage(msg.chat.id, '▶️ <b>Bot aktiv</b> – Signale werden wieder ausgeführt.', { parse_mode: 'HTML' });
});

tg.onText(/\/risk/, (msg) => {
  waitingForRisk = true;
  tg.sendMessage(msg.chat.id, `💰 Aktuelles Risiko: <b>$${RISK_USD}</b>\n\nWie viel USDT soll ich pro Trade riskieren?\n(Einfach die Zahl eintippen)`, { parse_mode: 'HTML' });
});

tg.onText(/\/balance/, async (msg) => {
  try {
    const balance = await getBalance();
    tg.sendMessage(msg.chat.id, `
💰 <b>Kontostand</b>

Verfügbar: $${parseFloat(balance.available).toFixed(2)}
Gesamt: $${parseFloat(balance.accountEquity).toFixed(2)}
Unrealisiert: $${parseFloat(balance.unrealizedPL).toFixed(2)}
    `, { parse_mode: 'HTML' });
  } catch (e) {
    tg.sendMessage(msg.chat.id, '❌ Fehler beim Laden des Kontostands.');
  }
});

tg.onText(/\/pnl/, async (msg) => {
  try {
    const positions = await getPositions();
    if (positions.length === 0) return tg.sendMessage(msg.chat.id, '📭 Keine offenen Positionen.');
    let text = '📊 <b>Unrealisiertes PnL</b>\n\n';
    let total = 0;
    for (const p of positions) {
      const pnl = parseFloat(p.unrealizedPL);
      total += pnl;
      text += `${p.symbol}: ${pnl >= 0 ? '🟢' : '🔴'} $${pnl.toFixed(2)}\n`;
    }
    text += `\n<b>Total: ${total >= 0 ? '🟢' : '🔴'} $${total.toFixed(2)}</b>`;
    tg.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
  } catch (e) {
    tg.sendMessage(msg.chat.id, '❌ Fehler beim Laden.');
  }
});

tg.onText(/\/close (.+)/, async (msg, match) => {
  const asset = match[1].toUpperCase();
  try {
    await closePosition(asset);
    tg.sendMessage(msg.chat.id, `✅ Position <b>${asset}</b> geschlossen.`, { parse_mode: 'HTML' });
  } catch (e) {
    tg.sendMessage(msg.chat.id, `❌ Fehler: ${e.message}`);
  }
});

tg.onText(/\/positions/, async (msg) => {
  try {
    const positions = await getPositions();
    if (positions.length === 0) return tg.sendMessage(msg.chat.id, '📭 Keine offenen Positionen.');
    for (const p of positions) {
      const pnl = parseFloat(p.unrealizedPL);
      const asset = p.symbol.replace('USDT', '');
      await tg.sendMessage(msg.chat.id, `
${p.holdSide === 'long' ? '🟢 Long' : '🔴 Short'} <b>${p.symbol}</b>
Size: ${p.total}
Entry: $${parseFloat(p.openPriceAvg).toFixed(4)}
PnL: ${pnl >= 0 ? '🟢' : '🔴'} $${pnl.toFixed(2)}
      `, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: `❌ Close ${asset}`, callback_data: `close_${asset}` }
          ]]
        }
      });
    }
  } catch (e) {
    tg.sendMessage(msg.chat.id, '❌ Fehler beim Laden.');
  }
});

tg.onText(/\/d/, async (msg) => {
  try {
    const [positions, balance] = await Promise.all([getPositions(), getBalance()]);
    const totalPnl = positions.reduce((sum, p) => sum + parseFloat(p.unrealizedPL), 0);
    let text = `📊 <b>Dashboard</b>\n\n`;
    text += `💰 Balance: $${parseFloat(balance.accountEquity).toFixed(2)}\n`;
    text += `📈 PnL: ${totalPnl >= 0 ? '🟢' : '🔴'} $${totalPnl.toFixed(2)}\n`;
    text += `🎯 Positionen: ${positions.length}\n`;
    text += `⚡ Risiko/Trade: $${RISK_USD}\n`;
    text += `🤖 Bot: ${botPaused ? '⏸ Pausiert' : '✅ Aktiv'}\n`;
    if (positions.length > 0) {
      text += '\n<b>Offene Positionen:</b>\n';
      for (const p of positions) {
        const pnl = parseFloat(p.unrealizedPL);
        text += `• ${p.symbol} ${p.holdSide === 'long' ? '🟢' : '🔴'} $${pnl.toFixed(2)}\n`;
      }
    }
    tg.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
  } catch (e) {
    tg.sendMessage(msg.chat.id, '❌ Dashboard Fehler.');
  }
});

tg.on('callback_query', async (query) => {
  if (query.data.startsWith('close_')) {
    const asset = query.data.replace('close_', '');
    try {
      await closePosition(asset);
      tg.answerCallbackQuery(query.id, { text: `✅ ${asset} geschlossen!` });
      tg.editMessageText(`✅ <b>${asset}</b> Position geschlossen.`, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'HTML'
      });
    } catch (e) {
      tg.answerCallbackQuery(query.id, { text: `❌ Fehler: ${e.message}` });
    }
  }
});

tg.on('message', (msg) => {
  if (waitingForRisk && msg.text && !msg.text.startsWith('/')) {
    const amount = parseFloat(msg.text);
    if (!isNaN(amount) && amount > 0) {
      RISK_USD = amount;
      waitingForRisk = false;
      tg.sendMessage(msg.chat.id, `✅ Risiko auf <b>$${RISK_USD}</b> gesetzt.`, { parse_mode: 'HTML' });
    } else {
      tg.sendMessage(msg.chat.id, '❌ Ungültige Zahl. Nochmal versuchen.');
    }
  }
});

client.on('ready', async () => {
  console.log(`✅ Bot läuft! Eingeloggt als ${client.user.tag}`);
  await notify(`✅ <b>Bot gestartet</b>\nRisiko: $${RISK_USD} | Leverage: ${LEVERAGE}x`);
});

client.on('messageCreate', async (message) => {
  if (message.channel.id !== CHANNEL_ID) return;
  if (botPaused) { console.log('⏸ Pausiert'); return; }

  console.log(`\n📨 ${message.author.tag}: ${message.content}`);

  const imageUrl = message.attachments.size > 0 ? message.attachments.first().url : null;
  if (!message.content && !imageUrl) return;

  try {
    const signal = await analyzeSignal(message.content, imageUrl);
    console.log(`📊 Signal:`, JSON.stringify(signal));

    if (!signal.signal) return;

    if (signal.action === 'close') {
      await closePosition(signal.asset);
      await notify(`🔴 <b>Position geschlossen</b>\nAsset: ${signal.asset}`);
      return;
    }

    if (signal.action === 'breakeven') {
      if (!signal.entry) return;
      await moveSlToBreakeven(signal.asset, signal.direction || 'Long', signal.entry);
      await notify(`↔️ <b>SL auf BE gesetzt</b>\n${signal.asset} @ $${signal.entry}`);
      return;
    }

    if (signal.confidence === 'Niedrig' || !signal.stopLoss) return;

    if (!signal.asset) {
      console.log(`⏭️ Kein Asset erkannt – übersprungen`);
      return;
    }

    await setLeverage(signal.asset);
    await placeOrder(signal.asset, signal.direction, signal.stopLoss, signal.targets);

    const tpList = signal.targets?.map((t, i) => `TP${i + 1}: $${t.price}`).join('\n') || '–';
    await notify(`
🟢 <b>Trade eröffnet</b>
Asset: ${signal.asset}
Richtung: ${signal.direction}
SL: $${signal.stopLoss}
${tpList}
Risk: $${RISK_USD}
    `);

  } catch (err) {
    const errMsg = err.response?.data?.msg || err.message;
    console.error(`❌ Fehler:`, errMsg);
    await notify(`❌ <b>Fehler</b>: ${errMsg}`);
  }
});

client.login(process.env.DISCORD_TOKEN);
