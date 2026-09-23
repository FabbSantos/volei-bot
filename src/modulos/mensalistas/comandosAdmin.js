// Gestão remota de mensalistas — mexe no quadro de um grupo sem poluir o
// grupo da pelada com comando; o efeito aparece lá na próxima lista.
const { comando } = require('../../nucleo/comandos');
const { paraCentavos, formatarReais } = require('../../nucleo/dinheiro');
const { resolverGrupo, expandirPosicoes, grupoEngoliuPosicao, nomeEngoliuValor } = require('../grupos/remoto');
const { celebrarPagamentoEm } = require('../figurinhas');
const mensalistas = require('./repositorio');
const { anuncioAberturaMensalistas } = require('./textos');

// "enviar" no fim publica o quadro no grupo da pelada; sem ele, é só consulta
const REGEX_MENSALISTAS_DE = /^#mensalistasde\s+(.+?)(\s+enviar)?$/i;
// Pré-lista de mensalistas: abre/fecha as inscrições do mês e reinício manual
// "quieto" no fim = muda sem anunciar no grupo
const REGEX_ABRIR_MENSALISTAS_DE = /^#abrirmensalistasde\s+(.+?)(\s+quieto)?$/i;
const REGEX_FECHAR_MENSALISTAS_DE = /^#fecharmensalistasde\s+(.+?)(\s+quieto)?$/i;
const REGEX_REINICIAR_MENSALISTAS_DE = /^#reiniciarmensalistasde\s+(.+)$/i;
const REGEX_MENSALISTA_DE = /^#mensalistade\s+(.+?)\s+([^\d\s].*)$/i; // grupo + nome
// Posições aceitam lote: "3", "1-5" ou "1,3,7" — um comando, um anúncio
const REGEX_PAGO_MES_DE = /^#pagomesde\s+(.+?)\s+(\d{1,3}(?:\s*[-,]\s*\d{1,3})*)(?:\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?))?(\s+quieto)?$/i;
const REGEX_NAOPAGO_MES_DE = /^#naopagomesde\s+(.+?)\s+(\d{1,3}(?:\s*[-,]\s*\d{1,3})*)$/i;
const REGEX_FIXO_DE = /^#fixode\s+(.+?)\s+(\d{1,3})$/i;
const REGEX_REMOVER_MENSALISTA_DE = /^#removermensalistade\s+(.+?)\s+(\d{1,3}(?:\s*[-,]\s*\d{1,3})*)$/i;
const REGEX_VALOR_MES_DE = /^#valormesde\s+(.+?)\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?)$/i;
const REGEX_VAGAS_MENSALISTAS_DE = /^#vagasmensalistasde\s+(.+?)\s+(\d{1,3})$/i;

const nomeDo = (grupo) => grupo.nome || grupo.chat_id;

const quadroDe = comando(REGEX_MENSALISTAS_DE, async (msg, m) => {
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  const resumo = mensalistas.resumoMensalistas(r.grupo.chat_id);
  const quadro = mensalistas.montarMensalistasFormatado(r.grupo.chat_id);

  // O grupo recebe o quadro puro. O total arrecadado é só dos admins —
  // mesma regra da lista semanal.
  if (m[2]) {
    if (!msg.enviarPara) return msg.reply('Não consigo falar com o grupo agora (bot desconectado).');
    try {
      await msg.enviarPara(r.grupo.chat_id, quadro);
    } catch (err) {
      return msg.reply(`⚠️ Não consegui publicar em *${nomeDo(r.grupo)}*: ${err.message}`);
    }
    return msg.reply(`📣 Quadro de mensalistas publicado em *${nomeDo(r.grupo)}* (sem o arrecadado).`);
  }

  let resposta = `🏐 *${nomeDo(r.grupo)}*\n\n${quadro}`;
  if (resumo.arrecadadoMesCentavos > 0) {
    resposta += `\n💵 Arrecadado no mês: *${formatarReais(resumo.arrecadadoMesCentavos)}*`;
  }
  resposta += `\n\n_Pra publicar isso no grupo: *#mensalistasde ${m[1]} enviar*_`;
  return msg.reply(resposta);
});

async function abrirOuFechar(msg, m, abrir) {
  const quieto = Boolean(m[2]);
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  const nomeGrupo = nomeDo(r.grupo);
  mensalistas.abrirPreLista(r.grupo.chat_id, abrir);

  const resumo = mensalistas.resumoMensalistas(r.grupo.chat_id);
  const vagas = Math.max(0, resumo.limite - resumo.total);
  const anuncio = abrir
    ? anuncioAberturaMensalistas(vagas)
    : `🔒 *Mensalão encerrado.* Quem garantiu, garantiu — agora é acertar o pagamento com os admins. Quem ficou de fora, mês que vem tem outro.`;
  let aviso = '';
  if (!quieto && msg.enviarPara) {
    try {
      await msg.enviarPara(r.grupo.chat_id, anuncio);
    } catch (err) {
      aviso = `\n⚠️ Não consegui anunciar no grupo (${err.message}).`;
    }
  }
  await msg.reply(
    `🗓 Inscrições de *${nomeGrupo}* ${abrir ? 'abertas' : 'fechadas'}${quieto ? ' — em silêncio, o grupo não foi avisado.' : ' e anunciadas no grupo.'}${aviso}`
  );
  return msg.reply(mensalistas.montarMensalistasFormatado(r.grupo.chat_id));
}

