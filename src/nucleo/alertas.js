const fetch = require('node-fetch');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Crie um bot com o @BotFather no Telegram, pegue o token,
// e o chat_id mandando /start pro bot e olhando https://api.telegram.org/bot<TOKEN>/getUpdates
async function notificarFalha(mensagem) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[notify] Telegram não configurado, pulando alerta:', mensagem);
    return;
  }

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: `🚨 Bot do vôlei: ${mensagem}`,
      }),
    });
  } catch (err) {
    console.error('[notify] Falha ao enviar alerta no Telegram:', err.message);
  }
}

module.exports = { notificarFalha };
