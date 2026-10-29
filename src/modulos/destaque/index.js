// Destaque da noite + enquete de equilíbrio (ideia do Diego, 29/10/2026).
//
// Depois do jogo, o bot posta no grupo uma enquete por time ("🌟 Destaque do
// Time 1"), com quem jogou nele, e uma enquete "os times ficaram
// equilibrados?". No dia seguinte, às 12h, anuncia os destaques no grupo; o
// resultado do equilíbrio vai só pros admins (é o termômetro do montador).
//
// O WhatsApp aceita no máximo 12 opções por enquete — por isso uma por time.
// Destaque não é o melhor da quadra: é quem jogou ACIMA DO PRÓPRIO NORMAL
// (senão o mesmo craque leva todas). Voto em si mesmo não conta.
//
// Os votos não são escutados: o bot relê a enquete inteira na hora de apurar
// (WPP.chat.getVotes), então reiniciar no meio não perde voto.
const { db } = require('../../nucleo/banco');
const { comando } = require('../../nucleo/comandos');
const { normalizarTexto } = require('../../nucleo/texto');
const { resolverGrupo } = require('../grupos/remoto');
const pelada = require('../pelada/repositorio');
const times = require('../elenco/times');
const elenco = require('../elenco/repositorio');

db.exec(`
  CREATE TABLE IF NOT EXISTS destaque_rodadas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lista_id INTEGER NOT NULL,
    chat_id TEXT NOT NULL,          -- onde as enquetes foram postadas (no teste: o grupo de admins)
    teste INTEGER NOT NULL DEFAULT 0,
    criada_em TEXT NOT NULL,
    anunciada_em TEXT
  );
  CREATE TABLE IF NOT EXISTS destaque_enquetes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rodada_id INTEGER NOT NULL,
    tipo TEXT NOT NULL,             -- time | equilibrio
    time_numero INTEGER,
    msg_id TEXT NOT NULL,
    opcoes TEXT NOT NULL            -- JSON com os textos, na ordem da enquete
  );
`);

pelada.quandoApagarLista((listaId) => {
  const ids = db.prepare('SELECT id FROM destaque_rodadas WHERE lista_id = ?').all(listaId).map((r) => r.id);
  for (const id of ids) db.prepare('DELETE FROM destaque_enquetes WHERE rodada_id = ?').run(id);
  db.prepare('DELETE FROM destaque_rodadas WHERE lista_id = ?').run(listaId);
});

const HORA_MS = 60 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;
const BRASILIA_MS = 3 * HORA_MS; // UTC-3 o ano todo
const POSTAR_DEPOIS_MS = 30 * 60 * 1000; // enquetes 30min depois do fim do jogo
const HORA_DO_RESULTADO = 12; // resultado no dia seguinte, meio-dia
const MAX_OPCOES = 12; // limite do WhatsApp

const EQUILIBRIO = ['⚖️ Bem equilibrados', '🤏 Um time sobrou um pouco', '💀 Foi atropelo'];

// ---- quando acaba o jogo ----------------------------------------------------

// 00:00 (Brasília) do dia do jogo, em ms. A lista não guarda o ano: vale o
// mais perto de quando ela foi criada.
function diaDoJogoMs(lista) {
  const m = String(lista.data_jogo || '').match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  const base = new Date(lista.criada_em).getTime();
  const ano = new Date(base).getUTCFullYear();
  const dia = [ano - 1, ano, ano + 1]
    .map((a) => Date.UTC(a, Number(m[2]) - 1, Number(m[1])))
    .reduce((a, b) => (Math.abs(b - base) < Math.abs(a - base) ? b : a));
  return dia + BRASILIA_MS;
}

// Fim do jogo: o que estiver no nome ("(20h ~ 22h)"); senão sexta normal até
// 23h e a última do mês (a de 3h) até meia-noite.
function fimDoJogoMs(lista) {
  const dia = diaDoJogoMs(lista);
  if (dia == null) return null;
  const doNome = String(lista.nome || '').match(/[~–-]\s*(\d{1,2})\s*h/i);
  let hora;
  if (doNome) {
    hora = Number(doNome[1]);
    if (hora < 12) hora += 24; // "22h ~ 0h" acaba no dia seguinte
  } else {
    const ultimaDoMes = new Date(dia + 7 * DIA_MS - BRASILIA_MS).getUTCMonth() !== new Date(dia - BRASILIA_MS).getUTCMonth();
    hora = ultimaDoMes ? 24 : 23;
  }
  return dia + hora * HORA_MS;
}

const resultadoEmMs = (lista) => diaDoJogoMs(lista) + DIA_MS + HORA_DO_RESULTADO * HORA_MS;

// ---- quem é quem --------------------------------------------------------------

