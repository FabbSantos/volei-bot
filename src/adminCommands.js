const db = require('./db');

const REGEX_ATIVAR = /^#ativargrupo\s+(\S+)$/i;
const REGEX_DESATIVAR = /^#desativargrupo\s+(\S+)$/i;
const CMD_LISTAR = '#listargrupos';
const CMD_AJUDA_ADMIN = '#admin';

const TEXTO_AJUDA_ADMIN = `🔧 *Comandos de admin (só funcionam aqui no privado)*

*#listargrupos* — mostra todos os grupos que já mandaram mensagem, com status
*#ativargrupo <chat_id>* — libera um grupo pra usar o bot
*#desativargrupo <chat_id>* — bloqueia um grupo (ex: inadimplência)
*#admin* — mostra essa ajuda

Copia o *chat_id* certinho do resultado de #listargrupos antes de ativar/desativar.`;

// msg = { body, reply(texto) } — já validado que veio do número admin antes de chegar aqui
async function processarComandoAdmin(msg) {
  const texto = (msg.body || '').trim();

  if (texto.toLowerCase() === CMD_LISTAR) {
    const grupos = db.listarGrupos();
    if (grupos.length === 0) {
      return msg.reply('Nenhum grupo cadastrado ainda — o bot registra sozinho assim que alguém manda a primeira mensagem num grupo que ele participa.');
    }

    const linhas = grupos.map((g) => {
      const status = g.ativo ? '✅ ativo' : '⛔ inativo';
      return `${status} — ${g.nome || '(sem nome)'}\n   chat_id: ${g.chat_id}`;
    });

    return msg.reply(`📋 *Grupos cadastrados (${grupos.length}):*\n\n${linhas.join('\n\n')}`);
  }

  const matchAtivar = texto.match(REGEX_ATIVAR);
  if (matchAtivar) {
    const chatId = matchAtivar[1];
    const sucesso = db.ativarGrupo(chatId);
    return msg.reply(sucesso
      ? `✅ Grupo ${chatId} ativado! Já pode usar #listaDD/MM lá dentro.`
      : `Não achei nenhum grupo com esse chat_id. Confere com *#listargrupos*.`);
  }

  const matchDesativar = texto.match(REGEX_DESATIVAR);
  if (matchDesativar) {
    const chatId = matchDesativar[1];
    const sucesso = db.desativarGrupo(chatId);
    return msg.reply(sucesso
      ? `⛔ Grupo ${chatId} desativado. Comandos de lista vão parar de responder lá.`
      : `Não achei nenhum grupo com esse chat_id. Confere com *#listargrupos*.`);
  }

  if (texto.toLowerCase() === CMD_AJUDA_ADMIN) {
    return msg.reply(TEXTO_AJUDA_ADMIN);
  }
}

module.exports = { processarComandoAdmin };