const abrirDe = comando(REGEX_ABRIR_MENSALISTAS_DE, (msg, m) => abrirOuFechar(msg, m, true));
const fecharDe = comando(REGEX_FECHAR_MENSALISTAS_DE, (msg, m) => abrirOuFechar(msg, m, false));

const reiniciarDe = comando(REGEX_REINICIAR_MENSALISTAS_DE, async (msg, m) => {
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  const { removidos } = mensalistas.reiniciarMensalistas(r.grupo.chat_id);
  await msg.reply(
    `♻️ Quadro de mensalistas de *${nomeDo(r.grupo)}* reiniciado: ${removidos} não-fixo(s) removido(s), inscrições fechadas. Fixos mantidos (pendentes até pagar). Abre a rodada nova com *#abrirmensalistasde*.`
  );
  return msg.reply(mensalistas.montarMensalistasFormatado(r.grupo.chat_id));
});

async function marcarMesDe(msg, m, marcar) {
  const aviso = grupoEngoliuPosicao(m[1], m[2], `#pagomesde ${m[1]} ${m[2]} 3`);
  if (aviso) return msg.reply(aviso);
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  const valor = marcar
    ? (m[3] ? paraCentavos(m[3]) : (r.grupo.valor_mes_centavos || 0))
    : 0;

  const marcados = [];
  const naoAchadas = [];
  for (const posicao of expandirPosicoes(m[2])) {
    const resultado = mensalistas.marcarMesPagoPorPosicao(r.grupo.chat_id, posicao, marcar, valor);
    if (resultado.erro) naoAchadas.push(posicao);
    else marcados.push(resultado);
  }
  if (marcados.length === 0) {
    return msg.reply(`Não achei mensalista nessa(s) posição(ões) em *${nomeDo(r.grupo)}*. Confere com *#mensalistasde*.`);
  }

  // Pagamento confirmado é notícia pro grupo — em lote, um anúncio só.
  // Fixo já tem vaga cativa (anúncio é só a quitação); pro não-fixo o ✅
  // é o que confirma a vaga de mensalista.
  // "quieto" no fim marca sem avisar ninguém: serve pra acertar o quadro
  // depois do fato, sem encher o grupo de anúncio atrasado.
  const quietoMes = Boolean(marcar && m[4]);
  if (marcar && !quietoMes && msg.enviarPara) {
    try {
      const nomes = marcados.map((x) => `*${x.nome}*${x.fixo ? ' 📌' : ''}`).join(', ');
      const temNaoFixo = marcados.some((x) => !x.fixo);
      const anuncio = marcados.length === 1
        ? (marcados[0].fixo
          ? `🗓 *${marcados[0].nome}* (fixo 📌) pagou o mês! ✅`
          : `🗓 *${marcados[0].nome}* pagou o mês e tá confirmado(a) como mensalista! ✅ Vaga garantida nas listas a partir de agora.`)
        : `🗓 *Pagaram o mês:* ${nomes} ✅${temNaoFixo ? '\nMensalistas confirmados — vaga garantida nas próximas listas!' : ''}`;
      await msg.enviarPara(r.grupo.chat_id, anuncio);
      await celebrarPagamentoEm(msg, r.grupo.chat_id);
    } catch (err) {
      await msg.reply(`⚠️ Não consegui anunciar no grupo (${err.message}).`);
    }
  }

  const resumoErros = naoAchadas.length > 0 ? ` ⚠️ Posições não encontradas: ${naoAchadas.join(', ')}.` : '';
  const ondeSaiu = quietoMes ? 'em silêncio, o grupo não foi avisado' : 'anunciado no grupo';
  await msg.reply(marcar
    ? (marcados.length === 1
      ? `🗓 ${marcados[0].nome} pagou o mês! ✅ (${ondeSaiu})${resumoErros}`
      : `🗓 ${marcados.length} mensalidades marcadas ✅ (${ondeSaiu}).${resumoErros}`)
    : (marcados.length === 1
      ? `↩️ Mensalidade de ${marcados[0].nome} desmarcada.${resumoErros}`
      : `↩️ ${marcados.length} mensalidades desmarcadas.${resumoErros}`));
  return msg.reply(mensalistas.montarMensalistasFormatado(r.grupo.chat_id));
}

const pagoMesDe = comando(REGEX_PAGO_MES_DE, (msg, m) => marcarMesDe(msg, m, true));
const naoPagoMesDe = comando(REGEX_NAOPAGO_MES_DE, (msg, m) => marcarMesDe(msg, m, false));