const palavras = (s) => normalizarTexto(String(s || '').replace(/\(cvd[^)]*\)/i, ''))
  .replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);

// "Marcel Garcia" (WhatsApp) é o "Marcel" da lista, e vice-versa: mesmo
// primeiro nome e um nome todo contido no outro
function mesmaPessoa(a, b) {
  const pa = palavras(a);
  const pb = palavras(b);
  if (!pa.length || !pb.length || pa[0] !== pb[0]) return false;
  return pa.every((p) => pb.includes(p)) || pb.every((p) => pa.includes(p));
}

// O voto é na própria pessoa? Quem entrou na lista pelo próprio WhatsApp é
// reconhecido pelo número (exato). Os fixos e quem foi posto na mão têm número
// fictício: aí vale o nome do WhatsApp contra o nome/apelidos do elenco.
function votouEmSi(voto, nomeOpcao, ctx) {
  const usuario = String(voto.numero || '').split('@')[0];
  const minha = usuario && ctx.entradas.find((e) => String(e.numero).split('@')[0] === usuario);
  const alvo = ctx.entradas.find((e) => e.nome === nomeOpcao);
  if (minha) return Boolean(alvo) && alvo.id === minha.id;
  if (!voto.nome) return false;
  const jogador = elenco.acharJogadorDaEntrada(ctx.chatId, { nome: nomeOpcao, numero: alvo?.numero || '' }, ctx.jogadores);
  return [nomeOpcao, ...(jogador ? [jogador.nome, ...(jogador.apelidos || [])] : [])].some((n) => mesmaPessoa(voto.nome, n));
}

// ---- banco ------------------------------------------------------------------

const rodadaReal = (listaId) =>
  db.prepare('SELECT * FROM destaque_rodadas WHERE lista_id = ? AND teste = 0 ORDER BY id DESC LIMIT 1').get(listaId);
const ultimaRodada = (listaId) =>
  db.prepare('SELECT * FROM destaque_rodadas WHERE lista_id = ? ORDER BY id DESC LIMIT 1').get(listaId);
const enquetesDa = (rodadaId) =>
  db.prepare('SELECT * FROM destaque_enquetes WHERE rodada_id = ? ORDER BY id').all(rodadaId)
    .map((e) => ({ ...e, opcoes: JSON.parse(e.opcoes) }));

// ---- postar -------------------------------------------------------------------

function textoDeAbertura(lista, teste, resultadoEm) {
  return `${teste ? '🧪 *TESTE* — só aqui no grupo de admins, a pelada não vê nada.\n\n' : ''}` +
    `🏐 *Fim de pelada${lista.data_jogo ? ` (${lista.data_jogo})` : ''}!* Hora de votar no 🌟 *destaque* de cada time.\n\n` +
    `Não é o melhor da quadra: é quem jogou *acima do próprio normal* hoje. Voto em si mesmo não conta 😏\n\n` +
    `E na última enquete: os times da *NOVA TECNOLOGIA DA NASA 2* 🚀 ficaram equilibrados?\n\n` +
    `${teste ? 'Resultado: *#destaquede <grupo> resultado* 👇' : `Resultado ${resultadoEm} 👇`}`;
}

// canal: { enviarTexto(chatId, texto), enviarEnquete(chatId, titulo, opcoes) → msgId }
async function postar(canal, lista, destino, { teste = false } = {}) {
  const salvos = times.getTimesSalvos(lista.id);
  const comGente = (salvos?.times || []).filter((t) => t.jogadores.length >= 2);
  if (!comGente.length) return { erro: 'sem_times' };

  const r = db.prepare('INSERT INTO destaque_rodadas (lista_id, chat_id, teste, criada_em) VALUES (?, ?, ?, ?)')
    .run(lista.id, destino, teste ? 1 : 0, new Date().toISOString());
  const rodadaId = r.lastInsertRowid;
  const guardar = db.prepare('INSERT INTO destaque_enquetes (rodada_id, tipo, time_numero, msg_id, opcoes) VALUES (?, ?, ?, ?, ?)');

  await canal.enviarTexto(destino, textoDeAbertura(lista, teste, 'amanhã ao meio-dia'));
  for (const t of comGente) {
    const opcoes = t.jogadores.slice(0, MAX_OPCOES).map((j) => j.nome);
    const msgId = await canal.enviarEnquete(destino, `🌟 Destaque do Time ${t.numero} — quem jogou acima do próprio normal?`, opcoes);
    guardar.run(rodadaId, 'time', t.numero, msgId, JSON.stringify(opcoes));
  }
  const msgId = await canal.enviarEnquete(destino, '⚖️ Os jogos de hoje foram equilibrados?', EQUILIBRIO);
  guardar.run(rodadaId, 'equilibrio', null, msgId, JSON.stringify(EQUILIBRIO));
  return { rodadaId, times: comGente.length };
}

