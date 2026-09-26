// #replay durante o jogo: anota o horário. O corte só sai quando o vídeo
// daquele horário subir pelo painel (ver processador.js).
//   #replay     os últimos 30s
//   #replay 2   os últimos 2 minutos (teto: 5)
// Aceita "#Replay2" — foi assim que um admin mandou no jogo de 25/09/2026.
const { comando } = require('../../nucleo/comandos');
const { TZ_BRASILIA } = require('../../nucleo/tempo');
const replays = require('./repositorio');

const SEGUNDOS_PADRAO = 30;
const MAX_MINUTOS = 5;

const horaDe = (ms) => new Date(ms).toLocaleTimeString('pt-BR', { timeZone: TZ_BRASILIA, hourCycle: 'h23' });
const diaDe = (ms) => new Date(ms).toLocaleDateString('pt-BR', { timeZone: TZ_BRASILIA, day: '2-digit', month: '2-digit' });
const duracao = (s) => (s < 60 ? `${s}s` : `${s / 60} min`);

const replay = comando(/^#replay\s*(\d+)?$/i, (msg, m) => {
  const pedido = m[1] ? parseInt(m[1], 10) : null;
  const minutos = pedido == null ? null : Math.min(Math.max(pedido, 1), MAX_MINUTOS);
  const segundos = minutos == null ? SEGUNDOS_PADRAO : minutos * 60;
  // A hora da MENSAGEM, não a de agora: com o bot reconectando, a mensagem
  // pode ser processada minutos depois e o corte sairia no lugar errado
  const momento = msg.enviadoEm || Date.now();
  replays.registrarReplay({ chatId: msg.chatId, autor: msg.autor, momento, segundos });
  const teto = pedido != null && pedido > MAX_MINUTOS ? ` (o máximo é ${MAX_MINUTOS} min)` : '';
  return msg.reply(`🎬 Replay anotado: ${horaDe(momento)}, ${duracao(segundos)} pra trás${teto}. Sai quando o vídeo subir.`);
});

const pendentes = comando('#replays', (msg) => {
  const lista = replays.listarReplaysPendentes();
  if (lista.length === 0) return msg.reply('🎬 Nenhum replay esperando vídeo.');
  const linhas = lista.map((r) => `• ${diaDe(r.momento)} ${horaDe(r.momento)} — ${duracao(r.segundos)}${r.autor ? ` (${r.autor})` : ''}`);
  return msg.reply(`🎬 *${lista.length} replay(s) esperando o vídeo subir:*\n${linhas.join('\n')}`);
});

module.exports = { comandos: [replay, pendentes], horaDe, diaDe, duracao };
