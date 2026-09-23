// Comandos da lista semanal, digitados dentro do grupo da pelada.
const { comando } = require('../../nucleo/comandos');
const { paraCentavos, formatarReais } = require('../../nucleo/dinheiro');
const grupos = require('../grupos/repositorio');
const { celebrarPagamento } = require('../figurinhas');
const pelada = require('./repositorio');
const { zoeiraSemLista } = require('./textos');

const TEST_MODE = process.env.TEST_MODE === 'true';

// Regex pro comando de abertura: #lista05/07, #lista 05/07, e com valor e/ou
// nome opcionais: "#lista07/08 17 Sexta 3h" (valor precisa vir logo após a
// data; nome é o resto)
const REGEX_ABRIR = /^#lista\s?(\d{1,2}\/\d{1,2})(?:\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?))?(?:\s+(.+))?$/i;
// #lista sozinho, ou #lista Nome Sobrenome (nome explícito opcional)
const REGEX_ENTRAR = /^#lista(?:\s+(.+))?$/i;
// #editarlista 07/08 [Nome] — conserta data/nome da lista mais recente
const REGEX_EDITAR = /^#editarlista\s+(\d{1,2}\/\d{1,2})(?:\s+(.+))?$/i;
// #remover (sozinho ou com o próprio nome) = sair da lista, aberto a todos;
// #remover N / #remover NomeDeOutro = só admins
const REGEX_REMOVER = /^#remover(?:\s+(.+))?$/i;
// Pagamento — restritos a admins DO GRUPO no WhatsApp (+ o admin do bot).
// #pago/#naopago sem número funcionam respondendo a mensagem da pessoa (ex: o comprovante).
const REGEX_PAGO = /^#pago(?:\s+(\d{1,3}))?$/i;
const REGEX_NAOPAGO = /^#naopago(?:\s+(\d{1,3}))?$/i;
const REGEX_VALOR = /^#valor(?:\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?))?$/i;
// [aã]: o corretor do celular escreve "padrão" com acento
const REGEX_VALOR_PADRAO = /^#valorpadr[aã]o\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?)$/i;
// Comandos de teste — só existem com TEST_MODE=true no .env.
// Pensados pra validar o fluxo de lotação/espera sem precisar de 22 pessoas reais.
const REGEX_TESTAR_ENCHER = /^#testarencher\s+(\d+)$/i;

const abrir = comando(REGEX_ABRIR, async (msg, m) => {
  // Abrir lista é coisa de admin — senão qualquer um cria lista fantasma
  if (!(await msg.ehAdmin())) {
    return msg.reply('🔒 Só admin pode abrir lista.');
  }
  const dataJogo = m[1];
  const valorCriacao = m[2] ? paraCentavos(m[2]) : null;
  const nomeLista = m[3]?.trim() || null;
  const { ja_existia } = pelada.criarLista(msg.chatId, dataJogo, nomeLista, valorCriacao);
  if (ja_existia) {
    return msg.reply(`Já existe uma lista pro dia ${dataJogo}. Manda *#mostralista* pra ver.`);
  }
  const notaValor = valorCriacao != null ? ` — ${formatarReais(valorCriacao)} por pessoa` : '';
  return msg.reply(
    `✅ Lista ${nomeLista ? `*${nomeLista}* ` : ''}aberta pro dia *${dataJogo}*${notaValor}! Manda *#lista* pra entrar.`
  );
});

