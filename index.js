require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');

const client = new Client();
const CHANNEL_ID = process.env.CHANNEL_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

async function analyzeSignal(text, imageUrl) {
  const content = [];

  if (imageUrl) {
    const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const base64 = Buffer.from(imageResponse.data).toString('base64');
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } });
  }

  content.push({
    type: 'text',
    text: `Du bist ein Trading Signal Analyzer. Analysiere diese Discord Nachricht und extrahiere das Trading Signal.
    
Nachricht: "${text}"

Antworte NUR in diesem Format:
ASSET: [z.B. TAO, BTC, ETH]
RICHTUNG: [Long oder Short]
ENTRY: [Preis oder "Market"]
STOP LOSS: [Preis oder "nicht angegeben"]
TAKE PROFIT: [Preis oder "nicht angegeben"]
KONFIDENZ: [Hoch/Mittel/Niedrig]

Falls es kein Trading Signal ist, antworte nur mit: KEIN SIGNAL`
  });

  const response = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    messages: [{ role: 'user', content }]
  }, {
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    }
  });

  return response.data.content[0].text;
}

client.on('ready', () => {
  console.log(`✅ Bot läuft! Eingeloggt als ${client.user.tag}`);
  console.log(`👀 Höre auf Kanal: ${CHANNEL_ID}`);
});

client.on('messageCreate', async (message) => {
  if (message.channel.id !== CHANNEL_ID) return;

  console.log(`\n📨 Neue Nachricht von: ${message.author.tag}`);
  console.log(`📝 Text: ${message.content}`);

  const imageUrl = message.attachments.size > 0 
    ? message.attachments.first().url 
    : null;

  if (imageUrl) console.log(`🖼️ Bild gefunden`);

  if (!message.content && !imageUrl) return;

  try {
    console.log(`🤖 KI analysiert...`);
    const signal = await analyzeSignal(message.content, imageUrl);
    console.log(`\n📊 Signal:\n${signal}`);
  } catch (err) {
    console.error(`❌ Fehler:`, err.message);
  }
});

client.login(process.env.DISCORD_TOKEN);
