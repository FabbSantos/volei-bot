const db = require('./db');

// Regex pro comando de abertura: #lista05/07, #lista5/7, #lista 05/07 etc.
const REGEX_ABRIR = /^#lista\s?(\d{1,2}\/\d{1,2})$/i;
const CMD_ENTRAR = '#lista';
const CMD_MOSTRAR = '#mostralista';
const CMD_ENCERRAR = '#encerrarlista';
const CMD_AJUDA = '#comandos';
const REGEX_REMOVER = /^#remover\s+(\d+)$/i;

const TEXTO_AJUDA = `🏐 *Comandos do bot*

*#listaDD/MM* — abre a lista pro dia (ex: #lista05/07)
*#lista* — entra na lista ativa
*#mostralista* — mostra a lista atual
*#remover N* — remove quem está na posição N (ex: #remover 5)
*#encerrarlista* — fecha a lista, para de aceitar nomes
*#comandos* — mostra essa ajuda`;

// msg = { body, pushname, from (numero), reply(texto) }
async function processarMensagem(msg) {
  const texto = (msg.body || '').trim();
  const nome = msg.pushname || msg.from;
  const numero = msg.from;

  const matchAbrir = texto.match(REGEX_ABRIR);
  if (matchAbrir) {
    const dataJogo = matchAbrir[1];
    const { ja_existia } = db.criarLista(dataJogo);
    if (ja_existia) {
      return msg.reply(`Já existe uma lista pro dia ${dataJogo}. Manda *#mostralista* pra ver.`);
    }
    return msg.reply(`✅ Lista aberta pro dia *${dataJogo}*! Manda *#lista* pra entrar.`);
  }

  if (texto.toLowerCase() === CMD_ENTRAR) {
    const lista = db.getListaAtiva();
    if (!lista) {
      return msg.reply('Nenhuma lista aberta no momento. Alguém precisa abrir com *#listaDD/MM*.');
    }

    const resultado = db.adicionarEntrada(lista.id, nome, numero);

    if (resultado.erro === 'ja_esta_na_lista') {
      return msg.reply(`${nome}, você já tá na lista! 😉`);
    }
    if (resultado.erro === 'tudo_lotado') {
      return msg.reply(`${nome}, infelizmente já lotou tudo hoje 🏐`);
    }

    const rotulo = resultado.tipo === 'principal'
      ? `posição ${resultado.posicao} da lista principal`
      : `posição ${resultado.posicao} da lista de espera`;
    await msg.reply(`✅ ${nome} entrou! Você está na ${rotulo}.`);

    if (resultado.evento === 'lista_cheia') {
      await msg.reply('🚨 Lista encheu! Vamos começar a lista de espera.');
    } else if (resultado.evento === 'tudo_lotado') {
      await msg.reply('🚨 Tudo lotado! Encerrando as vagas por hoje.');
    }
    return;
  }

  const matchRemover = texto.match(REGEX_REMOVER);
  if (matchRemover) {
    const lista = db.getListaAtiva();
    if (!lista) {
      return msg.reply('Nenhuma lista aberta no momento.');
    }
    const posicao = parseInt(matchRemover[1], 10);
    const resultado = db.removerPorPosicao(lista.id, posicao);

    if (resultado.erro === 'posicao_invalida') {
      return msg.reply(`Não achei ninguém na posição ${posicao}. Confere com *#mostralista*.`);
    }

    await msg.reply(`❌ ${resultado.removido} removido(a) da posição ${posicao}.`);
    if (resultado.promovido) {
      await msg.reply(`⬆️ ${resultado.promovido} subiu da espera pra lista principal!`);
    }
    return;
  }

  if (texto.toLowerCase() === CMD_MOSTRAR) {
    const lista = db.getListaAtiva();
    if (!lista) {
      const ultimas = db.historico();
      if (ultimas.length > 0) {
        return msg.reply(`Nenhuma lista aberta agora. A última foi *${ultimas[0].data_jogo}* (${ultimas[0].status}).`);
      }
      return msg.reply('Nenhuma lista criada ainda. Manda *#listaDD/MM* pra abrir uma.');
    }
    const texto_lista = db.montarListaFormatada(lista.id, lista.data_jogo);
    return msg.reply(texto_lista);
  }

  if (texto.toLowerCase() === CMD_ENCERRAR) {
    const lista = db.getListaAtiva();
    if (!lista) {
      return msg.reply('Não tem lista aberta pra encerrar.');
    }
    db.encerrarLista(lista.id);
    return msg.reply(`🔒 Lista do dia *${lista.data_jogo}* encerrada. Não aceita mais nomes.`);
  }

  if (texto.toLowerCase() === CMD_AJUDA) {
    return msg.reply(TEXTO_AJUDA);
  }
}

module.exports = { processarMensagem };
