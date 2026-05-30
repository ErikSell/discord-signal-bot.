require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');
const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');

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

// ─── Trade Storage ─────────────────────────────────────────
const TRADES_FILE = './trades.json';
let trades = [];
let lastPositionSizes = {};

function loadTrades() {
  try {
    if (fs.existsSync(TRADES_FILE)) {
      trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
      console.log(`📂 ${trades.length} Trades geladen`);
    }
  } catch (e) { trades = []; }
}

function saveTrades() {
  try { fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2)); }
  catch (e) { console.error('Save error:', e.message); }
}

function addTrade(signal, entryPrice, totalSize) {
  const trade = {
    id: Date.now().toString(),
    asset: signal.asset,
    direction: signal.direction,
    entry: entryPrice,
    stopLoss: signal.stopLoss,
    targets: signal.targets || [],
    totalSize,
    openTime: new Date().toISOString(),
    status: 'open',
    closeTime: null,
    closeReason: null,
    pnl: 0,
    events: []
  };
  trades.push(trade);
  saveTrades();
  return trade;
}

function getOpenTrade(asset) {
  return trades.find(t => t.asset === asset && t.status === 'open');
}

function getWinRate() {
  const closed = trades.filter(t => t.status === 'closed');
  if (closed.length === 0) return { total: 0, wins: 0, losses: 0, rate: 0, totalPnl: 0 };
  const wins = closed.filter(t => t.pnl > 0).length;
  const losses = closed.filter(t => t.pnl <= 0).length;
  const totalPnl = closed.reduce((sum, t) => sum + (t.pnl || 0), 0);
  return { total: closed.length, wins, losses, rate: ((wins / closed.length) * 100).toFixed(1), totalPnl: totalPnl.toFixed(2) };
}

// ─── Telegram Setup ────────────────────────────────────────
const tg = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

tg.on('polling_error', (error) => {
  console.error('TG Polling Error:', error.message);
  if (error.message.includes('401') || error.message.includes('Unauthorized')) tg.stopPolling();
});

async function notify(msg) {
  try { await tg.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'HTML' }); }
  catch (e) { console.error('TG Error:', e.message); }
}