const entrar = comando(REGEX_ENTRAR, async (msg, m) => {
  const nomeExplicito = m[1]?.trim();
  const nome = nomeExplicito || msg.pushname || msg.numero;

  const lista = pelada.getListaAtiva(msg.chatId);
  if (!lista) {
    return msg.reply(zoeiraSemLista(nome));
  }

  const resultado = pelada.adicionarEntrada(lista.id, nome, msg.numero);

  if (resultado.erro === 'ja_esta_na_lista') {
    return msg.reply(`${nome}, você já tá na lista! 😉`);
  }
  if (resultado.erro === 'inadimplente') {
    return msg.reply(`⛔ ${nome}, você está na lista de inadimplentes — acerta com um admin antes de entrar.`);
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
  return msg.reply(pelada.montarListaFormatada(lista.id, lista.data_jogo));
});

const mostrar = comando('#mostralista', async (msg) => {
  const lista = pelada.getListaAtiva(msg.chatId);
  if (!lista) {
    const ultimas = pelada.historico(msg.chatId);
    if (ultimas.length > 0) {
      return msg.reply(`Nenhuma lista aberta agora. A última foi *${ultimas[0].data_jogo}* (${ultimas[0].status}).`);
    }
    return msg.reply('Nenhuma lista criada ainda. Manda *#listaDD/MM* pra abrir uma.');
  }
  return msg.reply(pelada.montarListaFormatada(lista.id, lista.data_jogo));
});

const encerrar = comando('#encerrarlista', async (msg) => {
  if (!(await msg.ehAdmin())) {
    return msg.reply('🔒 Só admin pode encerrar a lista.');
  }
  const lista = pelada.getListaAtiva(msg.chatId);
  if (!lista) {
    return msg.reply('Não tem lista aberta pra encerrar.');
  }
  pelada.encerrarLista(lista.id);
  return msg.reply(`🔒 Lista do dia *${lista.data_jogo}* encerrada. Não aceita mais nomes.`);
});

const editar = comando(REGEX_EDITAR, async (msg, m) => {
  if (!(await msg.ehAdmin())) {
    return msg.reply('🔒 Só admin pode editar a lista.');
  }
  const lista = pelada.getListaMaisRecente(msg.chatId);
  if (!lista) {
    return msg.reply('Não tem lista pra editar.');
  }
  const resultado = pelada.editarLista(lista.id, {
    dataJogo: m[1],
    nome: m[2]?.trim() || null,
  });
  if (resultado.erro === 'data_ocupada') {
    return msg.reply(`Já existe outra lista de *${m[1]}* aqui. Cancela ela antes ou escolhe outra data.`);
  }
  await msg.reply(
    `✏️ Lista corrigida: *${resultado.antes.data_jogo}* → *${resultado.lista.data_jogo}*${resultado.lista.nome ? ` (${resultado.lista.nome})` : ''}. Ninguém saiu da lista.`
  );
  return msg.reply(pelada.montarListaFormatada(lista.id, resultado.lista.data_jogo));
});

const cancelar = comando('#cancelarlista', async (msg) => {
  if (!(await msg.ehAdmin())) {
    return msg.reply('🔒 Só admin pode cancelar a lista.');
  }
  const resultado = pelada.cancelarLista(msg.chatId);
  if (resultado.erro === 'sem_lista') {
    return msg.reply('Não tem lista pra cancelar.');
  }
  return msg.reply(
    `🚫 Lista ${resultado.nome ? `*${resultado.nome}* ` : ''}de *${resultado.data_jogo}* cancelada e apagada (${resultado.entradas} entrada(s)). A data ficou livre pra recriar.`
  );
});

const remover = comando(REGEX_REMOVER, async (msg, m) => {
  const lista = pelada.getListaAtiva(msg.chatId);
  if (!lista) {
    return msg.reply('Nenhuma lista aberta no momento.');
  }

  const argumento = m[1]?.trim();
  let resultado;

  if (!argumento) {
    // #remover sozinho: sai da lista — acha pela pessoa que pediu, então
    // funciona também pra quem entrou com "#lista Nome"
    resultado = pelada.removerPorNumero(lista.id, msg.numero);
    if (resultado.erro === 'nao_esta_na_lista') {
      return msg.reply('Você não está na lista atual.');
    }
  } else if (/^\d+$/.test(argumento)) {
    // #remover N: tirar os outros é coisa de admin
    if (!(await msg.ehAdmin())) {
      return msg.reply('🔒 Só admin pode remover os outros. Pra sair da lista, manda *#remover* sozinho.');
    }
    resultado = pelada.removerPorPosicao(lista.id, parseInt(argumento, 10));
    if (resultado.erro === 'posicao_invalida') {
      return msg.reply(`Não achei ninguém na posição ${argumento}. Confere com *#mostralista*.`);
    }
  } else {
    // #remover Nome: remove se a entrada estiver pendurada no SEU número
    // (você mesmo, ou alguém que você adicionou com "#lista Nome");
    // admin remove qualquer um pelo nome
    const candidatos = pelada.acharEntradasPorNome(lista.id, argumento);
    if (candidatos.length === 0) {
      return msg.reply(`Não achei "${argumento}" na lista. Confere com *#mostralista*.`);
    }
    const usuario = String(msg.numero || '').split('@')[0];
    const meu = candidatos.find((e) => String(e.numero).split('@')[0] === usuario);
    if (meu) {
      resultado = pelada.removerEntrada(lista.id, meu);
    } else if (await msg.ehAdmin()) {
      if (candidatos.length > 1) {
        return msg.reply(`Tem ${candidatos.length} pessoas chamadas "${argumento}" — usa *#remover N* pela posição.`);
      }
      resultado = pelada.removerEntrada(lista.id, candidatos[0]);
    } else {
      return msg.reply(`🔒 "${argumento}" não foi adicionado(a) pelo seu número — só admin pode remover os outros.`);
    }
  }

  const avisoPago = resultado.removidoTinhaPago
    ? ' ⚠️ Atenção: essa pessoa já tinha pago ✅!'
    : '';
  await msg.reply(`❌ ${resultado.removido} saiu da lista.${avisoPago}`);
  for (const promovido of resultado.promovidos || []) {
    await msg.reply(`⬆️ ${promovido} subiu da espera pra lista principal!`);
  }

  return msg.reply(pelada.montarListaFormatada(lista.id, lista.data_jogo));
});

async function marcarPagamento(msg, marcar, posicaoTexto) {
  if (!(await msg.ehAdmin())) {
    return msg.reply('🔒 Só admin do grupo pode marcar pagamento.');
  }

  // Última lista mesmo se encerrada: a cobrança costuma vir depois do jogo,
  // e #encerrarlista trava só a entrada de nomes, não o dinheiro
  const lista = pelada.getListaMaisRecente(msg.chatId);
  if (!lista) {
    return msg.reply('Nenhuma lista criada ainda.');
  }

  let resultado;
  if (posicaoTexto) {
    resultado = pelada.marcarPagoPorPosicao(lista.id, parseInt(posicaoTexto, 10), marcar);
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
    resultado = pelada.marcarPagoPorNumero(lista.id, citado, marcar);
    if (resultado.erro) {
      return msg.reply('Quem mandou essa mensagem não está na lista atual.');
    }
  }

  await msg.reply(marcar ? `💰 ${resultado.nome} pagou! ✅` : `↩️ Pagamento de ${resultado.nome} desmarcado.`);
  if (marcar) await celebrarPagamento(msg);
  return msg.reply(pelada.montarListaFormatada(lista.id, lista.data_jogo));
}

const pago = comando(REGEX_PAGO, (msg, m) => marcarPagamento(msg, true, m[1]));
const naoPago = comando(REGEX_NAOPAGO, (msg, m) => marcarPagamento(msg, false, m[1]));

const valorPadrao = comando(REGEX_VALOR_PADRAO, async (msg, m) => {
  if (!(await msg.ehAdmin())) {
    return msg.reply('🔒 Só admin do grupo pode definir o valor.');
  }
  const centavos = paraCentavos(m[1]);
  grupos.setarValorPadraoGrupo(msg.chatId, centavos);
  // 0 significa "sem valor" no sistema todo — confirma como remoção,
  // não como "R$ 0,00 por pessoa"
  if (centavos === 0) {
    return msg.reply('💰 Valor padrão removido — próximas listas nascem sem cobrança.');
  }
  return msg.reply(
    `💰 Valor padrão do grupo: *${formatarReais(centavos)}* por pessoa. Vale pras próximas listas — pra mudar a lista atual, usa *#valor ${m[1]}*.`
  );
});

const valor = comando(REGEX_VALOR, async (msg, m) => {
  const lista = pelada.getListaMaisRecente(msg.chatId);

  // #valor sem número é consulta — aberto a todo mundo
  if (!m[1]) {
    if (!lista) return msg.reply('Nenhuma lista criada ainda.');
    const valorAtual = pelada.getLista(lista.id).valor_centavos;
    return msg.reply(
      valorAtual > 0
        ? `💰 Valor por pessoa desta lista: *${formatarReais(valorAtual)}*`
        : 'Essa lista não tem valor definido. Um admin do grupo define com *#valor 25*.'
    );
  }

  if (!(await msg.ehAdmin())) {
    return msg.reply('🔒 Só admin do grupo pode definir o valor.');
  }
  if (!lista) {
    return msg.reply('Nenhuma lista criada ainda. O valor é por lista — abre uma com *#listaDD/MM*, ou define o padrão do grupo com *#valorpadrao 25*.');
  }
  const centavos = paraCentavos(m[1]);
  pelada.setarValorLista(lista.id, centavos);
  if (centavos === 0) {
    return msg.reply('💰 Valor removido — lista sem cobrança.');
  }
  return msg.reply(`💰 Valor desta lista: *${formatarReais(centavos)}* por pessoa.`);
});

// ---- modo de teste
// Gate de admin: TEST_MODE é global do bot, e #testarlimpar apaga
// entradas com pagamento marcado — não pode ficar aberto ao grupo

const testarEncher = comando(REGEX_TESTAR_ENCHER, async (msg, m) => {
  if (!(await msg.ehAdmin())) {
    return msg.reply('🔒 Só admin do grupo pode usar comandos de teste.');
  }
  const lista = pelada.getListaAtiva(msg.chatId);
  if (!lista) {
    return msg.reply('Nenhuma lista aberta pra testar. Abre uma com *#listaDD/MM* primeiro.');
  }

  const quantidade = parseInt(m[1], 10);
  const sufixo = Date.now(); // evita colidir com testes anteriores
  let ultimoEvento = null;
  let adicionados = 0;

  for (let i = 1; i <= quantidade; i++) {
    const resultado = pelada.adicionarEntrada(lista.id, `Teste ${i}`, `fake-${sufixo}-${i}@c.us`);
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

  return msg.reply(pelada.montarListaFormatada(lista.id, lista.data_jogo));
});

const testarLimpar = comando('#testarlimpar', async (msg) => {
  if (!(await msg.ehAdmin())) {
    return msg.reply('🔒 Só admin do grupo pode usar comandos de teste.');
  }
  const lista = pelada.getListaAtiva(msg.chatId);
  if (!lista) {
    return msg.reply('Nenhuma lista aberta pra limpar.');
  }
  const removidos = pelada.limparEntradas(lista.id);
  return msg.reply(`🧪 Lista limpa! ${removidos} entrada(s) removida(s). A lista *${lista.data_jogo}* continua aberta, zerada.`);
});

// Ordem importa: #lista05/07 também casaria com o "#lista Nome" do entrar
const comandos = [abrir, entrar, mostrar, encerrar, editar, cancelar, remover, pago, naoPago, valorPadrao, valor];
const comandosDeTeste = TEST_MODE ? [testarEncher, testarLimpar] : [];

module.exports = { comandos, comandosDeTeste, TEST_MODE };
