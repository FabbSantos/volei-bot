// Comprovante de Pix mandado no grupo da pelada: o bot lê com o Claude,
// confere e dá o ✅ sozinho — sem ninguém precisar mandar #pago/#pagode.
// Quando algo não bate, pergunta no grupo de admins (#comprovante N ...), e a
// resposta ensina quem paga por quem pra próxima vez.
//
// Liga com ANTHROPIC_API_KEY + PIX_RECEBEDOR (nome de quem recebe o Pix) no
// .env. COMPROVANTES=off desliga sem tirar a chave.
const pelada = require('../pelada/repositorio');
const grupos = require('../grupos/repositorio');
const elenco = require('../elenco/repositorio');
const { celebrarPagamentoEm } = require('../figurinhas');
const { formatarReais } = require('../../nucleo/dinheiro');
const { numeroSintetico } = require('../../nucleo/numeros');
const { lerComprovante, lerivel, temChave } = require('./leitor');
const { decidir, lerDataHora } = require('./decisor');
const repo = require('./repositorio');

const ligado = () => process.env.COMPROVANTES !== 'off' && Boolean(process.env.PIX_RECEBEDOR);

const juntarNomes = (lista) => (lista.length <= 1 ? lista.join('') : `${lista.slice(0, -1).join(', ')} e ${lista.at(-1)}`);
const quandoLegivel = (dataHora) => {
  const d = lerDataHora(dataHora);
  return d ? d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'sem data';
};

async function avisarAdmins(msg, texto) {
  for (const chatId of grupos.listarGruposAdmin()) {
    try {
      await msg.enviarPara(chatId, texto);
    } catch (err) {
      console.warn(`[comprovante] aviso aos admins não saiu: ${err.message}`);
    }
  }
}

// Dá o ✅ (no banco, na hora) e devolve os nomes. O anúncio vem depois, à
// parte: mensagem que falha não pode deixar o pagamento sem registro
function marcar(lista, alvos) {
  for (const alvo of alvos) pelada.aplicarPago(alvo, lista.id, true);
  return alvos.map((a) => a.nome);
}

// Comemora no grupo da pelada como o #pago faz. A figurinha é enfeite: em
// 20/10/2026 o envio de mídia do WhatsApp Web quebrou ("prepRawMedia") e
// derrubava o resto — agora só fica no log
async function anunciarNoGrupo(msg, chatId, lista, nomes, comoFoi) {
  await msg.enviarPara(chatId, `💰 ${juntarNomes(nomes)} ${nomes.length > 1 ? 'pagaram' : 'pagou'}! ✅ ${comoFoi}`);
  try {
    await celebrarPagamentoEm(msg, chatId);
  } catch (err) {
    console.warn(`[comprovante] figurinha não saiu: ${err.message}`);
  }
  await msg.enviarPara(chatId, pelada.montarListaFormatada(lista.id, lista.data_jogo));
}

// A entrada é do próprio remetente? (pelo número, ou pelo jogador do elenco
// que tem o WhatsApp dele — os fixos entram na lista sem número de verdade)
function criarEhDoRemetente(chatId, remetente) {
  let jogadores = null;
  return (entrada) => {
    jogadores = jogadores || elenco.listarJogadores(chatId);
    const j = elenco.acharJogadorDaEntrada(chatId, entrada, jogadores);
    return Boolean(j?.numero) && repo.usuario(j.numero) === repo.usuario(remetente);
  };
}

// Um comprovante por vez: dois ao mesmo tempo poderiam marcar a mesma pessoa
let fila = Promise.resolve();

function receber(msg, grupo, opcoes = {}) {
  const ler = opcoes.ler || lerComprovante;
  if (!msg.midia || !lerivel(msg.midia.mimetype)) return Promise.resolve();
  if (!ligado() || (!opcoes.ler && !temChave())) return Promise.resolve();
  if (!pelada.getListaMaisRecente(msg.chatId)) return Promise.resolve();

  fila = fila.then(() => processar(msg, grupo, ler, opcoes.agora || new Date())).catch(async (err) => {
    console.warn(`[comprovante] falhou: ${err.message}`);
    await avisarAdmins(msg, `⚠️ Não consegui conferir o comprovante que ${msg.pushname || 'alguém'} mandou em *${grupo.nome || msg.chatId}* (${err.message}). Marca na mão.`);
  });
  return fila;
}

