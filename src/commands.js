const db = require('./db');

// Regex pro comando de abertura: #lista05/07, #lista5/7, #lista 05/07 etc.
const REGEX_ABRIR = /^#lista\s?(\d{1,2}\/\d{1,2})$/i;
// #lista sozinho, ou #lista Nome Sobrenome (nome explícito opcional)
const REGEX_ENTRAR = /^#lista(?:\s+(.+))?$/i;
const CMD_MOSTRAR = '#mostralista';
const CMD_ENCERRAR = '#encerrarlista';
const CMD_AJUDA = '#comandos';
const REGEX_REMOVER = /^#remover\s+(\d+)$/i;
// Pagamento — restritos a admins DO GRUPO no WhatsApp (+ o admin do bot).
// #pago/#naopago sem número funcionam respondendo a mensagem da pessoa (ex: o comprovante).
const REGEX_PAGO = /^#pago(?:\s+(\d{1,3}))?$/i;
const REGEX_NAOPAGO = /^#naopago(?:\s+(\d{1,3}))?$/i;
const REGEX_VALOR = /^#valor(?:\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?))?$/i;
// [aã]: o corretor do celular escreve "padrão" com acento
const REGEX_VALOR_PADRAO = /^#valorpadr[aã]o\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?)$/i;
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
*#valor* — mostra o valor por pessoa da lista atual
*#comandos* — mostra essa ajuda

💰 *Só pra admins do grupo:*
*#pago N* — marca ✅ de quem está na posição N (ou responde o comprovante com *#pago*)
*#naopago N* — desmarca (ou respondendo a mensagem com *#naopago*)
*#valor 25* — define o valor por pessoa da lista atual (aceita 25,50)
*#valorpadrao 25* — valor padrão pras próximas listas do grupo`;

const TEXTO_AJUDA_TESTE = `\n\n🧪 *Comandos de teste (TEST_MODE ligado)*
*#testarencher N* — adiciona N pessoas fake na lista (ex: #testarencher 15)
*#testarlimpar* — apaga todo mundo da lista ativa, sem precisar recriar`;

function correspondeAlgumComando(texto) {
  const textoLower = texto.toLowerCase();
  const comandoNormal = (
    REGEX_ABRIR.test(texto) ||
    REGEX_ENTRAR.test(texto) ||
    REGEX_REMOVER.test(texto) ||
    REGEX_PAGO.test(texto) ||
    REGEX_NAOPAGO.test(texto) ||
    REGEX_VALOR.test(texto) ||
    REGEX_VALOR_PADRAO.test(texto) ||
    textoLower === CMD_MOSTRAR ||
    textoLower === CMD_ENCERRAR ||
    textoLower === CMD_AJUDA
  );
  const comandoTeste = TEST_MODE && (
    REGEX_TESTAR_ENCHER.test(texto) || textoLower === CMD_TESTAR_LIMPAR
  );
  return comandoNormal || comandoTeste;
}