// ─── Message Extraction ────────────────────────────────────
function extractMessageContent(message) {
  let text = message.content || '';
  let imageUrl = null;

  if (message.attachments?.size > 0) {
    const att = message.attachments.first();
    if (att.contentType?.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp)$/i.test(att.url)) {
      imageUrl = att.url;
    }
  }

  if (message.embeds?.length > 0) {
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

// ─── Bitget Helpers ────────────────────────────────────────
function createSignature(timestamp, method, requestPath, body) {
  const message = timestamp + method + requestPath + (body || '');
  return crypto.createHmac('sha256', BITGET_SECRET).update(message).digest('base64');
}

function bitgetHeaders(timestamp, path, body) {
  const sign = createSignature(timestamp, 'POST', path, body);
  return {
    'ACCESS-KEY': BITGET_API_KEY, 'ACCESS-SIGN': sign,
    'ACCESS-TIMESTAMP': timestamp, 'ACCESS-PASSPHRASE': BITGET_PASSPHRASE,
    'Content-Type': 'application/json', 'locale': 'en-US'
  };
}

function bitgetGetHeaders(timestamp, path, queryString = '') {
  const sign = createSignature(timestamp, 'GET', path + queryString, '');
  return {
    'ACCESS-KEY': BITGET_API_KEY, 'ACCESS-SIGN': sign,
    'ACCESS-TIMESTAMP': timestamp, 'ACCESS-PASSPHRASE': BITGET_PASSPHRASE,
    'Content-Type': 'application/json', 'locale': 'en-US'
  };
}

function getTPDistribution(count) {
  const distributions = { 1: [100], 2: [60, 40], 3: [50, 30, 20], 4: [40, 25, 20, 15], 5: [30, 25, 20, 15, 10] };
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
  return r.data.data.find(a => a.marginCoin === 'USDT');
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
  const body = JSON.stringify({ symbol: symbol + 'USDT', productType: 'USDT-FUTURES', marginCoin: 'USDT', leverage: LEVERAGE });
  await axios.post(`https://api.bitget.com${path}`, body, { headers: bitgetHeaders(timestamp, path, body) });
}

async function placeOrder(symbol, direction, stopLoss, targets) {
  const fullSymbol = symbol + 'USDT';
  const price = await getPrice(symbol);
  const precision = await getSizePrecision(symbol);

  const riskPerUnit = Math.abs(price - stopLoss);
  let totalSize = RISK_USD / riskPerUnit;
  if (totalSize * price > MAX_POSITION_USD) totalSize = MAX_POSITION_USD / price;

  console.log(`📐 Size: ${totalSize.toFixed(precision)} ${symbol} | Notional: $${(totalSize * price).toFixed(2)}`);

  const mainBody = JSON.stringify({
    symbol: fullSymbol, productType: 'USDT-FUTURES', marginMode: 'isolated',
    marginCoin: 'USDT', size: totalSize.toFixed(precision),
    side: direction === 'Long' ? 'buy' : 'sell', tradeSide: 'open',
    orderType: 'market', presetStopLossPrice: stopLoss.toString()
  });

  const mainPath = '/api/v2/mix/order/place-order';
  await axios.post(`https://api.bitget.com${mainPath}`, mainBody, { headers: bitgetHeaders(Date.now().toString(), mainPath, mainBody) });
  console.log(`✅ Haupt-Order platziert`);
  await new Promise(r => setTimeout(r, 5000));

  if (targets?.length > 0) {
    const distribution = getTPDistribution(targets.length);
    for (let i = 0; i < targets.length; i++) {
      const tp = targets[i];
      const tpSize = (totalSize * distribution[i] / 100).toFixed(precision);
      await new Promise(r => setTimeout(r, 800));
      const tpBody = JSON.stringify({
        symbol: fullSymbol, productType: 'USDT-FUTURES', marginMode: 'isolated',
        marginCoin: 'USDT', side: direction === 'Long' ? 'sell' : 'buy',
        tradeSide: 'close', orderType: 'market', size: tpSize,
        triggerPrice: tp.price.toString(), triggerType: 'mark_price', planType: 'normal_plan'
      });
      const tpPath = '/api/v2/mix/order/place-plan-order';
      await axios.post(`https://api.bitget.com${tpPath}`, tpBody, { headers: bitgetHeaders(Date.now().toString(), tpPath, tpBody) });
      console.log(`🎯 TP${i + 1}: ${tpSize} ${symbol} @ $${tp.price} (${distribution[i]}%)`);
    }
  }

  return { totalSize, price };
}

async function closePosition(symbol) {
  const timestamp = Date.now().toString();
  const path = '/api/v2/mix/order/close-positions';
  const body = JSON.stringify({ symbol: symbol + 'USDT', productType: 'USDT-FUTURES', marginCoin: 'USDT' });
  const r = await axios.post(`https://api.bitget.com${path}`, body, { headers: bitgetHeaders(timestamp, path, body) });
  return r.data;
}

async function moveSlToBreakeven(symbol, direction, entryPrice) {
  const slPath = '/api/v2/mix/order/place-tpsl';
  const slBody = JSON.stringify({
    symbol: symbol + 'USDT', productType: 'USDT-FUTURES', marginCoin: 'USDT',
    planType: 'loss_plan', triggerPrice: entryPrice.toString(),
    triggerType: 'mark_price', holdSide: direction === 'Long' ? 'long' : 'short'
  });
  const r = await axios.post(`https://api.bitget.com${slPath}`, slBody, { headers: bitgetHeaders(Date.now().toString(), slPath, slBody) });
  return r.data;
}

async function takeTp1AndBreakeven(symbol, direction) {
  const fullSymbol = symbol + 'USDT';
  const timestamp = Date.now().toString();
  const path = '/api/v2/mix/order/orders-plan-pending';
  const queryString = `?symbol=${fullSymbol}&productType=USDT-FUTURES`;
  const r = await axios.get(`https://api.bitget.com${path}${queryString}`, {
    headers: bitgetGetHeaders(timestamp, path, queryString)
  });

  const planOrders = r.data.data?.entrustedList || r.data.data || [];

  if (planOrders.length === 0) {
    const positions = await getPositions();
    const position = positions.find(p => p.symbol === fullSymbol);
    if (position) {
      const entryPrice = parseFloat(position.openPriceAvg);
      await moveSlToBreakeven(symbol, direction, entryPrice);
      return { tp1AlreadyFilled: true, entryPrice };
    }
    return { tp1AlreadyFilled: true };
  }

  const sorted = [...planOrders].sort((a, b) => {
    const priceA = parseFloat(a.triggerPrice);
    const priceB = parseFloat(b.triggerPrice);
    return direction === 'Long' ? priceA - priceB : priceB - priceA;
  });

  const tp1Order = sorted[0];
  const tp1Size = tp1Order.size;
  const orderId = tp1Order.orderId;

  const cancelPath = '/api/v2/mix/order/cancel-plan-order';
  const cancelBody = JSON.stringify({ symbol: fullSymbol, productType: 'USDT-FUTURES', marginCoin: 'USDT', orderId });
  await axios.post(`https://api.bitget.com${cancelPath}`, cancelBody, { headers: bitgetHeaders(Date.now().toString(), cancelPath, cancelBody) });

  const precision = await getSizePrecision(symbol);
  const closePath = '/api/v2/mix/order/place-order';
  const closeBody = JSON.stringify({
    symbol: fullSymbol, productType: 'USDT-FUTURES', marginMode: 'isolated',
    marginCoin: 'USDT', size: parseFloat(tp1Size).toFixed(precision),
    side: direction === 'Long' ? 'sell' : 'buy', tradeSide: 'close', orderType: 'market'
  });
  await axios.post(`https://api.bitget.com${closePath}`, closeBody, { headers: bitgetHeaders(Date.now().toString(), closePath, closeBody) });

  await new Promise(r => setTimeout(r, 2000));
  const positions = await getPositions();
  const position = positions.find(p => p.symbol === fullSymbol);

  if (position) {
    const entryPrice = parseFloat(position.openPriceAvg);
    await moveSlToBreakeven(symbol, direction, entryPrice);
    return { tp1Closed: true, tp1Size, entryPrice };
  }

  return { tp1Closed: true, tp1Size };
}

// ─── Position Monitor ──────────────────────────────────────
async function monitorPositions() {
  try {
    const positions = await getPositions();
    const currentSymbols = new Set(positions.map(p => p.symbol));

    // Positionen die nicht mehr da sind → geschlossen
    for (const symbol of Object.keys(lastPositionSizes)) {
      if (!currentSymbols.has(symbol)) {
        const asset = symbol.replace('USDT', '');
        const trade = getOpenTrade(asset);

        if (trade) {
          const currentPrice = await getPrice(asset).catch(() => 0);
          const direction = trade.direction === 'Long' ? 1 : -1;
          const pnl = trade.totalSize * (currentPrice - trade.entry) * direction;

          trade.status = 'closed';
          trade.closeTime = new Date().toISOString();
          trade.pnl = parseFloat(pnl.toFixed(2));

          // Bestimme Close Reason
          if (currentPrice <= trade.stopLoss && trade.direction === 'Long') {
            trade.closeReason = 'SL';
          } else if (currentPrice >= trade.stopLoss && trade.direction === 'Short') {
            trade.closeReason = 'SL';
          } else {
            trade.closeReason = 'TP_FINAL';
          }

          trade.events.push({ time: new Date().toISOString(), type: trade.closeReason, price: currentPrice, pnl: trade.pnl });
          saveTrades();

          const emoji = trade.pnl > 0 ? '🟢' : '🔴';
          await notify(`
${emoji} <b>Position geschlossen</b>
Asset: ${asset}
Grund: ${trade.closeReason}
PnL: ${trade.pnl > 0 ? '+' : ''}$${trade.pnl}
          `);
        }

        delete lastPositionSizes[symbol];
      }
    }

    // Größenänderungen erkennen → TP teilweise getriggert
    for (const position of positions) {
      const symbol = position.symbol;
      const asset = symbol.replace('USDT', '');
      const currentSize = parseFloat(position.total);
      const lastSize = lastPositionSizes[symbol];

      if (lastSize && currentSize < lastSize - 0.0001) {
        const trade = getOpenTrade(asset);
        const currentPrice = parseFloat(position.markPrice || position.openPriceAvg);
        const sizeDecrease = lastSize - currentSize;

        if (trade) {
          // Welches TP wurde getriggert?
          const distribution = getTPDistribution(trade.targets.length);
          let tpNumber = '?';
          for (let i = 0; i < trade.targets.length; i++) {
            const expectedSize = trade.totalSize * distribution[i] / 100;
            if (Math.abs(sizeDecrease - expectedSize) / expectedSize < 0.15) {
              tpNumber = i + 1;
              break;
            }
          }

          const direction = trade.direction === 'Long' ? 1 : -1;
          const partialPnl = sizeDecrease * (currentPrice - trade.entry) * direction;
          trade.pnl += partialPnl;
          trade.events.push({ time: new Date().toISOString(), type: `TP${tpNumber}_HIT`, price: currentPrice, pnl: parseFloat(partialPnl.toFixed(2)) });
          saveTrades();

          await notify(`
🎯 <b>TP${tpNumber} getriggert!</b>
Asset: ${asset}
Preis: $${currentPrice}
Teilgewinn: +$${partialPnl.toFixed(2)}
          `);
        }
      }

      lastPositionSizes[symbol] = currentSize;
    }

    // Neue Positionen initialisieren
    for (const position of positions) {
      if (!(position.symbol in lastPositionSizes)) {
        lastPositionSizes[position.symbol] = parseFloat(position.total);
      }
    }
  } catch (e) {
    console.error('Monitor Fehler:', e.message);
  }
}

// ─── Claude Analysis ───────────────────────────────────────
async function analyzeSignal(text, imageUrl) {
  const content = [];
  if (imageUrl) {
    try {
      const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
      const base64 = Buffer.from(imageResponse.data).toString('base64');
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } });
    } catch (e) { console.log('Bild Fehler:', e.message); }
  }
  content.push({
    type: 'text',
    text: `Du bist ein Trading Signal Analyzer. Analysiere diese Nachricht/Bild genau.

Nachricht: "${text}"

Antworte NUR in JSON ohne Markdown.

Für ein neues Trade Signal:
{
  "signal": true, "action": "open", "asset": "BTC", "direction": "Long",
  "entry": 67000, "stopLoss": 65000,
  "targets": [{ "price": 68000 }, { "price": 69500 }], "confidence": "Hoch"
}

Für Close Signal: { "signal": true, "action": "close", "asset": "BTC" }
Für Breakeven Signal: { "signal": true, "action": "breakeven", "asset": "BTC", "entry": 67000 }
Für Take TP1 + BE: { "signal": true, "action": "take_tp1_be", "asset": "BTC", "direction": "Long" }
Falls kein Signal: { "signal": false }

Regeln:
- Asset = ERSTES WORT vor Long/Short, immer GROSSBUCHSTABEN
- Extrahiere ALLE TPs EXAKT – keine Zahlen erfinden
- Bei Bildern: Preiszahlen absolut präzise ablesen
- "TP1 hit", "TP2 hit", "third TP hit" etc. → signal: false (nur Info)
- "taking TP1 and moving stops BE" → action: take_tp1_be
- Confidence ist Hoch nur wenn SL erkennbar ist`
  });

  const response = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    messages: [{ role: 'user', content }]
  }, {
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
  });

  const raw = response.data.content[0].text.replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}