const fixoDe = comando(REGEX_FIXO_DE, async (msg, m) => {
  const aviso = grupoEngoliuPosicao(m[1], m[2], `#fixode ${m[1]} ${m[2]} 3`);
  if (aviso) return msg.reply(aviso);
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  const resultado = mensalistas.alternarFixoPorPosicao(r.grupo.chat_id, parseInt(m[2], 10));
  if (resultado.erro) {
    return msg.reply(`Não achei mensalista na posição ${m[2]} de *${nomeDo(r.grupo)}*.`);
  }
  await msg.reply(resultado.fixo
    ? `📌 ${resultado.nome} agora é fixo — vaga cativa.`
    : `${resultado.nome} deixou de ser fixo.`);
  return msg.reply(mensalistas.montarMensalistasFormatado(r.grupo.chat_id));
});

const removerDe = comando(REGEX_REMOVER_MENSALISTA_DE, async (msg, m) => {
  const aviso = grupoEngoliuPosicao(m[1], m[2], `#removermensalistade ${m[1]} ${m[2]} 3`);
  if (aviso) return msg.reply(aviso);
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  // De baixo pra cima: cada remoção desloca as posições seguintes, então
  // processar em ordem decrescente mantém as posições restantes válidas
  const posicoes = expandirPosicoes(m[2]).sort((a, b) => b - a);
  const removidos = [];
  const promovidos = [];
  const naoAchadas = [];
  for (const posicao of posicoes) {
    const resultado = mensalistas.removerMensalistaPorPosicao(r.grupo.chat_id, posicao);
    if (resultado.erro) naoAchadas.push(posicao);
    else {
      removidos.unshift(resultado.nome); // exibe em ordem crescente de posição
      if (resultado.promovido) promovidos.push(resultado.promovido);
    }
  }
  if (removidos.length === 0) {
    return msg.reply(`Não achei mensalista nessa(s) posição(ões) em *${nomeDo(r.grupo)}*.`);
  }

  const resumoErros = naoAchadas.length > 0 ? ` ⚠️ Posições não encontradas: ${naoAchadas.reverse().join(', ')}.` : '';
  await msg.reply(removidos.length === 1
    ? `❌ ${removidos[0]} saiu do quadro de mensalistas.${resumoErros}`
    : `❌ Saíram do quadro: ${removidos.join(', ')}.${resumoErros}`);
  for (const promovido of promovidos) {
    await msg.reply(`⬆️ ${promovido} subiu da espera pra vaga mensal — falta o pagamento pra confirmar.`);
  }
  return msg.reply(mensalistas.montarMensalistasFormatado(r.grupo.chat_id));
});

const cadastrarDe = comando(REGEX_MENSALISTA_DE, async (msg, m) => {
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  const nome = m[2].trim();
  // Dedup por nome: o cadastro remoto não tem o WhatsApp da pessoa
  const jaExiste = mensalistas.listarMensalistas(r.grupo.chat_id)
    .some((x) => x.nome.trim().toLowerCase() === nome.toLowerCase());
  if (jaExiste) {
    return msg.reply(`${nome} já está no quadro de *${nomeDo(r.grupo)}*.`);
  }
  const resultado = mensalistas.adicionarMensalista(r.grupo.chat_id, nome, `manual-${Date.now()}@bot`);
  await msg.reply(resultado.espera
    ? `⏳ Vagas cheias — ${nome} entrou na espera dos mensalistas (posição ${resultado.posicao}).`
    : `🗓 ${nome} entrou no quadro (vaga ${resultado.posicao}/${resultado.limite}). Obs: sem vínculo com o WhatsApp dele — se a pessoa mandar *#mensalista* no grupo, remove este e deixa o dela.`);
  return msg.reply(mensalistas.montarMensalistasFormatado(r.grupo.chat_id));
});

const valorMesDe = comando(REGEX_VALOR_MES_DE, async (msg, m) => {
  if (nomeEngoliuValor(m[1], m[2])) {
    return msg.reply(`"${m[1]} ${m[2]}" parece ser o nome do grupo — faltou o valor. Ex: *#valormesde ${m[1]} ${m[2]} 53*`);
  }
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  const centavos = paraCentavos(m[2]);
  mensalistas.setarValorMes(r.grupo.chat_id, centavos);
  return msg.reply(centavos === 0
    ? `💰 Mensalidade de *${nomeDo(r.grupo)}* removida.`
    : `💰 Mensalidade de *${nomeDo(r.grupo)}*: ${formatarReais(centavos)} (padrão do #pagomesde).`);
});

const vagasDe = comando(REGEX_VAGAS_MENSALISTAS_DE, async (msg, m) => {
  const aviso = grupoEngoliuPosicao(m[1], m[2], `#vagasmensalistasde ${m[1]} ${m[2]} 12`);
  if (aviso) return msg.reply(aviso);
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  const vagas = parseInt(m[2], 10);
  if (vagas < 1) return msg.reply('O número de vagas precisa ser pelo menos 1.');
  mensalistas.setarLimiteMensalistas(r.grupo.chat_id, vagas);
  return msg.reply(`🗓 Vagas de mensalista de *${nomeDo(r.grupo)}*: *${vagas}*.`);
});

module.exports = {
  comandos: [
    quadroDe, abrirDe, fecharDe, reiniciarDe, pagoMesDe, naoPagoMesDe, fixoDe, removerDe,
    cadastrarDe, valorMesDe, vagasDe,
  ],
};