// msg = { body, pushname, chatId, numero, nomeGrupo, reply(texto),
//         ehAdmin(): Promise<bool>  — remetente é admin do grupo no WhatsApp (ou o admin do bot),
//         remetenteCitado(): Promise<numero|null> — quem enviou a mensagem respondida, se houver }
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

    // Se a lista cresceu, quem estava na espera subiu antes desse novato entrar
    for (const promovido of resultado.promovidos || []) {
      await msg.reply(`⬆️ ${promovido} subiu da espera pra lista principal!`);
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

    const avisoPago = resultado.removidoTinhaPago
      ? ' ⚠️ Atenção: essa pessoa já tinha pago ✅!'
      : '';
    await msg.reply(`❌ ${resultado.removido} removido(a) da posição ${posicao}.${avisoPago}`);
    for (const promovido of resultado.promovidos || []) {
      await msg.reply(`⬆️ ${promovido} subiu da espera pra lista principal!`);
    }

    const textoLista = db.montarListaFormatada(lista.id, lista.data_jogo);
    return msg.reply(textoLista);
  }

  const matchPago = texto.match(REGEX_PAGO);
  const matchNaoPago = matchPago ? null : texto.match(REGEX_NAOPAGO);
  if (matchPago || matchNaoPago) {
    const marcar = Boolean(matchPago);
    const posicaoTexto = (matchPago || matchNaoPago)[1];

    if (!(await msg.ehAdmin())) {
      return msg.reply('🔒 Só admin do grupo pode marcar pagamento.');
    }

    // Última lista mesmo se encerrada: a cobrança costuma vir depois do jogo,
    // e #encerrarlista trava só a entrada de nomes, não o dinheiro
    const lista = db.getListaMaisRecente(chatId);
    if (!lista) {
      return msg.reply('Nenhuma lista criada ainda.');
    }

    let resultado;
    if (posicaoTexto) {
      resultado = db.marcarPagoPorPosicao(lista.id, parseInt(posicaoTexto, 10), marcar);
      if (resultado.erro) {
        return msg.reply(`Não achei ninguém na posição ${posicaoTexto}. Confere com *#mostralista*.`);
      }
    } else {
      const citado = await msg.remetenteCitado();
      if (!citado) {
        return msg.reply(
          marcar
            ? 'Usa *#pago N* (posição da lista) ou responde a mensagem do comprovante com *#pago*.'
            : 'Usa *#naopago N* (posição da lista) ou responde a mensagem da pessoa com *#naopago*.'
        );
      }
      resultado = db.marcarPagoPorNumero(lista.id, citado, marcar);
      if (resultado.erro) {
        return msg.reply('Quem mandou essa mensagem não está na lista atual.');
      }
    }

    await msg.reply(marcar ? `💰 ${resultado.nome} pagou! ✅` : `↩️ Pagamento de ${resultado.nome} desmarcado.`);
    return msg.reply(db.montarListaFormatada(lista.id, lista.data_jogo));
  }

  const matchValorPadrao = texto.match(REGEX_VALOR_PADRAO);
  if (matchValorPadrao) {
    if (!(await msg.ehAdmin())) {
      return msg.reply('🔒 Só admin do grupo pode definir o valor.');
    }
    const centavos = db.paraCentavos(matchValorPadrao[1]);
    db.setarValorPadraoGrupo(chatId, centavos);
    // 0 significa "sem valor" no sistema todo — confirma como remoção,
    // não como "R$ 0,00 por pessoa"
    if (centavos === 0) {
      return msg.reply('💰 Valor padrão removido — próximas listas nascem sem cobrança.');
    }
    return msg.reply(
      `💰 Valor padrão do grupo: *${db.formatarReais(centavos)}* por pessoa. Vale pras próximas listas — pra mudar a lista atual, usa *#valor ${matchValorPadrao[1]}*.`
    );
  }

  const matchValor = texto.match(REGEX_VALOR);
  if (matchValor) {
    const lista = db.getListaMaisRecente(chatId);

    // #valor sem número é consulta — aberto a todo mundo
    if (!matchValor[1]) {
      if (!lista) return msg.reply('Nenhuma lista criada ainda.');
      const valor = db.getLista(lista.id).valor_centavos;
      return msg.reply(
        valor > 0
          ? `💰 Valor por pessoa desta lista: *${db.formatarReais(valor)}*`
          : 'Essa lista não tem valor definido. Um admin do grupo define com *#valor 25*.'
      );
    }

    if (!(await msg.ehAdmin())) {
      return msg.reply('🔒 Só admin do grupo pode definir o valor.');
    }
    if (!lista) {
      return msg.reply('Nenhuma lista criada ainda. O valor é por lista — abre uma com *#listaDD/MM*, ou define o padrão do grupo com *#valorpadrao 25*.');
    }
    const centavos = db.paraCentavos(matchValor[1]);
    db.setarValorLista(lista.id, centavos);
    if (centavos === 0) {
      return msg.reply('💰 Valor removido — lista sem cobrança.');
    }
    return msg.reply(`💰 Valor desta lista: *${db.formatarReais(centavos)}* por pessoa.`);
  }

  if (TEST_MODE) {
    // Gate de admin: TEST_MODE é global do bot, e #testarlimpar apaga
    // entradas com pagamento marcado — não pode ficar aberto ao grupo
    const ehComandoTeste = REGEX_TESTAR_ENCHER.test(texto) || texto.toLowerCase() === CMD_TESTAR_LIMPAR;
    if (ehComandoTeste && !(await msg.ehAdmin())) {
      return msg.reply('🔒 Só admin do grupo pode usar comandos de teste.');
    }

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

  // Variação malformada de comando conhecido (ex: "#pago 3 4", "#valor25",
  // "#pago João") não pode morrer em silêncio — o admin acharia que funcionou
  if (/^#(pago|naopago|valor|valorpadr[aã]o|remover|mostralista|encerrarlista|lista|comandos|testarencher|testarlimpar)\b/i.test(texto)) {
    return msg.reply('Não entendi o formato 🤔 Manda *#comandos* pra ver como usar cada um.');
  }
}

module.exports = { processarMensagem };
