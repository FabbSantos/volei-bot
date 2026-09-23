// Administração dos grupos: liberar/bloquear, dimensionar, grupo de admins,
// quem é admin lá e o recado avulso (#anuncio).
const { comando } = require('../../nucleo/comandos');
const { formatarReais } = require('../../nucleo/dinheiro');
const pelada = require('../pelada/repositorio');
const grupos = require('./repositorio');
const { resolverGrupo, separarGrupoENome } = require('./remoto');

// #ativargrupo <chat_id> [vagas] [--espera] — ex: #ativargrupo 123@g.us 18 --6
// Os números são opcionais: sem eles, ativa mantendo o tamanho já configurado.
const REGEX_ATIVAR = /^#ativargrupo\s+(\S+)(?:\s+(\d{1,3}))?(?:\s+--(\d{1,3}))?$/i;
const REGEX_DESATIVAR = /^#desativargrupo\s+(\S+)$/i;
const REGEX_ADMINS_DE = /^#adminsde\s+(.+)$/i;
const REGEX_GRUPO_ADMIN = /^#grupoadmin\s+(\S+)(?:\s+(off))?$/i;
// Recado avulso pro grupo da pelada, saindo EXATAMENTE como foi escrito —
// sem prefixo, sem emoji do bot, sem "mensagem dos admins". [\s\S] no lugar
// do ponto pra aceitar anúncio de várias linhas.
const REGEX_ANUNCIO = /^#anuncio\s+([\s\S]+)$/i;
// "#anunciode" entra como apelido: o nome certo é difícil de acertar de
// primeira e errar custa um comando perdido na hora do anúncio.
const REGEX_ANUNCIO_DE = /^#anunci(?:ar|o)de\s+([\s\S]+)$/i;

const nomeDo = (grupo) => grupo.nome || grupo.chat_id;

const listar = comando('#listargrupos', (msg) => {
  const todos = grupos.listarGrupos();
  if (todos.length === 0) {
    return msg.reply('Nenhum grupo cadastrado ainda — o bot registra sozinho assim que alguém manda a primeira mensagem num grupo que ele participa.');
  }

  const linhas = todos.map((g) => {
    const status = g.eh_admin ? '🛠 admin' : (g.ativo ? '✅ ativo' : '⛔ inativo');
    const valor = g.valor_padrao_centavos > 0 ? ` — ${formatarReais(g.valor_padrao_centavos)}/pessoa` : '';
    return `${status} — ${g.nome || '(sem nome)'} — ${g.limite_principal} vagas + ${g.limite_espera} espera${valor}\n   chat_id: ${g.chat_id}`;
  });

  return msg.reply(`📋 *Grupos cadastrados (${todos.length}):*\n\n${linhas.join('\n\n')}`);
});

// Teclado de celular adora converter "--" em travessão (– ou —);
// normaliza antes de tentar casar o comando de ativação
const ativar = {
  casa: (texto) => texto.replace(/[–—]/g, '--').match(REGEX_ATIVAR),
  executar: async (msg, m) => {
    const chatId = m[1];
    const principal = m[2] ? parseInt(m[2], 10) : null;
    const espera = m[3] ? parseInt(m[3], 10) : null;

    if (principal !== null && principal < 1) {
      return msg.reply('O tamanho da lista precisa ser pelo menos 1. Ex: *#ativargrupo <chat_id> 18 --6*');
    }

    if (!grupos.ativarGrupo(chatId, { principal, espera })) {
      return msg.reply('Não achei nenhum grupo com esse chat_id. Confere com *#listargrupos*.');
    }
    // Se a lista aberta cresceu, quem estava na espera sobe na hora
    const promovidos = pelada.promoverEsperaDaListaAtiva(chatId);

    const grupo = grupos.getGrupo(chatId);
    let resposta = `✅ Grupo ${chatId} ativado! Lista com *${grupo.limite_principal}* vagas + *${grupo.limite_espera}* de espera. Já pode usar #listaDD/MM lá dentro.`;
    if (promovidos.length > 0) {
      resposta += `\n⬆️ Com a lista maior, subiram da espera: ${promovidos.join(', ')}. Bom avisar lá no grupo!`;
    }
    return msg.reply(resposta);
  },
};

const desativar = comando(REGEX_DESATIVAR, (msg, m) => {
  const chatId = m[1];
  const sucesso = grupos.desativarGrupo(chatId);
  return msg.reply(sucesso
    ? `⛔ Grupo ${chatId} desativado. Comandos de lista vão parar de responder lá.`
    : `Não achei nenhum grupo com esse chat_id. Confere com *#listargrupos*.`);
});

