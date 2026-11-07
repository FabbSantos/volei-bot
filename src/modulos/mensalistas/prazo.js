// Prazo da mensalidade: "pagamento até quarta 12h, quem não pagou sai". Na hora,
// os mensalistas NÃO-fixos sem o mês pago saem do quadro e a espera sobe; os
// fixos ficam (vaga cativa — o admin cobra na mão). O prazo vale uma vez só.
const { db } = require('../../nucleo/banco');
const { comando } = require('../../nucleo/comandos');
const { resolverGrupo } = require('../grupos/remoto');
const { lerDia, lerHora } = require('../pelada/agenda');
const mensalistas = require('./repositorio');

db.exec(`
  CREATE TABLE IF NOT EXISTS mensalistas_prazo (
    chat_id TEXT PRIMARY KEY,
    prazo_ms INTEGER NOT NULL
  );
`);

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const DIA_MS = 24 * 60 * 60 * 1000;
const BRASILIA_MS = 3 * 60 * 60 * 1000;
const doisDigitos = (n) => String(n).padStart(2, '0');

// Próxima vez que o relógio de Brasília marca <dia> <hora>:<minuto> (sempre no futuro)
function proximaOcorrenciaMs(dia, hora, minuto, agoraMs) {
  const br = new Date(agoraMs - BRASILIA_MS);
  const meiaNoite = Date.UTC(br.getUTCFullYear(), br.getUTCMonth(), br.getUTCDate());
  let alvo = meiaNoite + ((dia - br.getUTCDay() + 7) % 7) * DIA_MS + (hora * 60 + minuto) * 60_000;
  if (alvo <= agoraMs - BRASILIA_MS) alvo += 7 * DIA_MS;
  return alvo + BRASILIA_MS;
}

function descreverPrazo(prazoMs) {
  const d = new Date(prazoMs - BRASILIA_MS);
  const hora = `${d.getUTCHours()}h${d.getUTCMinutes() ? doisDigitos(d.getUTCMinutes()) : ''}`;
  return `*${DIAS[d.getUTCDay()]}, ${doisDigitos(d.getUTCDate())}/${doisDigitos(d.getUTCMonth() + 1)}, ${hora}*`;
}

const getPrazo = (chatId) => db.prepare('SELECT * FROM mensalistas_prazo WHERE chat_id = ?').get(chatId);
const salvarPrazo = (chatId, prazoMs) => db.prepare(
  'INSERT INTO mensalistas_prazo (chat_id, prazo_ms) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET prazo_ms = excluded.prazo_ms'
).run(chatId, prazoMs);
const apagarPrazo = (chatId) => db.prepare('DELETE FROM mensalistas_prazo WHERE chat_id = ?').run(chatId);

function textoDoCorte(r) {
  const linhas = ['⏰ *Prazo da mensalidade encerrado.*'];
  if (r.removidos.length === 0) linhas.push('Todo mundo que não é fixo pagou, ninguém saiu. 🙌');
  else linhas.push(`Saíram do quadro por falta de pagamento: ${r.removidos.map((n) => `*${n}*`).join(', ')}.`);
  if (r.promovidos.length > 0) linhas.push(`⬆️ Subiram da espera: ${r.promovidos.map((n) => `*${n}*`).join(', ')} — falta o pagamento pra confirmar a vaga.`);
  return linhas.join('\n');
}

// Roda a cada minuto. canal = { enviarTexto, gruposAdmin }
async function verificar(canal, agoraMs = Date.now()) {
  const feitos = [];
  for (const p of db.prepare('SELECT * FROM mensalistas_prazo WHERE prazo_ms <= ?').all(agoraMs)) {
    const r = mensalistas.removerNaoPagosDoMes(p.chat_id);
    apagarPrazo(p.chat_id); // vale uma vez só, mesmo se o aviso falhar abaixo
    console.log(`[mensalistas] prazo vencido em ${p.chat_id}: saíram ${r.removidos.join(', ') || 'ninguém'}`);
    const texto = textoDoCorte(r);
    try { await canal.enviarTexto(p.chat_id, texto); } catch (err) { console.warn(`[mensalistas] aviso no grupo não saiu: ${err.message}`); }
    const aFixos = r.fixosPendentes.length > 0 ? `\n📌 Fixos ainda sem pagar o mês (não saem sozinhos): ${r.fixosPendentes.join(', ')}.` : '';
    for (const admin of canal.gruposAdmin()) {
      try { await canal.enviarTexto(admin, `🤖 ${texto}${aFixos}`); } catch (err) { console.warn(`[mensalistas] aviso aos admins não saiu: ${err.message}`); }
    }
    feitos.push(p.chat_id);
  }
  return feitos;
}

// #prazomensalistasde riachuelo quarta 12h · off · (sem nada: mostra)
const REGEX_PRAZO_DE = /^#prazomensalistasde\s+(\S+)(?:\s+(.+))?$/i;

const prazoDe = comando(REGEX_PRAZO_DE, (msg, m) => {
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  const chatId = r.grupo.chat_id;
  const nomeGrupo = r.grupo.nome || chatId;
  const resto = (m[2] || '').trim();
  const exemplo = `*#prazomensalistasde ${m[1]} quarta 12h*`;
  const atual = getPrazo(chatId);

  if (!resto) {
    return msg.reply(atual
      ? `⏰ Prazo da mensalidade de *${nomeGrupo}*: ${descreverPrazo(atual.prazo_ms)}. Quem não-fixo não tiver pagado o mês sai nessa hora.\n\nPra desligar: *#prazomensalistasde ${m[1]} off*`
      : `Sem prazo marcado em *${nomeGrupo}*. Pra marcar: ${exemplo}`);
  }
  if (/^(off|desligar|cancelar)$/i.test(resto)) {
    if (!atual) return msg.reply(`*${nomeGrupo}* não tem prazo marcado.`);
    apagarPrazo(chatId);
    return msg.reply(`⚪ Prazo da mensalidade de *${nomeGrupo}* cancelado. Ninguém sai sozinho.`);
  }

  const p = resto.match(/^(\S+)\s+(\S+)$/);
  const dia = p ? lerDia(p[1]) : -1;
  const hora = p ? lerHora(p[2]) : null;
  if (dia < 0 || !hora) return msg.reply(`Não entendi 🤔 Ex.: ${exemplo}`);

  const prazoMs = proximaOcorrenciaMs(dia, hora.hora, hora.minuto, Date.now());
  salvarPrazo(chatId, prazoMs);
  const pendentes = mensalistas.resumoMensalistas(chatId);
  return msg.reply(`⏰ Prazo de *${nomeGrupo}* marcado: ${descreverPrazo(prazoMs)}. Nessa hora, os mensalistas não-fixos sem o mês pago saem e a espera sobe (fixos ficam). Hoje faltam pagar: ${pendentes.pendentes.length}.`);
});

module.exports = { comandos: [prazoDe], verificar, proximaOcorrenciaMs, descreverPrazo, getPrazo, salvarPrazo };
