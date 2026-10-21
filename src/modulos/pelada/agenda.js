// Abertura automática da lista. Cada grupo tem a sua agenda: "toda quarta
// 13h, abre a lista da sexta" — era o que um admin fazia na mão, às 13:00 em
// ponto, toda semana (listas de 30/09, 07/10 e 14/10).
//
// A lista sai IGUAL à do #abrirlistade (é ele que roda por baixo): mensalistas,
// valor padrão, anúncio no grupo. Na última sexta do mês, valor e nome
// próprios (a sexta de 3h, R$ 17). Se o bot estava fora na hora, abre assim
// que voltar — até o dia do jogo. Nunca abre duas vezes a mesma data: se um
// admin abriu na mão, ou cancelou a automática, a agenda não reabre.
const { db } = require('../../nucleo/banco');
const { comando } = require('../../nucleo/comandos');
const { normalizarTexto } = require('../../nucleo/texto');
const { paraCentavos, formatarReais } = require('../../nucleo/dinheiro');
const { resolverGrupo } = require('../grupos/remoto');
const pelada = require('./repositorio');

db.exec(`
  CREATE TABLE IF NOT EXISTS agenda_listas (
    chat_id TEXT PRIMARY KEY,
    dia_abertura INTEGER NOT NULL,   -- 0 = domingo … 6 = sábado
    hora INTEGER NOT NULL,
    minuto INTEGER NOT NULL DEFAULT 0,
    dia_jogo INTEGER NOT NULL,
    ativo INTEGER NOT NULL DEFAULT 1,
    valor_ultima INTEGER,            -- na última <dia do jogo> do mês (ex: a sexta de 3h)
    nome_ultima TEXT,
    ultima_data TEXT,                -- a última data de jogo que a agenda abriu
    atualizado_em TEXT NOT NULL
  );
`);

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const DIA_MS = 24 * 60 * 60 * 1000;
// Brasília é UTC-3 o ano inteiro (sem horário de verão desde 2019): os campos
// UTC de (instante - 3h) são o relógio de Brasília. Conta simples e sem fuso.
const BRASILIA_MS = 3 * 60 * 60 * 1000;

function lerDia(texto) {
  const t = normalizarTexto(String(texto || '')).replace(/-feira$/, '').trim();
  const i = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'].findIndex((d) => d.startsWith(t.slice(0, 3)) && t.length >= 3);
  return i;
}

function lerHora(texto) {
  const m = String(texto || '').trim().match(/^(\d{1,2})(?:[h:](\d{2})?)?h?$/i);
  if (!m) return null;
  const hora = Number(m[1]);
  const minuto = Number(m[2] || 0);
  return hora < 24 && minuto < 60 ? { hora, minuto } : null;
}

const doisDigitos = (n) => String(n).padStart(2, '0');

// Em que ponto do ciclo da semana estamos: quando foi a abertura mais
// recente, qual a data do jogo dela, e se o jogo já passou
function cicloAtual(agenda, agoraMs) {
  const agoraBr = agoraMs - BRASILIA_MS;
  const br = new Date(agoraBr);
  const meiaNoiteHoje = Date.UTC(br.getUTCFullYear(), br.getUTCMonth(), br.getUTCDate());
  const minutosAbertura = (agenda.hora * 60 + agenda.minuto) * 60_000;
  let diaAbertura = meiaNoiteHoje - ((br.getUTCDay() - agenda.dia_abertura + 7) % 7) * DIA_MS;
  if (diaAbertura + minutosAbertura > agoraBr) diaAbertura -= 7 * DIA_MS;
  const jogo = new Date(diaAbertura + ((agenda.dia_jogo - agenda.dia_abertura + 7) % 7) * DIA_MS);
  return {
    dataJogo: `${doisDigitos(jogo.getUTCDate())}/${doisDigitos(jogo.getUTCMonth() + 1)}`,
    jaPassou: agoraBr >= jogo.getTime() + DIA_MS,
    // A última sexta do mês: a próxima sexta já é no mês seguinte
    ultimaDoMes: new Date(jogo.getTime() + 7 * DIA_MS).getUTCMonth() !== jogo.getUTCMonth(),
  };
}

function getAgenda(chatId) {
  return db.prepare('SELECT * FROM agenda_listas WHERE chat_id = ?').get(chatId);
}

function salvarAgenda(chatId, campos) {
  const atual = getAgenda(chatId);
  const nova = { ultima_data: null, valor_ultima: null, nome_ultima: null, minuto: 0, ativo: 1, ...atual, ...campos };
  db.prepare(`
    INSERT INTO agenda_listas (chat_id, dia_abertura, hora, minuto, dia_jogo, ativo, valor_ultima, nome_ultima, ultima_data, atualizado_em)
    VALUES (@chat_id, @dia_abertura, @hora, @minuto, @dia_jogo, @ativo, @valor_ultima, @nome_ultima, @ultima_data, @atualizado_em)
    ON CONFLICT(chat_id) DO UPDATE SET dia_abertura = @dia_abertura, hora = @hora, minuto = @minuto, dia_jogo = @dia_jogo,
      ativo = @ativo, valor_ultima = @valor_ultima, nome_ultima = @nome_ultima, ultima_data = @ultima_data, atualizado_em = @atualizado_em
  `).run({ ...nova, chat_id: chatId, atualizado_em: new Date().toISOString() });
  return getAgenda(chatId);
}

