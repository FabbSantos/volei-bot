// Comandos de inadimplência digitados dentro do grupo da pelada.
const { comando } = require('../../nucleo/comandos');
const { paraCentavos, formatarReais } = require('../../nucleo/dinheiro');
const pelada = require('../pelada/repositorio');
const { celebrarPagamento } = require('../figurinhas');
const inadimplentes = require('./repositorio');

const REGEX_INADIMPLENTE = /^#inadimplente\s+(.+?)(?:\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?))?$/i;
const REGEX_QUITADO = /^#quitado\s+(.+)$/i;

const marcar = comando(REGEX_INADIMPLENTE, async (msg, m) => {
  if (!(await msg.ehAdmin())) {
    return msg.reply('🔒 Só admin do grupo pode marcar inadimplente.');
  }
  const alvoTexto = m[1].trim();
  const valor = m[2] ? paraCentavos(m[2]) : 0;

  let nome = alvoTexto;
  let numero = null;
  // Número curto = posição na lista atual (pega nome + contato de lá);
  // texto = marca só pelo nome
  if (/^\d{1,3}$/.test(alvoTexto)) {
    const lista = pelada.getListaMaisRecente(msg.chatId);
    const entrada = lista && pelada.getEntradaPorPosicao(lista.id, parseInt(alvoTexto, 10));
    if (!entrada) {
      return msg.reply(`Não achei ninguém na posição ${alvoTexto}. Confere com *#mostralista* ou usa *#inadimplente Nome*.`);
    }
    nome = entrada.nome;
    numero = entrada.numero;
  }

  const resultado = inadimplentes.adicionarInadimplente(msg.chatId, { nome, numero, valorCentavos: valor });
  if (resultado.erro === 'ja_esta') {
    return msg.reply(`${nome} já está na lista de inadimplentes.`);
  }
  return msg.reply(
    `⛔ ${nome} entrou na lista de inadimplentes${valor > 0 ? ` (deve ${formatarReais(valor)})` : ''}. Não entra em lista nova até um admin dar *#quitado ${nome}*.`
  );
});

const quitar = comando(REGEX_QUITADO, async (msg, m) => {
  if (!(await msg.ehAdmin())) {
    return msg.reply('🔒 Só admin do grupo pode quitar inadimplente.');
  }
  const resultado = inadimplentes.quitarInadimplente(msg.chatId, m[1].trim());
  if (resultado.erro) {
    return msg.reply('Não achei essa pessoa na lista de inadimplentes.');
  }
  await msg.reply(`✅ ${resultado.nome} pagou o agiota. 🤝`);
  await celebrarPagamento(msg);
});

module.exports = { comandos: [marcar, quitar] };