function buildTestReport(signal, entryPrice) {
  if (!signal.stopLoss) return '⚠️ Kein SL';
  const direction = signal.direction === 'Long' ? 1 : -1;
  const riskPerUnit = Math.abs(entryPrice - signal.stopLoss);
  const totalSize = TEST_RISK_USD / riskPerUnit;
  let report = `\n💼 <b>Berechnung</b>\nEntry: $${entryPrice.toFixed(4)}\nSize: ${totalSize.toFixed(2)} ${signal.asset}\nNotional: $${(totalSize * entryPrice).toFixed(2)}\n\n❌ SL Hit: -$${TEST_RISK_USD.toFixed(2)}\n`;
  if (signal.targets?.length > 0) {
    const distribution = getTPDistribution(signal.targets.length);
    let totalProfit = 0;
    report += `\n🎯 <b>Take Profits:</b>\n`;
    for (let i = 0; i < signal.targets.length; i++) {
      const profit = (totalSize * distribution[i] / 100) * (signal.targets[i].price - entryPrice) * direction;
      totalProfit += profit;
      report += `TP${i + 1} ($${signal.targets[i].price}) ${distribution[i]}%: +$${profit.toFixed(2)}\n`;
    }
    report += `\n💰 <b>Gesamt: +$${totalProfit.toFixed(2)} | RR: 1:${(totalProfit / TEST_RISK_USD).toFixed(2)}</b>`;
  }
  return report;
}

