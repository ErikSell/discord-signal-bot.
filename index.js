require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');

const client = new Client();

const CHANNEL_ID = process.env.CHANNEL_ID;

client.on('ready', () => {
  console.log(`✅ Bot läuft! Eingeloggt als ${client.user.tag}`);
  console.log(`👀 Höre auf Kanal: ${CHANNEL_ID}`);
});

client.on('messageCreate', async (message) => {
  // Nur den richtigen Kanal beachten
  if (message.channel.id !== CHANNEL_ID) return;

  console.log(`\n📨 Neue Nachricht von: ${message.author.tag}`);
  console.log(`📝 Text: ${message.content}`);

  // Bilder erkennen
  if (message.attachments.size > 0) {
    message.attachments.forEach(attachment => {
      console.log(`🖼️ Bild gefunden: ${attachment.url}`);
    });
  }
});

client.login(process.env.DISCORD_TOKEN);