const adminsDe = comando(REGEX_ADMINS_DE, async (msg, m) => {
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  if (!msg.getAdminsDoGrupo) {
    return msg.reply('Consulta de admins indisponível nesta sessão.');
  }
  try {
    const admins = await msg.getAdminsDoGrupo(r.grupo.chat_id);
    if (!admins || admins.length === 0) {
      return msg.reply(`Não achei admins em *${nomeDo(r.grupo)}* — o bot está nesse grupo?`);
    }
    const linhas = admins.map((a) => `• ${String(a).replace(/@.+$/, '')}`).join('\n');
    return msg.reply(`👑 *Admins de ${nomeDo(r.grupo)}* (${admins.length}) — são eles que podem marcar #pago lá:\n${linhas}`);
  } catch (err) {
    return msg.reply(`Não consegui consultar os admins de *${nomeDo(r.grupo)}* (${err.message}). O bot está nesse grupo?`);
  }
});

const grupoAdmin = comando(REGEX_GRUPO_ADMIN, (msg, m) => {
  // Só no privado: senão qualquer um num grupo promovido poderia promover outros
  if (msg.origem !== 'privado') {
    return msg.reply('Por segurança, *#grupoadmin* só funciona no privado com o admin do bot.');
  }
  const chatId = m[1];
  const desligar = Boolean(m[2]);
  // Grupo com lista aberta é grupo de pelada — virar admin por engano
  // silencia os comandos de lista e deixa os pagamentos imarcáveis
  if (!desligar && pelada.getListaAtiva(chatId)) {
    return msg.reply('Esse grupo tem uma lista aberta — parece grupo de pelada, não de admins. Se tiver certeza, encerra a lista lá primeiro.');
  }
  const ok = grupos.marcarGrupoAdmin(chatId, !desligar);
  if (!ok) {
    return msg.reply('Não achei nenhum grupo com esse chat_id. Confere com *#listargrupos*.');
  }
  return msg.reply(desligar
    ? `🛠 Grupo ${chatId} deixou de ser grupo de admins.`
    : `🛠 Grupo ${chatId} agora é grupo de admins! Todo mundo lá pode usar os comandos remotos (#listade, #pagosde, #adminsde, #valorde...). Manda *#admin* lá pra ver tudo.`);
});

// #anunciarde <grupo> <texto> escolhe o grupo; #anuncio <texto> vai no único
// grupo ativo, e recusa quando há mais de um em vez de chutar destino.
async function anunciar(msg, grupo, recado) {
  recado = recado.trim();
  if (!recado) return msg.reply('Anúncio vazio — escreve o texto depois do comando.');

  const nomeGrupo = nomeDo(grupo);
  if (!msg.enviarPara) {
    return msg.reply('Não consigo falar com o grupo agora (bot desconectado).');
  }

  // Marcação OCULTA: a lista de menções vai no envio, mas os @numero NÃO
  // entram no texto. O celular de todo mundo apita e a mensagem aparece
  // limpa — com 70 pessoas, o cabeçalho de menções seria um paredão.
  // (@todos/@all não existe pra bot: é recurso do app, não do protocolo.)
  let mencoes = [];
  let avisoMencao = '';
  if (msg.getMembrosDoGrupo) {
    try {
      mencoes = (await msg.getMembrosDoGrupo(grupo.chat_id)) || [];
    } catch (err) {
      avisoMencao = `\n\n⚠️ Não consegui marcar o pessoal (${err.message}) — o recado saiu sem notificação.`;
    }
  }

  try {
    await msg.enviarPara(grupo.chat_id, recado, mencoes.length ? { mentionedList: mencoes } : undefined);
  } catch (err) {
    return msg.reply(`⚠️ Não consegui anunciar em *${nomeGrupo}*: ${err.message}`);
  }
  return msg.reply(
    `📣 Anunciado em *${nomeGrupo}*${mencoes.length ? `, notificando ${mencoes.length} pessoa(s)` : ''}. Saiu assim:\n\n${recado}${avisoMencao}`
  );
}

const anuncioDe = comando(REGEX_ANUNCIO_DE, (msg, m) => {
  const separado = separarGrupoENome(m[1]);
  if (!separado.nome) {
    return msg.reply('Falta o texto do anúncio. Ex: *#anunciarde riachuelo Jogo de sexta cancelado*');
  }
  const r = resolverGrupo(separado.termo);
  if (r.mensagem) return msg.reply(r.mensagem);
  return anunciar(msg, r.grupo, separado.nome);
});

const anuncio = comando(REGEX_ANUNCIO, (msg, m) => {
  const candidatos = grupos.listarGrupos().filter((g) => g.ativo && !g.eh_admin);
  if (candidatos.length === 0) {
    return msg.reply('Nenhum grupo ativo pra anunciar.');
  }
  if (candidatos.length > 1) {
    const lista = candidatos.map((g) => `• ${nomeDo(g)}`).join('\n');
    return msg.reply(
      `Tem ${candidatos.length} grupos ativos, não sei em qual anunciar:\n${lista}\n\nUsa *#anunciarde <grupo> <texto>*.`
    );
  }
  return anunciar(msg, candidatos[0], m[1]);
});

module.exports = {
  // O cadastro dos grupos vem antes; adminsde/grupoadmin/anúncio, depois dos
  // comandos de lista e mensalista (a ordem de sempre)
  comandosCadastro: [listar, ativar, desativar],
  comandos: [adminsDe, grupoAdmin, anuncioDe, anuncio],
};
