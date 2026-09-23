// Comandos de mensalista digitados dentro do grupo da pelada.
const { comando } = require('../../nucleo/comandos');
const { paraCentavos, formatarReais } = require('../../nucleo/dinheiro');
const grupos = require('../grupos/repositorio');
const inadimplentes = require('../inadimplentes/repositorio');
const { celebrarPagamento } = require('../figurinhas');
const mensalistas = require('./repositorio');
const { zoeiraEntrouNoMensalao, zoeiraEsperaMensalista } = require('./textos');

const REGEX_MENSALISTA = /^#mensalista(?:\s+(.+))?$/i;
const REGEX_PAGO_MES = /^#pagomes\s+(\d{1,3})(?:\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?))?$/i;
const REGEX_NAOPAGO_MES = /^#naopagomes\s+(\d{1,3})$/i;
const REGEX_FIXO = /^#fixo\s+(\d{1,3})$/i;
const REGEX_REMOVER_MENSALISTA = /^#removermensalista\s+(\d{1,3})$/i;
const REGEX_VALOR_MES = /^#valormes\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?)$/i;
const REGEX_VAGAS_MENSALISTAS = /^#vagasmensalistas\s+(\d{1,3})$/i;

const quadro = comando('#mensalistas', (msg) => msg.reply(mensalistas.montarMensalistasFormatado(msg.chatId)));

const entrar = comando(REGEX_MENSALISTA, async (msg, m, { grupo }) => {
  const nome = m[1]?.trim() || msg.pushname || msg.numero;
  // Inscrição só com a pré-lista aberta (os admins abrem no 1º dia útil)
  if (!grupo.pre_lista_aberta) {
    return msg.reply('🗓 As inscrições de mensalista estão fechadas no momento. Os admins abrem no começo do mês — fica ligado no grupo!');
  }
  if (inadimplentes.ehInadimplente(msg.chatId, msg.numero, nome)) {
    return msg.reply(`⛔ ${nome}, você está na lista de inadimplentes — acerta com um admin antes.`);
  }
  const resultado = mensalistas.adicionarMensalista(msg.chatId, nome, msg.numero);
  if (resultado.erro === 'ja_e_mensalista') {
    return msg.reply(`${nome}, você já está no quadro de mensalistas! 😉`);
  }
  if (resultado.espera) {
    await msg.reply(zoeiraEsperaMensalista(nome, resultado.posicao));
  } else {
    await msg.reply(zoeiraEntrouNoMensalao(nome, resultado.posicao, resultado.limite));
  }
  return msg.reply(mensalistas.montarMensalistasFormatado(msg.chatId));
});

async function marcarMes(msg, marcar, posicaoTexto, valorTexto) {
  if (!(await msg.ehAdmin())) {
    return msg.reply('🔒 Só admin do grupo pode marcar mensalidade.');
  }
  const posicao = parseInt(posicaoTexto, 10);
  const grupo = grupos.getGrupo(msg.chatId);
  // Valor explícito > mensalidade padrão do grupo — vira o snapshot do mês
  const valor = marcar
    ? (valorTexto ? paraCentavos(valorTexto) : (grupo?.valor_mes_centavos || 0))
    : 0;
  const resultado = mensalistas.marcarMesPagoPorPosicao(msg.chatId, posicao, marcar, valor);
  if (resultado.erro) {
    return msg.reply(`Não achei mensalista na posição ${posicao}. Confere com *#mensalistas*.`);
  }
  await msg.reply(marcar ? `🗓 ${resultado.nome} pagou o mês! ✅` : `↩️ Mensalidade de ${resultado.nome} desmarcada.`);
  if (marcar) await celebrarPagamento(msg);
  return msg.reply(mensalistas.montarMensalistasFormatado(msg.chatId));
}

const pagoMes = comando(REGEX_PAGO_MES, (msg, m) => marcarMes(msg, true, m[1], m[2]));
const naoPagoMes = comando(REGEX_NAOPAGO_MES, (msg, m) => marcarMes(msg, false, m[1]));

const fixo = comando(REGEX_FIXO, async (msg, m) => {
  if (!(await msg.ehAdmin())) {
    return msg.reply('🔒 Só admin do grupo pode definir fixos.');
  }
  const resultado = mensalistas.alternarFixoPorPosicao(msg.chatId, parseInt(m[1], 10));
  if (resultado.erro) {
    return msg.reply(`Não achei mensalista na posição ${m[1]}. Confere com *#mensalistas*.`);
  }
  await msg.reply(resultado.fixo
    ? `📌 ${resultado.nome} agora é fixo — vaga cativa de mensalista.`
    : `${resultado.nome} deixou de ser fixo.`);
  return msg.reply(mensalistas.montarMensalistasFormatado(msg.chatId));
});

const remover = comando(REGEX_REMOVER_MENSALISTA, async (msg, m) => {
  if (!(await msg.ehAdmin())) {
    return msg.reply('🔒 Só admin do grupo pode remover mensalista.');
  }
  const resultado = mensalistas.removerMensalistaPorPosicao(msg.chatId, parseInt(m[1], 10));
  if (resultado.erro) {
    return msg.reply(`Não achei mensalista na posição ${m[1]}. Confere com *#mensalistas*.`);
  }
  await msg.reply(`❌ ${resultado.nome} saiu do quadro de mensalistas.`);
  if (resultado.promovido) {
    await msg.reply(`⬆️ ${resultado.promovido} subiu da espera pra vaga mensal — falta o pagamento pra confirmar.`);
  }
  return msg.reply(mensalistas.montarMensalistasFormatado(msg.chatId));
});

const valorMes = comando(REGEX_VALOR_MES, async (msg, m) => {
  if (!(await msg.ehAdmin())) {
    return msg.reply('🔒 Só admin do grupo pode definir a mensalidade.');
  }
  const centavos = paraCentavos(m[1]);
  mensalistas.setarValorMes(msg.chatId, centavos);
  return msg.reply(centavos === 0
    ? '💰 Mensalidade removida.'
    : `💰 Mensalidade do grupo: *${formatarReais(centavos)}* (usada como padrão no #pagomes).`);
});

const vagas = comando(REGEX_VAGAS_MENSALISTAS, async (msg, m) => {
  if (!(await msg.ehAdmin())) {
    return msg.reply('🔒 Só admin do grupo pode mudar as vagas.');
  }
  const total = parseInt(m[1], 10);
  if (total < 1) {
    return msg.reply('O número de vagas precisa ser pelo menos 1.');
  }
  mensalistas.setarLimiteMensalistas(msg.chatId, total);
  return msg.reply(`🗓 Vagas de mensalista: *${total}*.`);
});

module.exports = { comandos: [quadro, entrar, pagoMes, naoPagoMes, fixo, remover, valorMes, vagas] };
