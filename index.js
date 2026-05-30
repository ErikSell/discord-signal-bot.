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
let TEST_RISK_USD = parseFloat(process.env.RISK_USD) || 40;
let MAX_POSITION_USD = parseFloat(process.env.MAX_POSITION_USD) || 5000;
const LEVERAGE = '1';
let botPaused = false;
let waitingForRisk = false;
let waitingForTestRisk = false;

const tg = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

tg.on('polling_error', (error) => {
  console.error('TG Polling Error:', error.message);
  if (error.message.includes('401') || error.message.includes('Unauthorized')) {
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

function extractMessageContent(message) {
  let text = message.content || '';
  let imageUrl = null;

  // Normale Attachments
  if (message.attachments && message.attachments.size > 0) {
    const attachment = message.attachments.first();
    if (attachment.contentType?.startsWith('image/') ||
        /\.(jpg|jpeg|png|gif|webp)$/i.test(attachment.url)) {
      imageUrl = attachment.url;
    }
  }

  // Embeds – Text UND Bilder
  if (message.embeds && message.embeds.length > 0) {
    for (const embed of message.embeds) {
      const parts = [];
      if (embed.title) parts.push(embed.title);
      if (embed.description) parts.push(embed.description);
      if (embed.fields) embed.fields.forEach(f => parts.push(`${f.name}: ${f.value}`));
      if (parts.length > 0) text += (text ? '\n' : '') + parts.join('\n');

      if (!imageUrl) {
        if (embed.image?.url) imageUrl = embed.image.url;
        else if (embed.thumbnail?.url) imageUrl = embed.thumbnail.url;
      }
    }
  }

  return { text: text.trim(), imageUrl };
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

async function takeTp1AndBreakeven(symbol, direction) {
  const fullSymbol = symbol + 'USDT';

  // Offene Plan-Orders holen
  const timestamp = Date.now().toString();
  const path = '/api/v2/mix/order/orders-plan-pending';
  const queryString = `?symbol=${fullSymbol}&productType=USDT-FUTURES`;
  const r = await axios.get(`https://api.bitget.com${path}${queryString}`, {
    headers: bitgetGetHeaders(timestamp, path, queryString)
  });

  const planOrders = r.data.data?.entrustedList || r.data.data || [];
  console.log(`📋 Offene Plan-Orders: ${planOrders.length}`);

  if (planOrders.length === 0) {
    console.log('Keine offenen Plan-Orders – TP1 bereits getriggert');
    // Trotzdem BE setzen
    const positions = await getPositions();
    const position = positions.find(p => p.symbol === fullSymbol);
    if (position) {
      const entryPrice = parseFloat(position.openPriceAvg);
      await moveSlToBreakeven(symbol, direction, entryPrice);
      return { tp1AlreadyFilled: true, entryPrice };
    }
    return { tp1AlreadyFilled: true };
  }

  // TP1 finden – niedrigster Preis bei Long, höchster bei Short
  const sorted = [...planOrders].sort((a, b) => {
    const priceA = parseFloat(a.triggerPrice);
    const priceB = parseFloat(b.triggerPrice);
    return direction === 'Long' ? priceA - priceB : priceB - priceA;
  });

  const tp1Order = sorted[0];
  const tp1Size = tp1Order.size;
  const orderId = tp1Order.orderId;

  console.log(`🎯 TP1 gefunden: ${tp1Size} @ $${tp1Order.triggerPrice} | ID: ${orderId}`);

  // TP1 Plan-Order canceln
  const cancelPath = '/api/v2/mix/order/cancel-plan-order';
  const cancelBody = JSON.stringify({
    symbol: fullSymbol,
    productType: 'USDT-FUTURES',
    marginCoin: 'USDT',
    orderId: orderId
  });
  await axios.post(`https://api.bitget.com${cancelPath}`, cancelBody, {
    headers: bitgetHeaders(Date.now().toString(), cancelPath, cancelBody)
  });
  console.log(`❌ TP1 Order gecancelt`);

  // TP1 Größe at Market schließen
  const precision = await getSizePrecision(symbol);
  const closePath = '/api/v2/mix/order/place-order';
  const closeBody = JSON.stringify({
    symbol: fullSymbol,
    productType: 'USDT-FUTURES',
    marginMode: 'isolated',
    marginCoin: 'USDT',
    size: parseFloat(tp1Size).toFixed(precision),
    side: direction === 'Long' ? 'sell' : 'buy',
    tradeSide: 'close',
    orderType: 'market'
  });
  await axios.post(`https://api.bitget.com${closePath}`, closeBody, {
    headers: bitgetHeaders(Date.now().toString(), closePath, closeBody)
  });
  console.log(`✅ TP1 at Market geschlossen: ${tp1Size} ${symbol}`);

  // Position holen für BE Entry Price
  await new Promise(r => setTimeout(r, 2000));
  const positions = await getPositions();
  const position = positions.find(p => p.symbol === fullSymbol);

  if (position) {
    const entryPrice = parseFloat(position.openPriceAvg);
    await moveSlToBreakeven(symbol, direction, entryPrice);
    console.log(`↔️ SL auf BE gesetzt: $${entryPrice}`);
    return { tp1Closed: true, tp1Size, entryPrice };
  }

  return { tp1Closed: true, tp1Size };
}

async function analyzeSignal(text, imageUrl) {
  const content = [];
  if (imageUrl) {
    try {
      const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
      const base64 = Buffer.from(imageResponse.data).toString('base64');
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } });
    } catch (e) {
      console.log('Bild konnte nicht geladen werden:', e.message);
    }
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
  "targets": [{ "price": 68000 }, { "price": 69500 }],
  "confidence": "Hoch"
}

Für Close Signal: { "signal": true, "action": "close", "asset": "BTC" }
Für Breakeven Signal: { "signal": true, "action": "breakeven", "asset": "BTC", "entry": 67000 }
Für "Taking TP1 and moving stops to BE" / "taking TP1 now BE": { "signal": true, "action": "take_tp1_be", "asset": "BTC", "direction": "Long" }
Falls kein Signal: { "signal": false }

Regeln:
- Das Asset ist das ERSTE WORT vor Long/Short
- Asset immer in GROSSBUCHSTABEN
- Extrahiere ALLE TPs EXAKT wie angegeben
- Bei Bildern: lies Preiszahlen absolut präzise ab
- "TP1 hit", "TP2 hit", "third TP hit" etc. → signal: false (nur Info)
- Nur explizite "close", "exit", "closing now" sind Close Signale
- "taking TP1 and moving stops BE", "take TP1 move BE" → action: take_tp1_be
- Confidence ist Hoch nur wenn SL erkennbar ist`
  });

  const response = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-6',
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

function buildTestReport(signal, entryPrice) {
  if (!signal.stopLoss) return '⚠️ Kein SL – keine Berechnung möglich';
  const direction = signal.direction === 'Long' ? 1 : -1;
  const riskPerUnit = Math.abs(entryPrice - signal.stopLoss);
  const totalSize = TEST_RISK_USD / riskPerUnit;
  const notional = totalSize * entryPrice;
  let report = `\n💼 <b>Position Berechnung</b>\n`;
  report += `Entry: $${entryPrice.toFixed(4)}\n`;
  report += `Size: ${totalSize.toFixed(2)} ${signal.asset}\n`;
  report += `Notional: $${notional.toFixed(2)}\n`;
  report += `\n❌ <b>SL Hit ($${signal.stopLoss}):</b> -$${TEST_RISK_USD.toFixed(2)}\n`;
  if (signal.targets && signal.targets.length > 0) {
    const distribution = getTPDistribution(signal.targets.length);
    let totalProfit = 0;
    report += `\n🎯 <b>Take Profits:</b>\n`;
    for (let i = 0; i < signal.targets.length; i++) {
      const tp = signal.targets[i];
      const percent = distribution[i] / 100;
      const tpSize = totalSize * percent;
      const profit = tpSize * (tp.price - entryPrice) * direction;
      totalProfit += profit;
      report += `TP${i + 1} ($${tp.price}) ${distribution[i]}%: +$${profit.toFixed(2)}\n`;
    }
    report += `\n💰 <b>Gesamt: +$${totalProfit.toFixed(2)}</b>`;
    report += `\n📊 RR: 1:${(totalProfit / TEST_RISK_USD).toFixed(2)}`;
  }
  return report;
}

// ─── Telegram Commands ─────────────────────────────────────

tg.onText(/\/h/, (msg) => {
  tg.sendMessage(msg.chat.id, `
📖 <b>Commands Übersicht</b>

/d — Dashboard
/positions — Offene Positionen mit Close Button
/balance — Kontostand
/pnl — Unrealisiertes PnL
/risk — Live Risiko ändern
/testrisk — Test Risiko ändern
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
Live Risiko: $${RISK_USD} pro Trade
Test Risiko: $${TEST_RISK_USD} pro Trade
Max Position: $${MAX_POSITION_USD}
Leverage: ${LEVERAGE}x
Test Kanal: ${TEST_CHANNEL_ID ? '✅ Aktiv' : '❌ Nicht gesetzt'}
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
  waitingForTestRisk = false;
  tg.sendMessage(msg.chat.id, `💰 Live Risiko: <b>$${RISK_USD}</b>\n\nNeues Live Risiko eintippen:`, { parse_mode: 'HTML' });
});

