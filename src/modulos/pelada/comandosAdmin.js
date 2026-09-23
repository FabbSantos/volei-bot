// Gestão remota da lista semanal, a partir do privado do dono do bot ou do
// grupo de admins: <grupo> = pedaço do nome ou chat_id.
const fs = require('fs');
const { comando } = require('../../nucleo/comandos');
const { paraCentavos, formatarReais } = require('../../nucleo/dinheiro');
const grupos = require('../grupos/repositorio');
const inadimplentes = require('../inadimplentes/repositorio');
const elenco = require('../elenco/repositorio');
const {
  resolverGrupo, separarGrupoENome, expandirPosicoes, grupoEngoliuPosicao, nomeEngoliuValor, anunciarNoGrupo,
} = require('../grupos/remoto');
const { acharFigurinhaCobranca, celebrarPagamentoEm } = require('../figurinhas');
const pelada = require('./repositorio');
const { montarLembretePagamento, montarLembreteSubiu } = require('./textos');

const REGEX_LISTA_DE = /^#listade\s+(.+)$/i;
const REGEX_CANCELAR_LISTA_DE = /^#cancelarlistade\s+(.+)$/i;
const REGEX_ENCERRAR_LISTA_DE = /^#encerrarlistade\s+(.+?)(\s+quieto)?$/i;
// Destranca lista encerrada cedo demais (gente ainda querendo entrar)
const REGEX_REABRIR_LISTA_DE = /^#reabrirlistade\s+(.+?)(\s+quieto)?$/i;
// #editarlistade <grupo> 07/08 [Nome novo] — conserta data/nome da lista atual
const REGEX_EDITAR_LISTA_DE = /^#editarlistade\s+(.+?)\s+(\d{1,2}\/\d{1,2})(?:\s+(.+))?$/i;
// Corrige o nome de alguém que já está na lista (posição continua a mesma)
const REGEX_RENOMEAR_DE = /^#renomearde\s+(.+?)\s+(\d{1,3})\s+(.+?)(\s+quieto)?$/i;
// Coloca convidado na lista à distância (o par do #removerde)
const REGEX_ADICIONAR_DE = /^#adicionarde\s+(.+?)(\s+quieto)?$/i;
// Remove da LISTA semanal à distância (fluxo do "não pagou até 12h, sai
// pro da espera entrar") — aceita lote: 14, 13-16 ou 13,15
const REGEX_REMOVER_DE = /^#removerde\s+(.+?)\s+(\d{1,3}(?:\s*[-,]\s*\d{1,3})*)$/i;
// Cobrança manual, na hora, sem mexer no lembrete diário automático:
// #cobrarde = recado geral (mira = principal sem pagar); #cobrarsubiude =
// só quem subiu da espera (prazo de sexta 17h)
const REGEX_COBRAR_DE = /^#cobrarde\s+(.+)$/i;
const REGEX_COBRAR_SUBIU_DE = /^#cobrarsubiude\s+(.+)$/i;
// #abrirlistade <grupo> DD/MM [valor] [nome] — abre a lista da pelada daqui,
// já anunciando no grupo dela (ex: #abrirlistade riachuelo 07/08 17 Sexta 3h)
const REGEX_ABRIR_LISTA_DE = /^#abrirlistade\s+(.+?)\s+(\d{1,2}\/\d{1,2})(?:\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?))?(?:\s+(.+))?$/i;
// Pelada extra, fora das sextas: mesma sintaxe do #abrirlistade, mas só os
// fixos entram sozinhos — e pagando, porque a mensalidade não cobre ela
const REGEX_ABRIR_EXTRA_DE = /^#abrirextrade\s+(.+?)\s+(\d{1,2}\/\d{1,2})(?:\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?))?(?:\s+(.+))?$/i;
const REGEX_PAGOS_DE = /^#pagosde\s+(.+)$/i;
// Pagamento da lista SEMANAL marcado daqui (equivalente remoto do #pago N)
const REGEX_PAGO_DE = /^#pagode\s+(.+?)\s+(\d{1,3}(?:\s*[-,]\s*\d{1,3})*)$/i;
const REGEX_NAOPAGO_DE = /^#naopagode\s+(.+?)\s+(\d{1,3}(?:\s*[-,]\s*\d{1,3})*)$/i;
const REGEX_VALOR_DE = /^#valorde\s+(.+?)\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?)$/i;
const REGEX_VALOR_LISTA_DE = /^#valorlistade\s+(.+?)\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?)$/i;