// ─── Telegram Commands ─────────────────────────────────────
tg.onText(/\/h/, (msg) => {
  tg.sendMessage(msg.chat.id, `
📖 <b>Commands Übersicht</b>

/d — Dashboard
/positions — Offene Positionen
/balance — Kontostand
/pnl — Unrealisiertes PnL
/history — Letzte 10 Trades
/winrate — Winrate & Stats
/trade [ASSET] — Trade Details
/risk — Live Risiko ändern
/testrisk — Test Risiko ändern
/close [ASSET] — Position schließen
/pause — Bot pausieren
/resume — Bot reaktivieren
/status — Bot Status
/h — Diese Übersicht
  `, { parse_mode: 'HTML' });
});

tg.onText(/\/winrate/, (msg) => {
  const stats = getWinRate();
  if (stats.total === 0) return tg.sendMessage(msg.chat.id, '📭 Noch keine geschlossenen Trades.');
  tg.sendMessage(msg.chat.id, `
📊 <b>Winrate & Stats</b>

Trades gesamt: ${stats.total}
Wins: 🟢 ${stats.wins}
Losses: 🔴 ${stats.losses}
Winrate: <b>${stats.rate}%</b>
Total PnL: ${parseFloat(stats.totalPnl) >= 0 ? '🟢' : '🔴'} $${stats.totalPnl}
  `, { parse_mode: 'HTML' });
});

