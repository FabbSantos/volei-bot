// Figurinhas do agiota (assets/): comemoração de pagamento e "cadê meu pix".
const fs = require('fs');
const path = require('path');
const { semAcento } = require('../../nucleo/texto');

const PASTA = path.join(__dirname, '..', '..', '..', 'assets');

// Figurinha com dedicatória: quando a pessoa está na mira da cobrança, essa
// vai no lugar do sorteio. E ela NÃO entra no sorteio geral — a graça é ser
// dedicada. Pra adicionar outra, é só mais uma linha aqui.
const FIGURINHAS_PESSOAIS = [
  { pessoa: 'Ghemison', tema: 'cade-meu-pix', arquivo: 'cade-meu-pix-antonio' },
];

// Todas as figurinhas de um tema: agiota-pago.png, agiota-pago-2.gif,
// agiota-pago_festa.webp... (gif e webp animado viram figurinha animada)
function listarFigurinhas(nomeBase) {
  let arquivos;
  try {
    arquivos = fs.readdirSync(PASTA);
  } catch {
    return [];
  }
  const base = String(nomeBase).toLowerCase();
  // as dedicadas ficam de fora do sorteio (a não ser que sejam o próprio tema pedido)
  const dedicadas = FIGURINHAS_PESSOAIS.map((f) => f.arquivo.toLowerCase()).filter((a) => a !== base);
  return arquivos
    .filter((a) => {
      const nome = a.toLowerCase();
      const ext = nome.slice(nome.lastIndexOf('.'));
      if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return false;
      const semExt = nome.slice(0, nome.lastIndexOf('.'));
      if (dedicadas.includes(semExt)) return false;
      // aceita o nome exato ou com sufixo separado por - ou _
      return semExt === base || semExt.startsWith(base + '-') || semExt.startsWith(base + '_');
    })
    .sort()
    .map((a) => path.join(PASTA, a));
}

// Uma figurinha por vez, sorteada — assim não fica repetitivo
function acharFigurinha(nomeBase) {
  const todas = listarFigurinhas(nomeBase);
  if (todas.length === 0) return null;
  return todas[Math.floor(Math.random() * todas.length)];
}

// Cobrança: se alguém com figurinha dedicada está na mira, ela ganha do
// sorteio; senão, sorteia normalmente entre as do tema
function acharFigurinhaCobranca(pendentes = []) {
  const naMira = (pendentes || []).map(semAcento);
  for (const regra of FIGURINHAS_PESSOAIS) {
    if (regra.tema !== 'cade-meu-pix') continue;
    const alvo = semAcento(regra.pessoa);
    const achou = naMira.some((nome) => nome.includes(alvo) || alvo.includes(nome));
    if (!achou) continue;
    const dedicada = listarFigurinhas(regra.arquivo);
    if (dedicada.length > 0) return dedicada[Math.floor(Math.random() * dedicada.length)];
  }
  return acharFigurinha('cade-meu-pix');
}

// Figurinha comemorativa dos pagamentos — env FIGURINHA_QUITADO ganha do padrão
function acharFigurinhaQuitado() {
  if (process.env.FIGURINHA_QUITADO) return process.env.FIGURINHA_QUITADO;
  return acharFigurinha('agiota-pago');
}

// Figurinha do agiota em TODO pagamento marcado — semanal, mensal ou quitação
async function celebrarPagamento(msg) {
  const figurinha = acharFigurinhaQuitado();
  if (msg.enviarFigurinha && figurinha && fs.existsSync(figurinha)) {
    await msg.enviarFigurinha(figurinha);
  }
}

// Versão remota: comemora no grupo da pelada a partir do grupo de admins
async function celebrarPagamentoEm(msg, chatId) {
  const figurinha = acharFigurinhaQuitado();
  if (msg.enviarFigurinhaPara && figurinha && fs.existsSync(figurinha)) {
    await msg.enviarFigurinhaPara(chatId, figurinha);
  }
}

module.exports = {
  listarFigurinhas,
  acharFigurinha,
  acharFigurinhaCobranca,
  acharFigurinhaQuitado,
  celebrarPagamento,
  celebrarPagamentoEm,
};
