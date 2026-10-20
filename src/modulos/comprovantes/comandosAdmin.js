// Comandos de admin dos comprovantes automáticos:
//   #comprovante 7 Duda, Thiago   resolve o comprovante 7 (nomes ou posições)
//   #comprovante 7 ignorar        descarta
//   #pagapor riachuelo            quem paga por quem
//   #pagapor riachuelo Thiago > Duda      ensina na mão
//   #naopagapor riachuelo Thiago > Duda   esquece
const { comando } = require('../../nucleo/comandos');
const { normalizarTexto } = require('../../nucleo/texto');
const { numeroSintetico } = require('../../nucleo/numeros');
const { resolverGrupo } = require('../grupos/remoto');
const pelada = require('../pelada/repositorio');
const { resolverComprovante } = require('./index');
const { nomeCasa } = require('./decisor');
const repo = require('./repositorio');

const REGEX_COMPROVANTE = /^#comprovante\s+(\d+)\s+(.+)$/i;
const REGEX_PAGAPOR = /^#pagapor\s+(.+?)(?:\s+(.+?)\s*>\s*(.+))?$/i;
const REGEX_NAOPAGAPOR = /^#naopagapor\s+(.+?)\s+(.+?)\s*>\s*(.+)$/i;

// Alguém do grupo com WhatsApp de verdade, pelo nome (a última vez que apareceu numa lista)
function acharPessoa(chatId, nome) {
  const alvo = normalizarTexto(nome).trim();
  const comNumero = pelada.entradasDoGrupo(chatId).filter((e) => e.numero && !numeroSintetico(e.numero)).reverse();
  return comNumero.find((e) => normalizarTexto(e.nome) === alvo)
    || comNumero.find((e) => nomeCasa(nome, e.nome))
    || comNumero.find((e) => normalizarTexto(e.nome).startsWith(alvo));
}

// Quem é pago pode não ter WhatsApp ("Bento (cvd Ana)"): acha pelo nome em
// qualquer entrada do grupo, e usa o nome como está na lista
function acharDependente(chatId, nome) {
  const alvo = normalizarTexto(nome).trim();
  const entradas = pelada.entradasDoGrupo(chatId).reverse();
  return entradas.find((e) => normalizarTexto(e.nome) === alvo)
    || entradas.find((e) => nomeCasa(nome, e.nome))
    || entradas.find((e) => normalizarTexto(e.nome).startsWith(alvo));
}

function listar(msg, grupo) {
  const vinculos = repo.listarVinculos(grupo.chat_id);
  if (!vinculos.length) return msg.reply(`Ninguém paga por ninguém em *${grupo.nome || grupo.chat_id}* ainda. Ensina com *#pagapor ${grupo.nome?.split(' ').pop() || 'grupo'} Fulano > Ciclano*.`);
  return msg.reply(`💸 *Quem paga por quem* em ${grupo.nome || grupo.chat_id}\n\n` +
    vinculos.map((v) => `• ${v.pagador_nome || v.pagador_numero} → ${v.dependente_nome}`).join('\n'));
}

const resolver = comando(REGEX_COMPROVANTE, (msg, m) => resolverComprovante(msg, parseInt(m[1], 10), m[2]));

const pagaPor = comando(REGEX_PAGAPOR, (msg, m) => {
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  if (!m[2]) return listar(msg, r.grupo);
  const pagador = acharPessoa(r.grupo.chat_id, m[2]);
  if (!pagador) {
    return msg.reply(`Não sei o WhatsApp de "${m[2]}". Sem problema: quando ele mandar um comprovante e vocês resolverem com *#comprovante*, eu aprendo sozinho.`);
  }
  const dependente = acharDependente(r.grupo.chat_id, m[3]);
  repo.vincular(r.grupo.chat_id, {
    pagadorNumero: pagador.numero, pagadorNome: pagador.nome,
    dependenteNome: dependente?.nome || m[3].trim(),
    dependenteNumero: dependente && !numeroSintetico(dependente.numero) ? dependente.numero : null,
  });
  return listar(msg, r.grupo);
});

const naoPagaPor = comando(REGEX_NAOPAGAPOR, (msg, m) => {
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  const removidos = repo.desvincular(r.grupo.chat_id, m[2], m[3]);
  if (!removidos) return msg.reply(`Não achei "${m[2].trim()} > ${m[3].trim()}".`);
  return listar(msg, r.grupo);
});

module.exports = { comandos: [resolver, naoPagaPor, pagaPor] };