tg.onText(/\/testrisk/, (msg) => {
  waitingForTestRisk = true;
  waitingForRisk = false;
  tg.sendMessage(msg.chat.id, `🧪 Test Risiko: <b>$${TEST_RISK_USD}</b>\n\nNeues Test Risiko eintippen:`, { parse_mode: 'HTML' });
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
    text += `⚡ Live Risiko: $${RISK_USD}\n`;
    text += `🧪 Test Risiko: $${TEST_RISK_USD}\n`;
    text += `📦 Max Position: $${MAX_POSITION_USD}\n`;
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
  if ((waitingForRisk || waitingForTestRisk) && msg.text && !msg.text.startsWith('/')) {
    const amount = parseFloat(msg.text);
    if (!isNaN(amount) && amount > 0) {
      if (waitingForRisk) {
        RISK_USD = amount;
        waitingForRisk = false;
        tg.sendMessage(msg.chat.id, `✅ Live Risiko auf <b>$${RISK_USD}</b> gesetzt.`, { parse_mode: 'HTML' });
      } else {
        TEST_RISK_USD = amount;
        waitingForTestRisk = false;
        tg.sendMessage(msg.chat.id, `✅ Test Risiko auf <b>$${TEST_RISK_USD}</b> gesetzt.`, { parse_mode: 'HTML' });
      }
    } else {
      tg.sendMessage(msg.chat.id, '❌ Ungültige Zahl. Nochmal versuchen.');
    }
  }
});

