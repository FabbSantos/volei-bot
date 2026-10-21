// Comprovante de Pix enviado no grupo da pelada: o bot lê com o Claude,
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
const { lerComprovante, entenderResposta, escreverFrase, lerivel, temChave } = require('./leitor');
const { fraseDePagamento } = require('./frases');
const nomes = require('./nomes');
const { decidir, lerDataHora, nomeCasa, tokens, falaDoRemetente } = require('./decisor');
const { comMencoes } = require('../pelada/textos');
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
  const quem = juntarNomes(nomes);
  const frase = await fraseDePagamento(quem, { escrever: temChave() ? escreverFrase : null });
  await msg.enviarPara(chatId, `💰 ${quem} ${nomes.length > 1 ? 'pagaram' : 'pagou'}! ✅ ${comoFoi}`.trim() + `\n${frase}`);
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
    await avisarAdmins(msg, `⚠️ Não consegui conferir o comprovante que ${msg.pushname || 'alguém'} enviou em *${grupo.nome || msg.chatId}* (${err.message}). Marca na mão.`);
  });
  return fila;
}

async function processar(msg, grupo, ler, agora) {
  // A última lista, mesmo encerrada: pagamento costuma vir depois do jogo
  const lista = pelada.getListaMaisRecente(msg.chatId);
  const entradas = pelada.listarCombinada(lista.id);
  const arquivo = await msg.midia.baixar();
  // A lista vai com os outros nomes de cada um ("Fontella ✠ (também chamado:
  // Letícia Fontella)"): a legenda "da Letícia" tem que achar a Fontella
  const apelidos = nomes.apelidosDasEntradas(msg.chatId, entradas);
  const leitura = await ler({
    arquivo, mimetype: msg.midia.mimetype, legenda: msg.body || '', nomesDaLista: nomes.nomesParaOClaude(entradas, apelidos),
  });
  // O que o Claude citou volta pro nome da lista (ou some, se não existe)
  leitura.legenda_para = (leitura.legenda_para || [])
    .map((n) => nomes.entradaPeloNome(n, entradas, apelidos)?.nome)
    .filter(Boolean);

  // "é meu" na legenda não depende do humor do modelo: a regra fixa completa
  // (só liga, nunca desliga o que o Claude achou)
  const legenda = msg.body || '';
  const citaNomeDaLista = leitura.legenda_para.length > 0
    || tokens(legenda).some((p) => entradas.some((e) => tokens(e.nome)[0] === p));
  if (legenda && falaDoRemetente(legenda, citaNomeDaLista)) leitura.legenda_inclui_remetente = true;

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
      `${resumoPix} · enviado por ${msg.pushname || 'alguém'} (comprovante ${c.id})\n` +
      `Errado? *#naopagode ${(grupo.nome || '').split(' ').pop() || 'grupo'} N* desfaz.`);
    await anunciarNoGrupo(msg, msg.chatId, lista, marcados, '_(comprovante conferido pelo bot)_');
    return;
  }

  const c = repo.registrar({ ...base, status: 'pendente', motivo: decisao.motivo });

  // Dúvida só de pra quem é: pergunta pra quem enviou, no grupo, marcando
  if (decisao.tipo === 'para_quem' && msg.numero && !numeroSintetico(msg.numero)) {
    await perguntarNoGrupo(msg, grupo, c, lista, decisao, leitura, resumoPix);
    return;
  }

  await msg.reply('👀 Recebi o comprovante. Um admin vai conferir e marcar.');
  const sugestao = decisao.candidatos.length ? ` (talvez: ${decisao.candidatos.map((e) => e.nome).join(', ')})` : '';
  await avisarAdmins(msg,
    `❓ *Comprovante ${c.id}* — ${msg.pushname || 'alguém'} enviou em *${grupo.nome || msg.chatId}* (lista ${lista.data_jogo})\n` +
    `${resumoPix}\n` +
    `Não marquei: ${decisao.motivo}${sugestao}.\n\n` +
    `Marca com *#comprovante ${c.id} Nome, Nome* (ou posições: *#comprovante ${c.id} 3 5*), ou *#comprovante ${c.id} ignorar*.`);
}