tg.onText(/\/history/, (msg) => {
  const closed = trades.filter(t => t.status === 'closed').slice(-10).reverse();
  if (closed.length === 0) return tg.sendMessage(msg.chat.id, '📭 Keine Trade History.');
  let text = '📋 <b>Letzte Trades</b>\n\n';
  for (const t of closed) {
    const emoji = t.pnl > 0 ? '🟢' : '🔴';
    const date = new Date(t.openTime).toLocaleDateString('de-DE');
    text += `${emoji} <b>${t.asset}</b> ${t.direction} | ${t.closeReason} | ${t.pnl > 0 ? '+' : ''}$${t.pnl} | ${date}\n`;
  }
  tg.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
});

tg.onText(/\/trade (.+)/, (msg, match) => {
  const asset = match[1].toUpperCase();
  const assetTrades = trades.filter(t => t.asset === asset).slice(-5).reverse();
  if (assetTrades.length === 0) return tg.sendMessage(msg.chat.id, `📭 Keine Trades für ${asset}.`);

  for (const t of assetTrades) {
    let text = `📊 <b>${t.asset} ${t.direction}</b>\n`;
    text += `Status: ${t.status === 'open' ? '🟡 Offen' : (t.pnl > 0 ? '🟢 Win' : '🔴 Loss')}\n`;
    text += `Entry: $${t.entry}\n`;
    text += `SL: $${t.stopLoss}\n`;
    if (t.targets?.length > 0) text += `TPs: ${t.targets.map(tp => '$' + tp.price).join(' | ')}\n`;
    text += `Geöffnet: ${new Date(t.openTime).toLocaleString('de-DE')}\n`;
    if (t.closeTime) text += `Geschlossen: ${new Date(t.closeTime).toLocaleString('de-DE')}\n`;
    text += `PnL: ${t.pnl > 0 ? '+' : ''}$${t.pnl}\n`;
    if (t.events?.length > 0) {
      text += `\n<b>Events:</b>\n`;
      for (const e of t.events) {
        const time = new Date(e.time).toLocaleString('de-DE');
        text += `• ${e.type} @ $${e.price} | ${e.pnl > 0 ? '+' : ''}$${e.pnl} | ${time}\n`;
      }
    }
    tg.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
  }
});