async function processar(msg, grupo, ler, agora) {
  // A última lista, mesmo encerrada: pagamento costuma vir depois do jogo
  const lista = pelada.getListaMaisRecente(msg.chatId);
  const entradas = pelada.listarCombinada(lista.id);
  const arquivo = await msg.midia.baixar();
  const leitura = await ler({
    arquivo, mimetype: msg.midia.mimetype, legenda: msg.body || '', nomesDaLista: entradas.map((e) => e.nome),
  });

  const chave = repo.chaveDoComprovante(leitura);
  const decisao = decidir({
    leitura,
    lista,
    entradas,
    remetente: msg.numero,
    recebedorEsperado: process.env.PIX_RECEBEDOR,
    usado: leitura.eh_comprovante_pix ? repo.jaUsado(chave) : null,
    dependentes: repo.dependentesDe(msg.chatId, msg.numero),
    ehDoRemetente: criarEhDoRemetente(msg.chatId, msg.numero),
    valorMes: grupo.valor_mes_centavos || 0,
    agora,
  });
  if (decisao.acao === 'ignorar') return;

  const base = {
    chat_id: msg.chatId, lista_id: lista.id, remetente: msg.numero, remetente_nome: msg.pushname || null, chave,
    valor_centavos: leitura.valor_centavos, data_hora: leitura.data_hora,
    pagador_nome: leitura.pagador_nome, recebedor_nome: leitura.recebedor_nome,
  };
  const resumoPix = `${formatarReais(leitura.valor_centavos || 0)} · Pix de ${leitura.pagador_nome || '?'} · ${quandoLegivel(leitura.data_hora)}`;

  if (decisao.acao === 'marcar') {
    // Banco primeiro (✅ + comprovante usado), mensagens depois
    const marcados = marcar(lista, decisao.alvos);
    const c = repo.registrar({ ...base, status: 'marcado', marcados });
    await avisarAdmins(msg,
      `🤖✅ *${juntarNomes(marcados)}* — lista ${lista.data_jogo} de *${grupo.nome || msg.chatId}*\n` +
      `${resumoPix} · mandado por ${msg.pushname || 'alguém'} (comprovante ${c.id})\n` +
      `Errado? *#naopagode ${(grupo.nome || '').split(' ').pop() || 'grupo'} N* desfaz.`);
    await anunciarNoGrupo(msg, msg.chatId, lista, marcados, '_(comprovante conferido pelo bot)_');
    return;
  }

  const c = repo.registrar({ ...base, status: 'pendente', motivo: decisao.motivo });
  await msg.reply('👀 Recebi o comprovante. Um admin vai conferir e marcar.');
  const sugestao = decisao.candidatos.length ? ` (talvez: ${decisao.candidatos.map((e) => e.nome).join(', ')})` : '';
  await avisarAdmins(msg,
    `❓ *Comprovante ${c.id}* — ${msg.pushname || 'alguém'} mandou em *${grupo.nome || msg.chatId}* (lista ${lista.data_jogo})\n` +
    `${resumoPix}\n` +
    `Não marquei: ${decisao.motivo}${sugestao}.\n\n` +
    `Marca com *#comprovante ${c.id} Nome, Nome* (ou posições: *#comprovante ${c.id} 3 5*), ou *#comprovante ${c.id} ignorar*.`);
}

// Pros comandos de admin: "Duda, Thiago" ou "3 5" → entradas da lista
function acharAlvos(lista, texto) {
  const entradas = pelada.listarCombinada(lista.id);
  const partes = texto.split(/\s*,\s*|\s+e\s+/i).map((p) => p.trim()).filter(Boolean);
  if (partes.every((p) => /^\d+(\s+\d+)*$/.test(p))) {
    const posicoes = partes.join(' ').split(/\s+/).map(Number);
    const alvos = posicoes.map((p) => entradas[p - 1]);
    return alvos.every(Boolean) ? { alvos } : { erro: `não tem ninguém na posição ${posicoes.find((p) => !entradas[p - 1])}` };
  }
  const { normalizarTexto } = require('../../nucleo/texto');
  const alvos = [];
  for (const parte of partes) {
    const alvo = normalizarTexto(parte);
    const exatos = entradas.filter((e) => normalizarTexto(e.nome) === alvo);
    const parecidos = exatos.length ? exatos : entradas.filter((e) => normalizarTexto(e.nome).startsWith(alvo));
    if (parecidos.length !== 1) {
      return { erro: parecidos.length ? `"${parte}" bate com ${parecidos.map((e) => e.nome).join(', ')}` : `não achei "${parte}" na lista` };
    }
    alvos.push(parecidos[0]);
  }
  return { alvos };
}

// O admin resolveu: marca e aprende quem paga por quem (menos o próprio)
async function resolverComprovante(msg, id, texto) {
  const c = repo.getComprovante(id);
  if (!c) return msg.reply(`Não achei o comprovante ${id}.`);
  if (c.status !== 'pendente') return msg.reply(`O comprovante ${id} já foi resolvido (${c.status}).`);
  if (/^ignorar$/i.test(texto.trim())) {
    repo.resolver(id, 'ignorado');
    return msg.reply(`🗑️ Comprovante ${id} ignorado.`);
  }
  const lista = pelada.getLista(c.lista_id);
  if (!lista) return msg.reply('A lista desse comprovante não existe mais.');
  const r = acharAlvos(lista, texto);
  if (r.erro) return msg.reply(`Não marquei: ${r.erro}. Confere com *#listade*.`);
  const jaPagos = r.alvos.filter((e) => e.pago);
  if (jaPagos.length) return msg.reply(`${jaPagos.map((e) => e.nome).join(', ')} já está pago.`);

  const { nomeCasa } = require('./decisor');
  const marcados = marcar(lista, r.alvos);
  repo.resolver(id, 'resolvido', marcados);
  await anunciarNoGrupo(msg, c.chat_id, lista, marcados, '');

  const aprendidos = [];
  for (const alvo of r.alvos) {
    const ehOProprio = (alvo.numero && repo.usuario(alvo.numero) === repo.usuario(c.remetente))
      || (c.remetente_nome && nomeCasa(alvo.nome, c.remetente_nome))
      || (c.pagador_nome && nomeCasa(alvo.nome, c.pagador_nome));
    if (ehOProprio || !c.remetente) continue;
    repo.vincular(c.chat_id, {
      pagadorNumero: c.remetente, pagadorNome: c.remetente_nome,
      dependenteNome: alvo.nome, dependenteNumero: numeroSintetico(alvo.numero) ? null : alvo.numero,
    });
    aprendidos.push(alvo.nome);
  }
  return msg.reply(`✅ Marquei ${juntarNomes(marcados)}.` +
    (aprendidos.length ? ` Aprendi: ${c.remetente_nome || 'quem mandou'} paga por ${juntarNomes(aprendidos)} — da próxima vez marco sozinho.` : ''));
}

module.exports = { receber, resolverComprovante, acharAlvos, ligado };