// ---- apurar -------------------------------------------------------------------

// canal.lerVotos(msgId) → [{ numero, nome, opcoes: [índices] }]
async function apurar(canal, rodada) {
  const lista = pelada.getLista(rodada.lista_id);
  const ctx = {
    chatId: lista.chat_id,
    entradas: pelada.entradasPrincipais(lista.id),
    jogadores: elenco.listarJogadores(lista.chat_id),
  };
  const resultado = { lista, times: [], equilibrio: null };
  for (const e of enquetesDa(rodada.id)) {
    const votos = await canal.lerVotos(e.msg_id);
    const contagem = e.opcoes.map((opcao) => ({ opcao, votos: 0 }));
    let emSi = 0;
    for (const v of votos) {
      for (const i of v.opcoes) {
        if (!contagem[i]) continue;
        if (e.tipo === 'time' && votouEmSi(v, e.opcoes[i], ctx)) { emSi++; continue; }
        contagem[i].votos++;
      }
    }
    if (e.tipo === 'equilibrio') resultado.equilibrio = { contagem, votantes: votos.length };
    else resultado.times.push({ numero: e.time_numero, contagem, emSi, votantes: votos.length });
  }
  return resultado;
}

const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

function vencedores(contagem) {
  const max = Math.max(0, ...contagem.map((c) => c.votos));
  return max ? { nomes: contagem.filter((c) => c.votos === max).map((c) => c.opcao), votos: max } : null;
}

function textoDosDestaques(r) {
  const linhas = r.times.map((t) => {
    const v = vencedores(t.contagem);
    if (!v) return `⚔️ Time ${t.numero}: ninguém votou 😴`;
    const nomes = v.nomes.map((n) => `*${n}*`);
    const juntos = nomes.length > 1 ? `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}` : nomes[0];
    return `⚔️ Time ${t.numero}: ${juntos} (${nomes.length > 1 ? 'empate, ' : ''}${plural(v.votos, 'voto', 'votos')})`;
  });
  return `🌟 *Destaques da pelada${r.lista.data_jogo ? ` de ${r.lista.data_jogo}` : ''}*\n\n${linhas.join('\n')}\n\nJogaram acima do próprio normal — parabéns! 👏`;
}

// O detalhado, só pros admins: placar de cada enquete + o termômetro do montador
function textoParaAdmins(r, { teste = false } = {}) {
  const partes = r.times.map((t) => {
    const placar = t.contagem.filter((c) => c.votos).sort((a, b) => b.votos - a.votos)
      .map((c) => `${c.opcao} ${c.votos}`).join(' · ') || 'sem votos';
    return `Time ${t.numero} (${plural(t.votantes, 'votante', 'votantes')}): ${placar}${t.emSi ? ` · 🚫 ${t.emSi} em si mesmo` : ''}`;
  });
  const eq = r.equilibrio;
  const equilibrio = eq
    ? `⚖️ *Equilíbrio dos times* (${plural(eq.votantes, 'voto', 'votos')}):\n${eq.contagem.map((c) => `${c.opcao}: ${c.votos}`).join('\n')}`
    : '';
  return `📊 *Votação${teste ? ' de TESTE' : ''} — pelada ${r.lista.data_jogo}* (só pra vocês)\n\n🌟 *Destaques:*\n${partes.join('\n')}\n\n${equilibrio}`;
}

// ---- relógio (main.js, a cada minuto) -----------------------------------------

// canal: { enviarTexto, enviarEnquete, lerVotos, gruposAdmin() }
async function verificar(canal, agoraMs = Date.now()) {
  const feitos = [];
  const listas = db.prepare(`
    SELECT l.* FROM listas l JOIN times_montados t ON t.lista_id = l.id
    WHERE l.criada_em >= ?
  `).all(new Date(agoraMs - 20 * DIA_MS).toISOString());

  for (const lista of listas) {
    const fim = fimDoJogoMs(lista);
    if (fim == null) continue;
    // Enquetes: de 30min depois do fim até 6h depois (bot fora do ar a noite
    // toda não posta enquete de manhã)
    if (agoraMs >= fim + POSTAR_DEPOIS_MS && agoraMs < fim + 6 * HORA_MS && !rodadaReal(lista.id)) {
      console.log(`[destaque] postando as enquetes da lista ${lista.data_jogo} em ${lista.chat_id}`);
      const r = await postar(canal, lista, lista.chat_id);
      feitos.push({ tipo: 'postou', listaId: lista.id, ...r });
    }
  }

  // Resultado: no dia seguinte ao meio-dia (até 2 dias depois, se o bot estava fora)
  const pendentes = db.prepare('SELECT * FROM destaque_rodadas WHERE teste = 0 AND anunciada_em IS NULL').all();
  for (const rodada of pendentes) {
    const lista = pelada.getLista(rodada.lista_id);
    if (!lista) continue;
    const quando = resultadoEmMs(lista);
    if (agoraMs < quando) continue;
    db.prepare('UPDATE destaque_rodadas SET anunciada_em = ? WHERE id = ?').run(new Date(agoraMs).toISOString(), rodada.id);
    if (agoraMs > quando + 2 * DIA_MS) continue; // velho demais: só marca
    await anunciar(canal, rodada);
    feitos.push({ tipo: 'anunciou', listaId: lista.id });
  }
  return feitos;
}