// ─── Discord Bot ───────────────────────────────────────────

client.on('ready', async () => {
  console.log(`✅ Bot läuft! Eingeloggt als ${client.user.tag}`);
  console.log(`📡 Live Kanal: ${CHANNEL_ID}`);
  console.log(`🧪 Test Kanal: ${TEST_CHANNEL_ID || 'nicht gesetzt'}`);
  await notify(`✅ <b>Bot gestartet</b>\nLive Risk: $${RISK_USD} | Test Risk: $${TEST_RISK_USD} | Max: $${MAX_POSITION_USD}`);
});

client.on('messageCreate', async (message) => {
  const isLive = message.channel.id === CHANNEL_ID;
  const isTest = TEST_CHANNEL_ID && message.channel.id === TEST_CHANNEL_ID;

  if (!isLive && !isTest) return;
  if (botPaused && isLive) { console.log('⏸ Pausiert'); return; }

  const { text: textContent, imageUrl } = extractMessageContent(message);

  console.log(`\n${isTest ? '🧪 TEST' : '📨 LIVE'} ${message.author.tag}: ${textContent || '[kein Text]'}`);
  if (imageUrl) console.log(`🖼️ Bild: ${imageUrl.substring(0, 60)}...`);
  if (message.embeds?.length > 0) console.log(`📋 Embeds: ${message.embeds.length}`);

  if (!textContent && !imageUrl) return;

  try {
    const signal = await analyzeSignal(textContent, imageUrl);
    console.log(`📊 Signal:`, JSON.stringify(signal));

    // TEST MODUS
    if (isTest) {
      if (!signal.signal) {
        await notify(`🧪 <b>Test – Kein Signal</b>\n${textContent?.substring(0, 100) || '-'}`);
        return;
      }

      if (signal.action === 'take_tp1_be') {
        await notify(`🧪 <b>TEST – Take TP1 + BE</b>\nAsset: ${signal.asset}\nWürde: TP1 Order suchen, canceln, at Market schließen, SL auf BE setzen`);
        return;
      }

      let entryPrice = signal.entry;
      if (!entryPrice && signal.asset) {
        try { entryPrice = await getPrice(signal.asset); } catch (e) {}
      }

      const tpList = signal.targets?.map((t, i) => `TP${i + 1}: $${t.price}`).join('\n') || '–';
      let msg = `🧪 <b>TEST – Kein Trade ausgeführt</b>\n\n`;
      msg += `Asset: ${signal.asset || '?'}\n`;
      msg += `Aktion: ${signal.action}\n`;
      msg += `Richtung: ${signal.direction || '?'}\n`;
      msg += `Entry: ${entryPrice ? '$' + entryPrice : 'Market'}\n`;
      msg += `SL: ${signal.stopLoss ? '$' + signal.stopLoss : '–'}\n`;
      msg += `${tpList}\n`;
      msg += `Confidence: ${signal.confidence || '?'}`;

      if (entryPrice && signal.stopLoss) {
        msg += '\n' + buildTestReport(signal, entryPrice);
      }

      await notify(msg);
      return;
    }

    // LIVE MODUS
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

    if (signal.action === 'take_tp1_be') {
      console.log(`🎯 Take TP1 + BE: ${signal.asset}`);
      const result = await takeTp1AndBreakeven(signal.asset, signal.direction || 'Long');
      if (result.tp1AlreadyFilled) {
        await notify(`↔️ <b>TP1 bereits getriggert</b>\nSL auf BE gesetzt: ${signal.asset} @ $${result.entryPrice}`);
      } else {
        await notify(`✅ <b>TP1 geschlossen + BE gesetzt</b>\nAsset: ${signal.asset}\nGeschlossen: ${result.tp1Size} Units\nBE: $${result.entryPrice}`);
      }
      return;
    }

    if (signal.confidence === 'Niedrig' || !signal.stopLoss) return;

    if (!signal.asset) {
      console.log(`⏭️ Kein Asset – übersprungen`);
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