const nomeDo = (grupo) => grupo.nome || grupo.chat_id;

// Quem entra pela mão do admin normalmente é convidado — mas se a pessoa
// for admin do grupo (achamos pelo número vinculado no elenco), o anúncio
// ganha o crachá da NASA em vez de virar convidado
async function ehAdminDoGrupoPeloNome(msg, chatId, nome) {
  if (!msg.getAdminsDoGrupo) return false;
  const jogador = elenco.acharJogadorDaEntrada(chatId, { nome, numero: null }, elenco.listarJogadores(chatId));
  if (!jogador || !jogador.numero) return false;
  try {
    const admins = await msg.getAdminsDoGrupo(chatId);
    const usuario = String(jogador.numero).split('@')[0];
    return (admins || []).some((a) => String(a).split('@')[0] === usuario);
  } catch {
    return false;
  }
}

const abrirExtra = comando(REGEX_ABRIR_EXTRA_DE, async (msg, m) => {
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  const dataJogo = m[2];
  const valorCriacao = m[3] ? paraCentavos(m[3]) : null;
  const nomeLista = m[4]?.trim() || 'Pelada Extra';
  const nomeGrupo = nomeDo(r.grupo);

  // Uma lista aberta por grupo: o #lista cai sempre na mais recente. Com a
  // de sexta ainda aberta, metade do grupo entraria na lista errada.
  const aberta = pelada.getListaAtiva(r.grupo.chat_id);
  if (aberta) {
    return msg.reply(
      `A lista de *${aberta.data_jogo}* ainda está aberta em *${nomeGrupo}*. ` +
      `Fecha ela antes (*#encerrarlistade ${m[1]} quieto*) — ` +
      `com duas abertas, o #lista do pessoal cai na mais nova e metade entra na errada.`
    );
  }

  const { ja_existia, lista } = pelada.criarLista(r.grupo.chat_id, dataJogo, nomeLista, valorCriacao, { soFixos: true });
  if (ja_existia) {
    return msg.reply(`Já existe lista pro dia ${dataJogo} em *${nomeGrupo}*. Vê com *#listade*.`);
  }

  const valor = pelada.getLista(lista.id).valor_centavos;
  const anuncio =
    `⚡ *${nomeLista}* dia *${dataJogo}*${valor > 0 ? ` — ${formatarReais(valor)} por pessoa` : ''}!\n\n` +
    `⚠️ Essa é extra: *não entra na mensalidade*. Mensalista que quiser jogar ` +
    `manda *#lista* e paga a pelada, igual todo mundo.\n\n` +
    `${pelada.montarListaFormatada(lista.id, lista.data_jogo)}`;

  let avisoEntrega = '';
  if (msg.enviarPara) {
    try {
      await msg.enviarPara(r.grupo.chat_id, anuncio);
    } catch (err) {
      avisoEntrega = `\n⚠️ Não consegui anunciar no grupo (${err.message}) — avisa lá manualmente.`;
    }
  }
  return msg.reply(
    `⚡ *${nomeLista}* de *${dataJogo}* aberta em *${nomeGrupo}*` +
    `${valor > 0 ? ` — ${formatarReais(valor)}/pessoa` : ''}. ` +
    `Só os fixos entraram sozinhos, e pagam como todo mundo. Anunciada lá no grupo.${avisoEntrega}`
  );
});