// "É teu ou é pra Duda?" — no grupo, com @ em quem enviou
async function perguntarNoGrupo(msg, grupo, c, lista, decisao, leitura, resumoPix) {
  const { texto: mencao, mencoes } = comMencoes([{ nome: msg.pushname || 'você', numero: msg.numero }]);
  const proprios = new Set(decisao.doRemetente);
  const outros = decisao.candidatos.filter((e) => !proprios.has(e.id)).map((e) => e.nome);
  const valor = formatarReais(leitura.valor_centavos);
  let duvida;
  if (decisao.candidatos.length > decisao.pessoas) {
    duvida = proprios.size
      ? `É teu${outros.length ? ` ou é pra ${outros.join(' ou ')}` : ''}?`
      : `É pra ${decisao.candidatos.map((e) => e.nome).join(' ou ')}?`;
  } else if (decisao.candidatos.length) {
    duvida = `Ele dá pra ${decisao.pessoas} pessoas — quem mais, além de ${juntarNomes(decisao.candidatos.map((e) => e.nome))}?`;
  } else {
    duvida = 'Pra quem é?';
  }
  const comoResponder = decisao.pessoas > 1 ? 'os nomes' : '*meu* ou o nome da pessoa';
  const enviada = await msg.enviarPara(msg.chatId,
    `🤔 ${mencao}, recebi teu Pix de ${valor}. ${duvida}\nResponde aqui com ${comoResponder}.`,
    { mentionedList: mencoes });
  repo.registrarPergunta(c.id, {
    msgId: enviada?.id || null, pessoas: decisao.pessoas,
    candidatos: decisao.candidatos.map((e) => e.id), doRemetente: decisao.doRemetente,
  });
  await avisarAdmins(msg,
    `❓ *Comprovante ${c.id}* — ${resumoPix} (lista ${lista.data_jogo} de *${grupo.nome || msg.chatId}*)\n` +
    `Perguntei pro ${msg.pushname || 'remetente'} no grupo pra quem é. Se ele não responder: *#comprovante ${c.id} Nome*.`);
}

// Quem enviou o Pix tem 12h pra responder a pergunta do bot
const PRAZO_RESPOSTA_MS = 12 * 60 * 60 * 1000;
// "meu", "da Duda", "os dois". Mensagem longa sem citar a pergunta é conversa,
// não resposta ("a Duda vai atrasar hoje, galera" não vira pagamento da Duda)
const MAX_PALAVRAS_SEM_CITAR = 5;
const PALAVRAS_TODOS = ['dois', 'duas', 'ambos', 'ambas', 'todos', 'tres'];

// Resposta → entradas da lista, ou null se não deu pra entender. Os nomes
// valem pelo da lista, pelo do elenco e pelos apelidos ("Diego" → DiegoB)
function interpretarResposta(texto, pendentes, candidatosIds, remetenteIds, apelidos = new Map()) {
  const palavras = tokens(texto);
  const { nomeados, ambiguo } = nomes.nomeadosNoTexto(texto, pendentes, apelidos, candidatosIds);
  if (ambiguo) return null; // dois "Diego" devendo: não chuta
  const ehDoRemetente = falaDoRemetente(texto, nomeados.length > 0);

  const alvos = [
    ...(ehDoRemetente ? pendentes.filter((e) => remetenteIds.includes(e.id)) : []),
    ...(palavras.some((p) => PALAVRAS_TODOS.includes(p)) ? pendentes.filter((e) => candidatosIds.includes(e.id)) : []),
    ...nomeados,
  ];
  const unicos = [...new Map(alvos.map((e) => [e.id, e])).values()];
  return unicos.length ? unicos : null;
}

// Mensagem no grupo da pelada que pode ser a resposta à pergunta do bot.
// Resolve true se era (e já tratou), false se é conversa normal.
function tentarResposta(msg, grupo, agora = null, opcoes = {}) {
  const texto = String(msg.body || '').trim();
  if (!ligado() || !texto || texto.startsWith('#')) return Promise.resolve(false);
  const achada = repo.perguntaAberta(msg.chatId, {
    idCitado: msg.idCitado || null, remetente: msg.numero,
    desde: new Date((agora || new Date()).getTime() - PRAZO_RESPOSTA_MS),
  });
  if (!achada) return Promise.resolve(false);
  const { comprovante: c, citou } = achada;
  // Só quem enviou o Pix responde; e sem citar a pergunta, só mensagem curta
  if (repo.usuario(c.remetente) !== repo.usuario(msg.numero)) return Promise.resolve(false);
  if (!citou && tokens(texto).length > MAX_PALAVRAS_SEM_CITAR) return Promise.resolve(false);

  const resultado = fila.then(() => responder(msg, c, texto, citou, opcoes.entender || (temChave() ? entenderResposta : null)));
  fila = resultado.catch((err) => console.warn(`[comprovante] resposta falhou: ${err.message}`));
  return resultado;
}

