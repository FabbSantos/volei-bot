const db = require('./db');

// Regex pro comando de abertura: #lista05/07, #lista5/7, #lista 05/07 etc.
const REGEX_ABRIR = /^#lista\s?(\d{1,2}\/\d{1,2})$/i;
// #lista sozinho, ou #lista Nome Sobrenome (nome explícito opcional)
const REGEX_ENTRAR = /^#lista(?:\s+(.+))?$/i;
const CMD_MOSTRAR = '#mostralista';
const CMD_ENCERRAR = '#encerrarlista';
const CMD_AJUDA = '#comandos';
const REGEX_REMOVER = /^#remover\s+(\d+)$/i;
// Comandos de teste — só funcionam se TEST_MODE=true no .env/Railway.
// Pensados pra validar o fluxo de lotação/espera sem precisar de 22 pessoas reais.
const REGEX_TESTAR_ENCHER = /^#testarencher\s+(\d+)$/i;
const CMD_TESTAR_LIMPAR = '#testarlimpar';

const TEST_MODE = process.env.TEST_MODE === 'true';

const TEXTO_AJUDA = `🏐 *Comandos do bot*

*#listaDD/MM* — abre a lista pro dia (ex: #lista05/07)
*#lista* — entra na lista ativa usando seu nome do WhatsApp
*#lista Nome* — entra na lista com um nome específico (ex: #lista João)
*#mostralista* — mostra a lista atual
*#remover N* — remove quem está na posição N (ex: #remover 5)
*#encerrarlista* — fecha a lista, para de aceitar nomes
*#comandos* — mostra essa ajuda`;

const TEXTO_AJUDA_TESTE = `\n\n🧪 *Comandos de teste (TEST_MODE ligado)*
*#testarencher N* — adiciona N pessoas fake na lista (ex: #testarencher 15)
*#testarlimpar* — apaga todo mundo da lista ativa, sem precisar recriar`;

function correspondeAlgumComando(texto) {
  const textoLower = texto.toLowerCase();
  const comandoNormal = (
    REGEX_ABRIR.test(texto) ||
    REGEX_ENTRAR.test(texto) ||
    REGEX_REMOVER.test(texto) ||
    textoLower === CMD_MOSTRAR ||
    textoLower === CMD_ENCERRAR ||
    textoLower === CMD_AJUDA
  );
  const comandoTeste = TEST_MODE && (
    REGEX_TESTAR_ENCHER.test(texto) || textoLower === CMD_TESTAR_LIMPAR
  );
  return comandoNormal || comandoTeste;
}