const abrirLista = comando(REGEX_ABRIR_LISTA_DE, async (msg, m) => {
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  const dataJogo = m[2];
  const valorCriacao = m[3] ? paraCentavos(m[3]) : null;
  const nomeLista = m[4]?.trim() || null;
  const nomeGrupo = nomeDo(r.grupo);

  const { ja_existia, lista } = pelada.criarLista(r.grupo.chat_id, dataJogo, nomeLista, valorCriacao);
  if (ja_existia) {
    return msg.reply(`Já existe lista pro dia ${dataJogo} em *${nomeGrupo}*. Vê com *#listade*.`);
  }

  // Anuncia direto no grupo da pelada — senão ninguém fica sabendo que abriu
  const anuncio = `✅ Lista ${nomeLista ? `*${nomeLista}* ` : ''}aberta pro dia *${dataJogo}*${
    valorCriacao != null ? ` — ${formatarReais(valorCriacao)} por pessoa` : ''
  }! Manda *#lista* pra entrar.\n\n${pelada.montarListaFormatada(lista.id, lista.data_jogo)}`;
  let avisoEntrega = '';
  if (msg.enviarPara) {
    try {
      await msg.enviarPara(r.grupo.chat_id, anuncio);
    } catch (err) {
      avisoEntrega = `\n⚠️ Não consegui anunciar no grupo (${err.message}) — avisa lá manualmente.`;
    }
  }
  return msg.reply(
    `✅ Lista ${nomeLista ? `*${nomeLista}* ` : ''}de *${dataJogo}* aberta em *${nomeGrupo}*${
      valorCriacao != null ? ` — ${formatarReais(valorCriacao)}/pessoa` : ''
    }, com os mensalistas no topo. Anunciada lá no grupo.${avisoEntrega}`
  );
});

async function cobrar(msg, termo, soPromovidos) {
  const r = resolverGrupo(termo);
  if (r.mensagem) return msg.reply(r.mensagem);
  const lista = pelada.getListaMaisRecente(r.grupo.chat_id);
  if (!lista) {
    return msg.reply(`*${nomeDo(r.grupo)}* ainda não tem lista.`);
  }

  const resumo = pelada.resumoPagamentos(lista.id);
  // Com número junto: quem tiver WhatsApp conhecido é marcado no grupo
  const alvo = soPromovidos ? resumo.promovidosPendentesComZap : resumo.pendentesComZap;
  const nomesAlvo = alvo.map((p) => p.nome);
  if (alvo.length === 0) {
    return msg.reply(soPromovidos
      ? `Ninguém que subiu da espera está devendo em *${nomeDo(r.grupo)}* 🎉`
      : `Todo mundo em dia na lista ${lista.data_jogo} de *${nomeDo(r.grupo)}* 🎉 Nada a cobrar.`);
  }

  try {
    const recado = soPromovidos ? montarLembreteSubiu(alvo) : montarLembretePagamento(alvo);
    await msg.enviarPara(r.grupo.chat_id, recado.texto, { mentionedList: recado.mencoes });
    const figurinha = acharFigurinhaCobranca(nomesAlvo);
    if (msg.enviarFigurinhaPara && figurinha && fs.existsSync(figurinha)) {
      await msg.enviarFigurinhaPara(r.grupo.chat_id, figurinha);
    }
  } catch (err) {
    return msg.reply(`⚠️ Não consegui mandar no grupo (${err.message}).`);
  }
  // Disparo manual não carimba o lembrete_em — o recado diário automático
  // segue o cronograma dele normalmente
  return msg.reply(
    `📣 Cobrança mandada pro grupo (${alvo.length} na mira${soPromovidos ? ', só quem subiu da espera' : ''}). O lembrete diário automático não foi afetado.`
  );
}

const cobrarDe = comando(REGEX_COBRAR_DE, (msg, m) => cobrar(msg, m[1], false));
const cobrarSubiuDe = comando(REGEX_COBRAR_SUBIU_DE, (msg, m) => cobrar(msg, m[1], true));