tg.onText(/\/status/, (msg) => {
  const stats = getWinRate();
  tg.sendMessage(msg.chat.id, `
🤖 <b>Bot Status</b>

Status: ${botPaused ? '⏸ Pausiert' : '✅ Aktiv'}
Live Risiko: $${RISK_USD}
Test Risiko: $${TEST_RISK_USD}
Max Position: $${MAX_POSITION_USD}
Winrate: ${stats.total > 0 ? stats.rate + '%' : 'N/A'}
  `, { parse_mode: 'HTML' });
});

tg.onText(/\/pause/, (msg) => { botPaused = true; tg.sendMessage(msg.chat.id, '⏸ <b>Bot pausiert</b>', { parse_mode: 'HTML' }); });
tg.onText(/\/resume/, (msg) => { botPaused = false; tg.sendMessage(msg.chat.id, '▶️ <b>Bot aktiv</b>', { parse_mode: 'HTML' }); });

tg.onText(/\/risk/, (msg) => {
  waitingForRisk = true; waitingForTestRisk = false;
  tg.sendMessage(msg.chat.id, `💰 Live Risiko: <b>$${RISK_USD}</b>\n\nNeues Live Risiko eintippen:`, { parse_mode: 'HTML' });
});

tg.onText(/\/testrisk/, (msg) => {
  waitingForTestRisk = true; waitingForRisk = false;
  tg.sendMessage(msg.chat.id, `🧪 Test Risiko: <b>$${TEST_RISK_USD}</b>\n\nNeues Test Risiko eintippen:`, { parse_mode: 'HTML' });
});

tg.onText(/\/balance/, async (msg) => {
  try {
    const balance = await getBalance();
    tg.sendMessage(msg.chat.id, `💰 <b>Kontostand</b>\n\nVerfügbar: $${parseFloat(balance.available).toFixed(2)}\nGesamt: $${parseFloat(balance.accountEquity).toFixed(2)}\nUnrealisiert: $${parseFloat(balance.unrealizedPL).toFixed(2)}`, { parse_mode: 'HTML' });
  } catch (e) { tg.sendMessage(msg.chat.id, '❌ Fehler.'); }
});

tg.onText(/\/pnl/, async (msg) => {
  try {
    const positions = await getPositions();
    if (positions.length === 0) return tg.sendMessage(msg.chat.id, '📭 Keine Positionen.');
    let text = '📊 <b>PnL</b>\n\n';
    let total = 0;
    for (const p of positions) {
      const pnl = parseFloat(p.unrealizedPL);
      total += pnl;
      text += `${p.symbol}: ${pnl >= 0 ? '🟢' : '🔴'} $${pnl.toFixed(2)}\n`;
    }
    text += `\n<b>Total: ${total >= 0 ? '🟢' : '🔴'} $${total.toFixed(2)}</b>`;
    tg.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
  } catch (e) { tg.sendMessage(msg.chat.id, '❌ Fehler.'); }
});

tg.onText(/\/close (.+)/, async (msg, match) => {
  const asset = match[1].toUpperCase();
  try {
    await closePosition(asset);
    const trade = getOpenTrade(asset);
    if (trade) {
      trade.status = 'closed';
      trade.closeTime = new Date().toISOString();
      trade.closeReason = 'MANUAL';
      saveTrades();
    }
    tg.sendMessage(msg.chat.id, `✅ <b>${asset}</b> geschlossen.`, { parse_mode: 'HTML' });
  } catch (e) { tg.sendMessage(msg.chat.id, `❌ Fehler: ${e.message}`); }
});