async function anunciar(canal, rodada, { avisarAdmins = true } = {}) {
  const r = await apurar(canal, rodada);
  await canal.enviarTexto(rodada.chat_id, textoDosDestaques(r));
  if (avisarAdmins && !rodada.teste) {
    for (const chatId of canal.gruposAdmin()) {
      try { await canal.enviarTexto(chatId, textoParaAdmins(r)); } catch (err) { console.warn(`[destaque] aviso aos admins não saiu: ${err.message}`); }
    }
  }
  db.prepare('UPDATE destaque_rodadas SET anunciada_em = ? WHERE id = ?').run(new Date().toISOString(), rodada.id);
  return r;
}

// ---- comando -----------------------------------------------------------------

// #destaquede riachuelo [teste|resultado|anunciar]
const REGEX_DESTAQUE_DE = /^#destaquede\s+(.+?)(?:\s+(teste|resultado|anunciar))?$/i;

const destaqueDe = comando(REGEX_DESTAQUE_DE, async (msg, m) => {
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  const lista = pelada.getListaMaisRecente(r.grupo.chat_id);
  if (!lista) return msg.reply(`*${r.grupo.nome || r.grupo.chat_id}* ainda não tem lista.`);
  const modo = (m[2] || '').toLowerCase();
  const canal = {
    enviarTexto: (chatId, texto) => msg.enviarPara(chatId, texto),
    enviarEnquete: (chatId, titulo, opcoes) => msg.enviarEnquetePara(chatId, titulo, opcoes),
    lerVotos: (msgId) => msg.lerVotos(msgId),
  };
  const semTimes = `A lista ${lista.data_jogo} não tem times salvos — monta antes com *#timesde ${m[1]}* (ou no painel).`;

  if (modo === 'resultado') {
    const rodada = ultimaRodada(lista.id);
    if (!rodada) return msg.reply(`Ainda não teve votação na lista ${lista.data_jogo}.`);
    const res = await apurar(canal, rodada);
    return msg.reply(`${textoParaAdmins(res, { teste: Boolean(rodada.teste) })}\n\n👀 Como sairia o anúncio:\n\n${textoDosDestaques(res)}`);
  }

  if (modo === 'anunciar') {
    const rodada = ultimaRodada(lista.id);
    if (!rodada) return msg.reply(`Ainda não teve votação na lista ${lista.data_jogo}.`);
    const res = await anunciar(canal, rodada, { avisarAdmins: false });
    return msg.reply(rodada.teste
      ? '🧪 Anúncio de teste postado aqui mesmo.'
      : `🌟 Destaques anunciados no grupo.\n\n${textoParaAdmins(res)}`);
  }

  if (modo === 'teste') {
    // Enquete só existe em grupo: o teste roda no grupo de admins
    if (msg.origem !== 'grupoadmin') return msg.reply('🧪 O teste posta as enquetes onde você mandou o comando — e enquete só funciona em grupo. Manda no grupo de admins.');
    const p = await postar(canal, lista, msg.chatId, { teste: true });
    if (p.erro) return msg.reply(semTimes);
    return null; // as enquetes já são a resposta
  }

  if (rodadaReal(lista.id)) {
    return msg.reply(`As enquetes da lista ${lista.data_jogo} já foram postadas no grupo. Pra ver como está: *#destaquede ${m[1]} resultado*.`);
  }
  const p = await postar(canal, lista, r.grupo.chat_id);
  if (p.erro) return msg.reply(semTimes);
  return msg.reply(`🌟 ${p.times + 1} enquetes postadas no grupo (${p.times} de destaque + equilíbrio). Resultado amanhã às ${HORA_DO_RESULTADO}h — ou *#destaquede ${m[1]} anunciar* quando quiser.`);
});

module.exports = {
  comandos: [destaqueDe],
  verificar, postar, apurar, anunciar, fimDoJogoMs, resultadoEmMs, mesmaPessoa, votouEmSi,
  textoDosDestaques, textoParaAdmins, EQUILIBRIO,
};