function descrever(a) {
  if (!a) return 'sem agenda';
  const base = `toda *${DIAS[a.dia_abertura]}* às *${a.hora}h${a.minuto ? doisDigitos(a.minuto) : ''}* abre a lista da *${DIAS[a.dia_jogo]}*`;
  const ultima = a.valor_ultima != null ? ` · na última ${DIAS[a.dia_jogo]} do mês: ${formatarReais(a.valor_ultima)}${a.nome_ultima ? ` "${a.nome_ultima}"` : ''}` : '';
  return `${a.ativo ? '🟢' : '⚪ (desligada)'} ${base}${ultima}`;
}

// Roda a cada minuto. abrir(agenda, { dataJogo, valor, nome }) abre de fato
// (no main.js, é o #abrirlistade); aqui fica só a decisão de quando.
async function verificar(abrir, agoraMs = Date.now()) {
  const abertas = [];
  for (const a of db.prepare('SELECT * FROM agenda_listas WHERE ativo = 1').all()) {
    const c = cicloAtual(a, agoraMs);
    if (c.jaPassou || a.ultima_data === c.dataJogo) continue;
    const existente = pelada.listasDoGrupo(a.chat_id).find((l) => l.data_jogo === c.dataJogo);
    if (!existente) {
      // A lista da semana passada ainda aberta: fecha quieta (o #lista e o
      // #pago caem sempre na mais recente; ela já não serve pra nada)
      const abertasAntes = db.prepare("SELECT id FROM listas WHERE chat_id = ? AND status = 'aberta'").all(a.chat_id);
      for (const l of abertasAntes) pelada.encerrarLista(l.id);
      const especial = c.ultimaDoMes && a.valor_ultima != null;
      await abrir(a, { dataJogo: c.dataJogo, valor: especial ? a.valor_ultima : null, nome: especial ? a.nome_ultima : null });
      abertas.push({ chatId: a.chat_id, dataJogo: c.dataJogo });
    }
    // Abriu agora, ou um admin já tinha aberto na mão: não mexe mais nessa data
    db.prepare('UPDATE agenda_listas SET ultima_data = ? WHERE chat_id = ?').run(c.dataJogo, a.chat_id);
  }
  return abertas;
}

// #agendalistade riachuelo quarta 13h sexta [ultima 17 Sexta 3h] · off · (sem nada: mostra)
const REGEX_AGENDA_DE = /^#agendalistade\s+(\S+)(?:\s+(.+))?$/i;

const agendaDe = comando(REGEX_AGENDA_DE, (msg, m) => {
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  const chatId = r.grupo.chat_id;
  const nomeGrupo = r.grupo.nome || chatId;
  const resto = (m[2] || '').trim();
  const exemplo = `*#agendalistade ${m[1]} quarta 13h sexta* (opcional no fim: *ultima 17 Sexta 3h*)`;

  if (!resto) return msg.reply(`📅 Agenda de *${nomeGrupo}*: ${descrever(getAgenda(chatId))}\n\nPra mudar: ${exemplo} · pra desligar: *#agendalistade ${m[1]} off*`);
  if (/^(off|desligar|parar)$/i.test(resto)) {
    if (!getAgenda(chatId)) return msg.reply(`*${nomeGrupo}* não tem agenda.`);
    salvarAgenda(chatId, { ativo: 0 });
    return msg.reply(`⚪ Agenda de *${nomeGrupo}* desligada. A lista volta a ser aberta na mão.`);
  }

  const p = resto.match(/^(\S+)\s+(\S+)\s+(\S+)(?:\s+[uú]ltima\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?)(?:\s+(.+))?)?$/i);
  const diaAbertura = p ? lerDia(p[1]) : -1;
  const hora = p ? lerHora(p[2]) : null;
  const diaJogo = p ? lerDia(p[3]) : -1;
  if (diaAbertura < 0 || !hora || diaJogo < 0) return msg.reply(`Não entendi 🤔 Ex.: ${exemplo}`);

  const a = salvarAgenda(chatId, {
    dia_abertura: diaAbertura, hora: hora.hora, minuto: hora.minuto, dia_jogo: diaJogo, ativo: 1,
    valor_ultima: p[4] ? paraCentavos(p[4]) : null, nome_ultima: p[4] ? (p[5] || '').trim() || null : null,
  });
  const c = cicloAtual(a, Date.now());
  const proxima = !c.jaPassou && a.ultima_data !== c.dataJogo && !pelada.listasDoGrupo(chatId).some((l) => l.data_jogo === c.dataJogo)
    ? `\n⚠️ A abertura desta semana já passou e a lista de *${c.dataJogo}* não existe: eu abro ela no próximo minuto.`
    : '';
  return msg.reply(`📅 Agenda de *${nomeGrupo}* ligada: ${descrever(a)}.${proxima}`);
});

module.exports = { comandos: [agendaDe], verificar, cicloAtual, lerDia, lerHora, getAgenda, salvarAgenda, descrever };