tg.onText(/\/positions/, async (msg) => {
  try {
    const positions = await getPositions();
    if (positions.length === 0) return tg.sendMessage(msg.chat.id, '📭 Keine Positionen.');
    for (const p of positions) {
      const pnl = parseFloat(p.unrealizedPL);
      const asset = p.symbol.replace('USDT', '');
      await tg.sendMessage(msg.chat.id, `
${p.holdSide === 'long' ? '🟢 Long' : '🔴 Short'} <b>${p.symbol}</b>
Size: ${p.total} | Entry: $${parseFloat(p.openPriceAvg).toFixed(4)}
PnL: ${pnl >= 0 ? '🟢' : '🔴'} $${pnl.toFixed(2)}
      `, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: `❌ Close ${asset}`, callback_data: `close_${asset}` }]] }
      });
    }
  } catch (e) { tg.sendMessage(msg.chat.id, '❌ Fehler.'); }
});

tg.onText(/\/d/, async (msg) => {
  try {
    const [positions, balance] = await Promise.all([getPositions(), getBalance()]);
    const totalPnl = positions.reduce((sum, p) => sum + parseFloat(p.unrealizedPL), 0);
    const stats = getWinRate();
    let text = `📊 <b>Dashboard</b>\n\n`;
    text += `💰 Balance: $${parseFloat(balance.accountEquity).toFixed(2)}\n`;
    text += `📈 PnL: ${totalPnl >= 0 ? '🟢' : '🔴'} $${totalPnl.toFixed(2)}\n`;
    text += `🎯 Positionen: ${positions.length}\n`;
    text += `📊 Winrate: ${stats.total > 0 ? stats.rate + '%' : 'N/A'}\n`;
    text += `⚡ Live Risk: $${RISK_USD} | 🧪 Test: $${TEST_RISK_USD}\n`;
    text += `🤖 Bot: ${botPaused ? '⏸ Pausiert' : '✅ Aktiv'}\n`;
    if (positions.length > 0) {
      text += '\n<b>Positionen:</b>\n';
      for (const p of positions) {
        const pnl = parseFloat(p.unrealizedPL);
        text += `• ${p.symbol} ${p.holdSide === 'long' ? '🟢' : '🔴'} $${pnl.toFixed(2)}\n`;
      }
    }
    tg.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
  } catch (e) { tg.sendMessage(msg.chat.id, '❌ Dashboard Fehler.'); }
});

tg.on('callback_query', async (query) => {
  if (query.data.startsWith('close_')) {
    const asset = query.data.replace('close_', '');
    try {
      await closePosition(asset);
      const trade = getOpenTrade(asset);
      if (trade) { trade.status = 'closed'; trade.closeTime = new Date().toISOString(); trade.closeReason = 'MANUAL'; saveTrades(); }
      tg.answerCallbackQuery(query.id, { text: `✅ ${asset} geschlossen!` });
      tg.editMessageText(`✅ <b>${asset}</b> geschlossen.`, { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: 'HTML' });
    } catch (e) { tg.answerCallbackQuery(query.id, { text: `❌ ${e.message}` }); }
  }
});

tg.on('message', (msg) => {
  if ((waitingForRisk || waitingForTestRisk) && msg.text && !msg.text.startsWith('/')) {
    const amount = parseFloat(msg.text);
    if (!isNaN(amount) && amount > 0) {
      if (waitingForRisk) { RISK_USD = amount; waitingForRisk = false; tg.sendMessage(msg.chat.id, `✅ Live Risk: <b>$${RISK_USD}</b>`, { parse_mode: 'HTML' }); }
      else { TEST_RISK_USD = amount; waitingForTestRisk = false; tg.sendMessage(msg.chat.id, `✅ Test Risk: <b>$${TEST_RISK_USD}</b>`, { parse_mode: 'HTML' }); }
    } else { tg.sendMessage(msg.chat.id, '❌ Ungültige Zahl.'); }
  }
});

// ─── Discord Bot ───────────────────────────────────────────
client.on('ready', async () => {
  console.log(`✅ Bot läuft! Eingeloggt als ${client.user.tag}`);
  loadTrades();
  setInterval(monitorPositions, 60000);
  setTimeout(monitorPositions, 5000);
  await notify(`✅ <b>Bot gestartet</b>\nLive Risk: $${RISK_USD} | Max: $${MAX_POSITION_USD}`);
});