const renomearDe = comando(REGEX_RENOMEAR_DE, async (msg, m) => {
  const aviso = grupoEngoliuPosicao(m[1], m[2], `#renomearde ${m[1]} ${m[2]} 5 Nome Certo`);
  if (aviso) return msg.reply(aviso);
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  const lista = pelada.getListaMaisRecente(r.grupo.chat_id);
  if (!lista) return msg.reply(`*${nomeDo(r.grupo)}* ainda não tem lista.`);

  const resultado = pelada.renomearEntradaPorPosicao(lista.id, parseInt(m[2], 10), m[3]);
  if (resultado.erro === 'posicao_invalida') {
    return msg.reply(`Não achei ninguém na posição ${m[2]} da lista ${lista.data_jogo}. Confere com *#listade*.`);
  }
  if (resultado.erro) return msg.reply('Falta o nome novo. Ex: *#renomearde riachuelo 5 Nome Certo*');

  // Correção é silenciosa (igual ao #editarlistade): se quiser mostrar a
  // lista corrigida no grupo, é só reenviar com #listade
  await msg.reply(`✏️ Posição ${m[2]}: *${resultado.antes}* → *${resultado.depois}*. Posição e pagamento intactos.`);
  return msg.reply(pelada.montarListaFormatada(lista.id, lista.data_jogo));
});

const adicionarDe = comando(REGEX_ADICIONAR_DE, async (msg, m) => {
  const separado = separarGrupoENome(m[1]);
  if (!separado.nome) return msg.reply('Falta o nome. Ex: *#adicionarde riachuelo Joao Convidado*');
  const r = resolverGrupo(separado.termo);
  if (r.mensagem) return msg.reply(r.mensagem);
  const lista = pelada.getListaMaisRecente(r.grupo.chat_id);
  if (!lista) return msg.reply(`*${nomeDo(r.grupo)}* ainda não tem lista.`);

  const nome = separado.nome;
  const quieto = Boolean(m[2]);
  if (pelada.acharEntradasPorNome(lista.id, nome).length > 0) {
    return msg.reply(`*${nome}* já está na lista de ${lista.data_jogo}.`);
  }
  const devendo = inadimplentes.ehInadimplente(r.grupo.chat_id, null, nome);
  if (devendo) {
    return msg.reply(`⛔ *${nome}* está na lista de inadimplentes. Resolve com *#quitado* no grupo antes de colocar de volta.`);
  }

  // Número sintético: convidado colocado pela mão do admin não tem
  // WhatsApp vinculado (se ele mesmo mandar #lista, aí sim vincula)
  const resultado = pelada.adicionarEntrada(lista.id, nome, `manual-${Date.now()}@bot`);
  if (resultado.erro === 'tudo_lotado') {
    return msg.reply(`Lista de ${lista.data_jogo} lotada (principal + espera). Tira alguém com *#removerde* antes.`);
  }
  const ondeEntrou = resultado.tipo === 'principal'
    ? `na *principal* (posição ${resultado.posicao})`
    : `na *espera* (posição ${resultado.posicao})`;

  const ehAdminEntrando = await ehAdminDoGrupoPeloNome(msg, r.grupo.chat_id, nome);
  const anuncioEntrada = ehAdminEntrando
    ? `🚀 *${nome}* usou o privilégio de ADM da NASA e entrou ${ondeEntrou}.`
    : `✅ *${nome}* entrou ${ondeEntrou} — convidado(a).`;

  if (!quieto) {
    await anunciarNoGrupo(msg, r.grupo.chat_id, anuncioEntrada, pelada.montarListaFormatada(lista.id, lista.data_jogo));
  }
  await msg.reply(`✅ *${nome}* colocado ${ondeEntrou} na lista de ${lista.data_jogo}` + (quieto ? ' — em silêncio.' : ' (anunciado no grupo).'));
  return msg.reply(pelada.montarListaFormatada(lista.id, lista.data_jogo));
});