// msg = { body, pushname, chatId, numero, nomeGrupo, reply(texto) }
async function processarMensagem(msg) {
  const texto = (msg.body || '').trim();
  const chatId = msg.chatId;

  // Cadastra o grupo silenciosamente na primeira mensagem — não faz
  // nada além disso até algum comando de fato ser reconhecido.
  const grupo = db.registrarGrupoSeNovo(chatId, msg.nomeGrupo);

  if (!grupo.ativo) {
    // Só avisa se for de fato um comando reconhecido do bot (ex: #lista,
    // #lista05/07, #mostralista...), não qualquer mensagem com # no meio
    // do papo normal do grupo (tipo "#quintou").
    if (correspondeAlgumComando(texto)) {
      return msg.reply('🔒 Esse grupo ainda não foi liberado pra usar o bot. Fala com quem administra.');
    }
    return;
  }

  const matchAbrir = texto.match(REGEX_ABRIR);
  if (matchAbrir) {
    const dataJogo = matchAbrir[1];
    const { ja_existia } = db.criarLista(chatId, dataJogo);
    if (ja_existia) {
      return msg.reply(`Já existe uma lista pro dia ${dataJogo}. Manda *#mostralista* pra ver.`);
    }
    return msg.reply(`✅ Lista aberta pro dia *${dataJogo}*! Manda *#lista* pra entrar.`);
  }

  const matchEntrar = texto.match(REGEX_ENTRAR);
  if (matchEntrar) {
    const nomeExplicito = matchEntrar[1]?.trim();
    const nome = nomeExplicito || msg.pushname || msg.numero;

    const lista = db.getListaAtiva(chatId);
    if (!lista) {
      return msg.reply('Nenhuma lista aberta no momento. Alguém precisa abrir com *#listaDD/MM*.');
    }

    const resultado = db.adicionarEntrada(lista.id, nome, msg.numero);

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

    // Cospe a lista atualizada como confirmação visual, sempre
    const textoLista = db.montarListaFormatada(lista.id, lista.data_jogo);
    return msg.reply(textoLista);
  }

  if (texto.toLowerCase() === CMD_MOSTRAR) {
    const lista = db.getListaAtiva(chatId);
    if (!lista) {
      const ultimas = db.historico(chatId);
      if (ultimas.length > 0) {
        return msg.reply(`Nenhuma lista aberta agora. A última foi *${ultimas[0].data_jogo}* (${ultimas[0].status}).`);
      }
      return msg.reply('Nenhuma lista criada ainda. Manda *#listaDD/MM* pra abrir uma.');
    }
    const textoLista = db.montarListaFormatada(lista.id, lista.data_jogo);
    return msg.reply(textoLista);
  }

  if (texto.toLowerCase() === CMD_ENCERRAR) {
    const lista = db.getListaAtiva(chatId);
    if (!lista) {
      return msg.reply('Não tem lista aberta pra encerrar.');
    }
    db.encerrarLista(lista.id);
    return msg.reply(`🔒 Lista do dia *${lista.data_jogo}* encerrada. Não aceita mais nomes.`);
  }

  const matchRemover = texto.match(REGEX_REMOVER);
  if (matchRemover) {
    const lista = db.getListaAtiva(chatId);
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

    const textoLista = db.montarListaFormatada(lista.id, lista.data_jogo);
    return msg.reply(textoLista);
  }

  if (TEST_MODE) {
    const matchEncher = texto.match(REGEX_TESTAR_ENCHER);
    if (matchEncher) {
      const lista = db.getListaAtiva(chatId);
      if (!lista) {
        return msg.reply('Nenhuma lista aberta pra testar. Abre uma com *#listaDD/MM* primeiro.');
      }

      const quantidade = parseInt(matchEncher[1], 10);
      const sufixo = Date.now(); // evita colidir com testes anteriores
      let ultimoEvento = null;
      let adicionados = 0;

      for (let i = 1; i <= quantidade; i++) {
        const resultado = db.adicionarEntrada(lista.id, `Teste ${i}`, `fake-${sufixo}-${i}@c.us`);
        if (resultado.erro) break; // lotou de vez, para de tentar
        adicionados++;
        if (resultado.evento) ultimoEvento = resultado.evento;
      }

      await msg.reply(`🧪 ${adicionados} pessoa(s) fake adicionada(s).`);
      if (ultimoEvento === 'lista_cheia') {
        await msg.reply('🚨 Lista encheu! Vamos começar a lista de espera.');
      } else if (ultimoEvento === 'tudo_lotado') {
        await msg.reply('🚨 Tudo lotado! Encerrando as vagas por hoje.');
      }

      const textoLista = db.montarListaFormatada(lista.id, lista.data_jogo);
      return msg.reply(textoLista);
    }

    if (texto.toLowerCase() === CMD_TESTAR_LIMPAR) {
      const lista = db.getListaAtiva(chatId);
      if (!lista) {
        return msg.reply('Nenhuma lista aberta pra limpar.');
      }
      const removidos = db.limparEntradas(lista.id);
      return msg.reply(`🧪 Lista limpa! ${removidos} entrada(s) removida(s). A lista *${lista.data_jogo}* continua aberta, zerada.`);
    }
  }

  if (texto.toLowerCase() === CMD_AJUDA) {
    return msg.reply(TEXTO_AJUDA + (TEST_MODE ? TEXTO_AJUDA_TESTE : ''));
  }
}

module.exports = { processarMensagem };