client.on('messageCreate', async (message) => {
  const isLive = message.channel.id === CHANNEL_ID;
  const isTest = TEST_CHANNEL_ID && message.channel.id === TEST_CHANNEL_ID;
  if (!isLive && !isTest) return;
  if (botPaused && isLive) return;

  const { text: textContent, imageUrl } = extractMessageContent(message);
  console.log(`\n${isTest ? '🧪' : '📨'} ${message.author.tag}: ${textContent || '[kein Text]'}`);
  if (!textContent && !imageUrl) return;

  try {
    const signal = await analyzeSignal(textContent, imageUrl);
    console.log(`📊 Signal:`, JSON.stringify(signal));

    if (isTest) {
      if (!signal.signal) { await notify(`🧪 <b>Kein Signal</b>\n${textContent?.substring(0, 100)}`); return; }
      if (signal.action === 'take_tp1_be') { await notify(`🧪 <b>TEST – Take TP1 + BE</b>\nAsset: ${signal.asset}\nWürde TP1 schließen und SL auf BE setzen`); return; }
      let entryPrice = signal.entry;
      if (!entryPrice && signal.asset) try { entryPrice = await getPrice(signal.asset); } catch (e) {}
      const tpList = signal.targets?.map((t, i) => `TP${i + 1}: $${t.price}`).join('\n') || '–';
      let msg = `🧪 <b>TEST – Kein Trade ausgeführt</b>\n\nAsset: ${signal.asset || '?'}\nRichtung: ${signal.direction || '?'}\nEntry: ${entryPrice ? '$' + entryPrice : 'Market'}\nSL: ${signal.stopLoss ? '$' + signal.stopLoss : '–'}\n${tpList}\nConfidence: ${signal.confidence || '?'}`;
      if (entryPrice && signal.stopLoss) msg += '\n' + buildTestReport(signal, entryPrice);
      await notify(msg);
      return;
    }

    if (!signal.signal) return;

    if (signal.action === 'close') {
      await closePosition(signal.asset);
      const trade = getOpenTrade(signal.asset);
      if (trade) { trade.status = 'closed'; trade.closeTime = new Date().toISOString(); trade.closeReason = 'MANUAL_DISCORD'; saveTrades(); }
      await notify(`🔴 <b>Position geschlossen</b>\n${signal.asset}`);
      return;
    }

    if (signal.action === 'breakeven') {
      if (!signal.entry) return;
      await moveSlToBreakeven(signal.asset, signal.direction || 'Long', signal.entry);
      await notify(`↔️ <b>SL auf BE</b>\n${signal.asset} @ $${signal.entry}`);
      return;
    }

    if (signal.action === 'take_tp1_be') {
      const result = await takeTp1AndBreakeven(signal.asset, signal.direction || 'Long');
      if (result.tp1AlreadyFilled) {
        await notify(`↔️ <b>TP1 bereits getriggert – BE gesetzt</b>\n${signal.asset} @ $${result.entryPrice}`);
      } else {
        await notify(`✅ <b>TP1 geschlossen + BE gesetzt</b>\n${signal.asset} | ${result.tp1Size} Units`);
      }
      return;
    }

    if (signal.confidence === 'Niedrig' || !signal.stopLoss || !signal.asset) return;

    // DUPLICATE PROTECTION
    const existingPosition = (await getPositions()).find(p => p.symbol === signal.asset + 'USDT');
    if (existingPosition) {
      console.log(`⏭️ Duplicate Protection: ${signal.asset} bereits offen`);
      await notify(`⚠️ <b>Duplicate geblockt</b>\n${signal.asset} bereits offen`);
      return;
    }

    await setLeverage(signal.asset);
    const result = await placeOrder(signal.asset, signal.direction, signal.stopLoss, signal.targets);

    // Trade speichern
    addTrade(signal, result.price, result.totalSize);

    const tpList = signal.targets?.map((t, i) => `TP${i + 1}: $${t.price}`).join('\n') || '–';
    await notify(`
🟢 <b>Trade eröffnet</b>
Asset: ${signal.asset} ${signal.direction}
Entry: $${result.price}
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