const removerDe = comando(REGEX_REMOVER_DE, async (msg, m) => {
  const aviso = grupoEngoliuPosicao(m[1], m[2], `#removerde ${m[1]} ${m[2]} 14`);
  if (aviso) return msg.reply(aviso);
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  const lista = pelada.getListaMaisRecente(r.grupo.chat_id);
  if (!lista) {
    return msg.reply(`*${nomeDo(r.grupo)}* ainda não tem lista.`);
  }

  // De baixo pra cima pra remoção não deslocar as posições seguintes
  const posicoes = expandirPosicoes(m[2]).sort((a, b) => b - a);
  const removidos = [];
  const tinhamPago = [];
  const promovidos = [];
  const naoAchadas = [];
  for (const posicao of posicoes) {
    const resultado = pelada.removerPorPosicao(lista.id, posicao);
    if (resultado.erro) naoAchadas.push(posicao);
    else {
      removidos.unshift(resultado.removido);
      if (resultado.removidoTinhaPago) tinhamPago.push(resultado.removido);
      promovidos.push(...(resultado.promovidos || []));
    }
  }
  if (removidos.length === 0) {
    return msg.reply(`Não achei ninguém nessa(s) posição(ões) na lista ${lista.data_jogo}. Confere com *#listade*.`);
  }

  let anuncio = `❌ Saiu(ram) da lista: ${removidos.map((n) => `*${n}*`).join(', ')}.`;
  if (promovidos.length > 0) {
    anuncio += `\n⬆️ Da espera pra principal: ${promovidos.map((n) => `*${n}*`).join(', ')}!`;
  }
  await anunciarNoGrupo(msg, r.grupo.chat_id, anuncio, pelada.montarListaFormatada(lista.id, lista.data_jogo));

  const avisos = [
    naoAchadas.length > 0 ? `⚠️ Posições não encontradas: ${naoAchadas.reverse().join(', ')}.` : '',
    tinhamPago.length > 0 ? `⚠️ Atenção: ${tinhamPago.join(', ')} já tinha(m) pago ✅!` : '',
  ].filter(Boolean).join(' ');
  return msg.reply(
    `❌ ${removidos.length} removido(s) da lista ${lista.data_jogo} (anunciado no grupo).${avisos ? ` ${avisos}` : ''}`
  );
});

const editarListaDe = comando(REGEX_EDITAR_LISTA_DE, async (msg, m) => {
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  const lista = pelada.getListaMaisRecente(r.grupo.chat_id);
  if (!lista) {
    return msg.reply(`*${nomeDo(r.grupo)}* ainda não tem lista.`);
  }
  const resultado = pelada.editarLista(lista.id, {
    dataJogo: m[2],
    nome: m[3]?.trim() || null,
  });
  if (resultado.erro === 'data_ocupada') {
    return msg.reply(`Já existe outra lista de *${m[2]}* nesse grupo. Cancela ela antes ou escolhe outra data.`);
  }
  // Correção é silenciosa no grupo: quem quiser reanuncia com #listade
  return msg.reply(
    `✏️ Lista corrigida: *${resultado.antes.data_jogo}*${resultado.antes.nome ? ` (${resultado.antes.nome})` : ''} → *${resultado.lista.data_jogo}*${resultado.lista.nome ? ` (${resultado.lista.nome})` : ''}. Ninguém saiu da lista.\n\n${pelada.montarListaFormatada(lista.id, resultado.lista.data_jogo)}`
  );
});

const reabrirListaDe = comando(REGEX_REABRIR_LISTA_DE, async (msg, m) => {
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  const lista = pelada.getListaMaisRecente(r.grupo.chat_id);
  if (!lista) return msg.reply(`*${nomeDo(r.grupo)}* ainda não tem lista.`);
  pelada.reabrirLista(lista.id);
  const quieto = Boolean(m[2]);
  if (!quieto) {
    await anunciarNoGrupo(msg, r.grupo.chat_id, `🔓 Lista de *${lista.data_jogo}* reaberta — pode mandar *#lista* de novo.`);
  }
  return msg.reply(`🔓 Lista de *${lista.data_jogo}* de *${nomeDo(r.grupo)}* reaberta` + (quieto ? ' — em silêncio.' : ' (anunciado no grupo).'));
});

const encerrarListaDe = comando(REGEX_ENCERRAR_LISTA_DE, async (msg, m) => {
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  const lista = pelada.getListaAtiva(r.grupo.chat_id);
  if (!lista) {
    return msg.reply(`*${nomeDo(r.grupo)}* não tem lista aberta pra encerrar.`);
  }
  pelada.encerrarLista(lista.id);
  if (!m[2]) {
    await anunciarNoGrupo(
      msg,
      r.grupo.chat_id,
      `🔒 Lista ${lista.nome ? `*${lista.nome}* ` : ''}do dia *${lista.data_jogo}* encerrada — não aceita mais nomes.`
    );
  }
  await msg.reply(`🔒 Lista de *${lista.data_jogo}* de *${nomeDo(r.grupo)}* encerrada${m[2] ? ' — em silêncio, o grupo não foi avisado.' : ' (anunciado no grupo).'} Cobrança, times e #pagode seguem funcionando.`);
  return msg.reply(pelada.montarListaFormatada(lista.id, lista.data_jogo));
});

