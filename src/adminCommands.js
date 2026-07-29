const db = require('./db');

// #ativargrupo <chat_id> [vagas] [--espera] — ex: #ativargrupo 123@g.us 18 --6
// Os números são opcionais: sem eles, ativa mantendo o tamanho já configurado.
const REGEX_ATIVAR = /^#ativargrupo\s+(\S+)(?:\s+(\d{1,3}))?(?:\s+--(\d{1,3}))?$/i;
const REGEX_DESATIVAR = /^#desativargrupo\s+(\S+)$/i;
const CMD_LISTAR = '#listargrupos';
const CMD_AJUDA_ADMIN = '#admin';

const TEXTO_AJUDA_ADMIN = `🔧 *Comandos de admin (só funcionam aqui no privado)*

*#listargrupos* — mostra todos os grupos que já mandaram mensagem, com status e tamanho da lista
*#ativargrupo <chat_id>* — libera um grupo pra usar o bot
*#ativargrupo <chat_id> 18 --6* — libera e dimensiona: lista de 18 vagas + 6 de espera (padrão: 18 + 4)
*#desativargrupo <chat_id>* — bloqueia um grupo (ex: inadimplência)
*#admin* — mostra essa ajuda

Repetir #ativargrupo num grupo já ativo só atualiza o tamanho.
Copia o *chat_id* certinho do resultado de #listargrupos antes de ativar/desativar.`;

// msg = { body, reply(texto) } — já validado que veio do número admin antes de chegar aqui
async function processarComandoAdmin(msg) {
  const texto = (msg.body || '').trim();
  // Teclado de celular adora converter "--" em travessão (– ou —);
  // normaliza antes de tentar casar o comando de ativação
  const textoNormalizado = texto.replace(/[–—]/g, '--');

  if (texto.toLowerCase() === CMD_LISTAR) {
    const grupos = db.listarGrupos();
    if (grupos.length === 0) {
      return msg.reply('Nenhum grupo cadastrado ainda — o bot registra sozinho assim que alguém manda a primeira mensagem num grupo que ele participa.');
    }

    const linhas = grupos.map((g) => {
      const status = g.ativo ? '✅ ativo' : '⛔ inativo';
      return `${status} — ${g.nome || '(sem nome)'} — ${g.limite_principal} vagas + ${g.limite_espera} espera\n   chat_id: ${g.chat_id}`;
    });

    return msg.reply(`📋 *Grupos cadastrados (${grupos.length}):*\n\n${linhas.join('\n\n')}`);
  }

  const matchAtivar = textoNormalizado.match(REGEX_ATIVAR);
  if (matchAtivar) {
    const chatId = matchAtivar[1];
    const principal = matchAtivar[2] ? parseInt(matchAtivar[2], 10) : null;
    const espera = matchAtivar[3] ? parseInt(matchAtivar[3], 10) : null;

    if (principal !== null && principal < 1) {
      return msg.reply('O tamanho da lista precisa ser pelo menos 1. Ex: *#ativargrupo <chat_id> 18 --6*');
    }

    const { sucesso, promovidos } = db.ativarGrupo(chatId, { principal, espera });
    if (!sucesso) {
      return msg.reply('Não achei nenhum grupo com esse chat_id. Confere com *#listargrupos*.');
    }

    const grupo = db.getGrupo(chatId);
    let resposta = `✅ Grupo ${chatId} ativado! Lista com *${grupo.limite_principal}* vagas + *${grupo.limite_espera}* de espera. Já pode usar #listaDD/MM lá dentro.`;
    if (promovidos.length > 0) {
      resposta += `\n⬆️ Com a lista maior, subiram da espera: ${promovidos.join(', ')}. Bom avisar lá no grupo!`;
    }
    return msg.reply(resposta);
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

  // Qualquer variação de #ativargrupo/#desativargrupo que não casou acima é
  // sintaxe errada (ex: "18 -6", "18--6", "18 6") — responde com o uso em vez
  // de ficar mudo e deixar o admin achando que funcionou
  if (/^#(ativar|desativar)grupo\b/i.test(texto)) {
    return msg.reply(
      `Não entendi o formato 🤔 Uso:\n*#ativargrupo <chat_id>* — só ativa\n*#ativargrupo <chat_id> 18 --6* — ativa com 18 vagas + 6 de espera\n*#desativargrupo <chat_id>* — desativa\nPega o chat_id com *#listargrupos*.`
    );
  }
}

module.exports = { processarComandoAdmin };
