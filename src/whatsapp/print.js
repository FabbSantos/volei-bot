// "Print" de um HTML pelo próprio Chrome do bot e envio como foto. Abre num
// contexto separado (sem cookies nem a sessão do WhatsApp) e fecha na hora —
// o fecharAbasExtras do boot nunca vê essa aba. Desenha o elemento #quadro.
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIMITE_MS = 20_000;

function comLimite(promessa, ms, oque) {
  let timer;
  return Promise.race([
    promessa,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${oque} demorou mais de ${ms / 1000}s`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function htmlParaPng(client, html) {
  const browser = client.page?.browser?.();
  if (!browser) throw new Error('navegador do bot indisponível');
  const contexto = await browser.createBrowserContext();
  try {
    const page = await contexto.newPage();
    await page.setViewport({ width: 1400, height: 800, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'load' });
    const quadro = await page.$('#quadro');
    return await (quadro || page).screenshot({ type: 'png' });
  } finally {
    await contexto.close().catch(() => {});
  }
}

async function enviarHtmlComoImagem(client, chatId, html, legenda) {
  const png = await comLimite(htmlParaPng(client, html), LIMITE_MS, 'o print');
  const arquivo = path.join(os.tmpdir(), `times-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.png`);
  fs.writeFileSync(arquivo, png);
  try {
    return await client.sendImage(chatId, arquivo, 'times.png', legenda || '');
  } finally {
    fs.rmSync(arquivo, { force: true });
  }
}

module.exports = { enviarHtmlComoImagem, htmlParaPng };