const cancelarListaDe = comando(REGEX_CANCELAR_LISTA_DE, async (msg, m) => {
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  const resultado = pelada.cancelarLista(r.grupo.chat_id);
  if (resultado.erro === 'sem_lista') {
    return msg.reply(`*${nomeDo(r.grupo)}* não tem lista pra cancelar.`);
  }
  await anunciarNoGrupo(
    msg,
    r.grupo.chat_id,
    `🚫 A lista ${resultado.nome ? `*${resultado.nome}* ` : ''}de *${resultado.data_jogo}* foi cancelada.`
  );
  return msg.reply(
    `🚫 Lista de *${resultado.data_jogo}* de *${nomeDo(r.grupo)}* cancelada e apagada (${resultado.entradas} entrada(s)). A data ficou livre pra recriar.`
  );
});

const listaDe = comando(REGEX_LISTA_DE, async (msg, m) => {
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  // Mostra a última lista mesmo encerrada — é a visão gerencial
  const lista = pelada.getListaMaisRecente(r.grupo.chat_id);
  if (!lista) {
    return msg.reply(`*${nomeDo(r.grupo)}*: nenhuma lista criada ainda.`);
  }
  const marcaEncerrada = lista.status === 'encerrada' ? ' 🔒 (encerrada)' : '';
  return msg.reply(`🏐 *${nomeDo(r.grupo)}*${marcaEncerrada}\n\n${pelada.montarListaFormatada(lista.id, lista.data_jogo)}`);
});

const pagosDe = comando(REGEX_PAGOS_DE, async (msg, m) => {
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  // Última lista mesmo encerrada: a conciliação vem depois do jogo
  const lista = pelada.getListaMaisRecente(r.grupo.chat_id);
  if (!lista) {
    return msg.reply(`*${nomeDo(r.grupo)}*: nenhuma lista criada ainda.`);
  }
  const resumo = pelada.resumoPagamentos(lista.id);
  const marcaEncerrada = lista.status === 'encerrada' ? ' 🔒 encerrada' : '';
  const tituloLista = lista.nome ? `*${lista.nome}* — ${lista.data_jogo}` : `lista ${lista.data_jogo}`;

  let resposta = `💰 *Pagamentos — ${nomeDo(r.grupo)}*\n`;
  resposta += `📋 ${tituloLista}${marcaEncerrada}\n`;
  resposta += `\n✅ ${resumo.emDia}/${resumo.totalCobrados} em dia (espera não deve ainda)`;
  if (resumo.mensalistasNaLista > 0) {
    resposta += `\n🗓 ${resumo.mensalistasNaLista} mensalista(s) — contam pelo mês pago`;
  }
  resposta += `\n`;
  if (resumo.valorCentavos > 0) {
    resposta += `\n💵 Arrecadado na lista: *${formatarReais(resumo.arrecadadoCentavos)}* (${formatarReais(resumo.valorCentavos)}/pessoa)`;
  } else {
    resposta += `\n💵 Lista sem valor definido — define com *#valorlistade <grupo> 25*`;
  }
  resposta += `\n`;
  if (resumo.pendentes.length > 0) {
    resposta += `\n⏳ Faltam: ${resumo.pendentes.join(', ')}`;
  } else if (resumo.totalCobrados > 0) {
    resposta += `\n🎉 Todo mundo em dia!`;
  }
  return msg.reply(resposta);
});