async function responder(msg, c, texto, citou, entender) {
  const atual = repo.getComprovante(c.id);
  if (!atual || atual.status !== 'pendente') return false; // um admin resolveu antes
  const lista = pelada.getLista(c.lista_id);
  if (!lista) return false;
  const pendentes = pelada.listarCombinada(lista.id).filter((e) => !e.pago && !e.mensalista);
  const candidatosIds = JSON.parse(c.candidatos || '[]');
  const remetenteIds = JSON.parse(c.do_remetente || '[]');
  const apelidos = nomes.apelidosDasEntradas(c.chat_id, pendentes);
  let alvos = interpretarResposta(texto, pendentes, candidatosIds, remetenteIds, apelidos);

  // Regra fixa não entendeu ("minha filha", "a Lê", erro de digitação): o
  // Claude tenta, escolhendo só entre quem está devendo
  if (!alvos && entender) {
    try {
      const r = await entender({
        texto,
        remetente: c.remetente_nome || 'quem enviou',
        nomesDaLista: nomes.nomesParaOClaude(pendentes, apelidos),
        sugeridos: pendentes.filter((e) => candidatosIds.includes(e.id)).map((e) => e.nome),
      });
      const achados = [
        ...(r.inclui_quem_enviou ? pendentes.filter((e) => remetenteIds.includes(e.id)) : []),
        ...r.nomes.map((n) => nomes.entradaPeloNome(n, pendentes, apelidos)).filter(Boolean),
      ];
      const unicos = [...new Map(achados.map((e) => [e.id, e])).values()];
      if (unicos.length) alvos = unicos;
    } catch (err) {
      console.warn(`[comprovante] Claude não entendeu a resposta: ${err.message}`);
    }
  }

  if (!alvos) {
    if (citou) await msg.reply('Não entendi 😅 Responde com *meu* ou o nome da pessoa.');
    return citou;
  }
  if (alvos.length !== c.pessoas) {
    await msg.reply(`O Pix de ${formatarReais(c.valor_centavos)} dá pra ${c.pessoas} pessoa(s), e eu entendi ${juntarNomes(alvos.map((e) => e.nome))}. ` +
      `Me responde com ${c.pessoas === 1 ? 'um nome só' : `${c.pessoas} nomes`}.`);
    return true;
  }
  const marcados = marcar(lista, alvos);
  repo.resolver(c.id, 'resolvido', marcados);
  const aprendizado = aprender(c, alvos);
  await anunciarNoGrupo(msg, c.chat_id, lista, marcados, '_(valeu por avisar!)_');
  await avisarAdmins(msg, `✅ ${c.remetente_nome || 'Quem enviou'} respondeu no grupo: comprovante ${c.id} → ${juntarNomes(marcados)}.` +
    textoDoAprendizado(c.remetente_nome || 'ele', aprendizado));
  return true;
}

// Conta mais uma vez "fulano pagou por ciclano" (menos o próprio remetente).
// Vira regra só a partir da 2ª vez — ver VEZES_PRA_VALER em ./repositorio
function aprender(c, alvos) {
  const valendo = [];
  const anotados = [];
  for (const alvo of alvos) {
    const ehOProprio = (alvo.numero && repo.usuario(alvo.numero) === repo.usuario(c.remetente))
      || (c.remetente_nome && nomeCasa(alvo.nome, c.remetente_nome))
      || (c.pagador_nome && nomeCasa(alvo.nome, c.pagador_nome));
    if (ehOProprio || !c.remetente) continue;
    const v = repo.vincular(c.chat_id, {
      pagadorNumero: c.remetente, pagadorNome: c.remetente_nome, origem: 'aprendido',
      dependenteNome: alvo.nome, dependenteNumero: numeroSintetico(alvo.numero) ? null : alvo.numero,
    });
    (v.valendo ? valendo : anotados).push(alvo.nome);
  }
  return { valendo, anotados };
}

function textoDoAprendizado(quem, { valendo, anotados }) {
  return (valendo.length ? ` Aprendi: ${quem} paga por ${juntarNomes(valendo)} — da próxima vez marco sozinho.` : '')
    + (anotados.length ? ` Anotei que ${quem} pagou por ${juntarNomes(anotados)}; se acontecer de novo, passo a marcar sozinho.` : '');
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
  let apelidos = null;
  const alvos = [];
  for (const parte of partes) {
    const alvo = normalizarTexto(parte);
    const exatos = entradas.filter((e) => normalizarTexto(e.nome) === alvo);
    let parecidos = exatos.length ? exatos : entradas.filter((e) => normalizarTexto(e.nome).startsWith(alvo));
    if (!parecidos.length) {
      // "Letícia" pra "Fontella ✠": pelo elenco e apelidos
      apelidos = apelidos || nomes.apelidosDasEntradas(lista.chat_id, entradas);
      const r = nomes.nomeadosNoTexto(parte, entradas, apelidos);
      parecidos = r.ambiguo ? entradas.filter((e) => nomes.quemEh(tokens(parte)[0] || '', [e], apelidos).length) : r.nomeados;
    }
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

  const marcados = marcar(lista, r.alvos);
  repo.resolver(id, 'resolvido', marcados);
  await anunciarNoGrupo(msg, c.chat_id, lista, marcados, '');
  return msg.reply(`✅ Marquei ${juntarNomes(marcados)}.` + textoDoAprendizado(c.remetente_nome || 'quem enviou', aprender(c, r.alvos)));
}

module.exports = { receber, tentarResposta, interpretarResposta, resolverComprovante, acharAlvos, ligado };