async function marcarPagoDe(msg, m, marcar) {
  const aviso = grupoEngoliuPosicao(m[1], m[2], `#pagode ${m[1]} ${m[2]} 3`);
  if (aviso) return msg.reply(aviso);
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  const lista = pelada.getListaMaisRecente(r.grupo.chat_id);
  if (!lista) {
    return msg.reply(`*${nomeDo(r.grupo)}* ainda não tem lista.`);
  }

  const marcados = [];
  const naoAchadas = [];
  for (const posicao of expandirPosicoes(m[2])) {
    const resultado = pelada.marcarPagoPorPosicao(lista.id, posicao, marcar);
    if (resultado.erro) naoAchadas.push(posicao);
    else marcados.push(resultado);
  }
  if (marcados.length === 0) {
    return msg.reply(`Não achei ninguém nessa(s) posição(ões) na lista ${lista.data_jogo}. Confere com *#listade*.`);
  }

  if (marcar && msg.enviarPara) {
    try {
      await msg.enviarPara(
        r.grupo.chat_id,
        `💰 Pagamento confirmado: ${marcados.map((x) => `*${x.nome}*`).join(', ')} ✅`
      );
      await celebrarPagamentoEm(msg, r.grupo.chat_id);
    } catch (err) {
      await msg.reply(`⚠️ Não consegui anunciar no grupo (${err.message}).`);
    }
  }

  const resumoErros = naoAchadas.length > 0 ? ` ⚠️ Posições não encontradas: ${naoAchadas.join(', ')}.` : '';
  await msg.reply(marcar
    ? `💰 ${marcados.length} pagamento(s) marcados ✅ (anunciado no grupo).${resumoErros}`
    : `↩️ ${marcados.length} pagamento(s) desmarcados.${resumoErros}`);
  return msg.reply(pelada.montarListaFormatada(lista.id, lista.data_jogo));
}

const pagoDe = comando(REGEX_PAGO_DE, (msg, m) => marcarPagoDe(msg, m, true));
const naoPagoDe = comando(REGEX_NAOPAGO_DE, (msg, m) => marcarPagoDe(msg, m, false));

const valorDe = comando(REGEX_VALOR_DE, async (msg, m) => {
  if (nomeEngoliuValor(m[1], m[2])) {
    return msg.reply(`"${m[1]} ${m[2]}" parece ser o nome do grupo — faltou o valor. Ex: *#valorde ${m[1]} ${m[2]} 25*`);
  }
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  const centavos = paraCentavos(m[2]);
  grupos.setarValorPadraoGrupo(r.grupo.chat_id, centavos);
  if (centavos === 0) {
    return msg.reply(`💰 Valor padrão de *${nomeDo(r.grupo)}* removido — próximas listas sem cobrança.`);
  }
  return msg.reply(
    `💰 Valor padrão de *${nomeDo(r.grupo)}*: ${formatarReais(centavos)} por pessoa. Vale pras próximas listas — pra lista aberta agora, usa *#valorlistade*.`
  );
});

const valorListaDe = comando(REGEX_VALOR_LISTA_DE, async (msg, m) => {
  if (nomeEngoliuValor(m[1], m[2])) {
    return msg.reply(`"${m[1]} ${m[2]}" parece ser o nome do grupo — faltou o valor. Ex: *#valorlistade ${m[1]} ${m[2]} 30*`);
  }
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  const lista = pelada.getListaMaisRecente(r.grupo.chat_id);
  if (!lista) {
    return msg.reply(`*${nomeDo(r.grupo)}* ainda não tem lista. Pro padrão das próximas, usa *#valorde*.`);
  }
  const centavos = paraCentavos(m[2]);
  pelada.setarValorLista(lista.id, centavos);
  if (centavos === 0) {
    return msg.reply(`💰 Valor da lista *${lista.data_jogo}* de *${nomeDo(r.grupo)}* removido — sem cobrança.`);
  }
  return msg.reply(`💰 Lista *${lista.data_jogo}* de *${nomeDo(r.grupo)}*: ${formatarReais(centavos)} por pessoa.`);
});

module.exports = {
  comandos: [
    abrirExtra, abrirLista, cobrarDe, cobrarSubiuDe, renomearDe, adicionarDe, removerDe,
    editarListaDe, reabrirListaDe, encerrarListaDe, cancelarListaDe, listaDe, pagosDe,
    pagoDe, naoPagoDe, valorDe, valorListaDe,
  ],
};
