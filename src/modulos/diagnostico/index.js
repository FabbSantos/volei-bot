// #teste: diagnóstico completo em uma mensagem — conexão, processo, banco,
// listas, fuso e figurinhas. A ideia é que uma linha errada salte aos olhos,
// por isso cada item leva ✅ ou ⚠️ em vez de só despejar número.
const fs = require('fs');
const { comando } = require('../../nucleo/comandos');
const grupos = require('../grupos/repositorio');
const pelada = require('../pelada/repositorio');
const { listarFigurinhas } = require('../figurinhas');

// "3d 4h 12min" a partir de segundos — uptime legível na resposta do #teste
function tempoLegivel(segundos) {
  const d = Math.floor(segundos / 86400);
  const h = Math.floor((segundos % 86400) / 3600);
  const m = Math.floor((segundos % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, `${m}min`].filter(Boolean).join(' ');
}

function montarRelatorioDeSaude(saude) {
  const linhas = [];
  const problemas = [];

  // --- conexão e processo
  if (saude) {
    const conectado = ['inChat', 'isLogged', 'CONNECTED'].includes(saude.status);
    if (!conectado) problemas.push(`conexão em "${saude.status}"`);
    if (saude.tentativas > 0) problemas.push(`${saude.tentativas} tentativa(s) de reconexão em curso`);
    if (saude.esperandoQr) problemas.push('esperando leitura de QR');

    linhas.push(`${conectado ? '✅' : '⚠️'} *Conexão:* ${saude.status}${saude.tentativas ? ` (${saude.tentativas} tentativa(s))` : ''}`);
    linhas.push(`🖥 *Máquina:* ${saude.maquina}`);
    linhas.push(`⏱ *No ar há:* ${tempoLegivel(saude.uptimeSegundos)} · ${saude.memoriaMb} MB`);
  } else {
    linhas.push('⚠️ *Conexão:* não consegui ler o estado do processo');
    problemas.push('estado do processo indisponível');
  }

  // --- banco: leitura de verdade, não só "o arquivo existe"
  let todos = [];
  try {
    todos = grupos.listarGrupos();
    const caminho = process.env.DB_PATH || 'volei.db';
    let tamanho = '';
    try {
      const bytes = fs.statSync(caminho).size;
      tamanho = bytes >= 1024 * 1024
        ? ` · ${(bytes / 1024 / 1024).toFixed(1)} MB`
        : ` · ${Math.round(bytes / 1024)} KB`;
    } catch {}
    linhas.push(`✅ *Banco:* respondendo${tamanho}`);
  } catch (err) {
    linhas.push(`❌ *Banco:* ${err.message}`);
    problemas.push('banco não respondeu');
  }

  // --- relógio: o lembrete depende do fuso, e já quebrou por causa disso
  const agora = new Date();
  const horaBr = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'short',
    hourCycle: 'h23',
  }).format(agora);
  linhas.push(`🕐 *Agora em Brasília:* ${horaBr}`);

  // --- listas por grupo, com o estado da cobrança do dia
  const hoje = agora.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const ativos = todos.filter((g) => g.ativo && !g.eh_admin);
  if (ativos.length === 0) {
    linhas.push('⚠️ *Grupos:* nenhum grupo ativo');
  } else {
    linhas.push(`\n📋 *Grupos ativos (${ativos.length}):*`);
    for (const g of ativos) {
      const lista = pelada.getListaMaisRecente(g.chat_id);
      if (!lista) {
        linhas.push(`• ${g.nome || g.chat_id} — sem lista`);
        continue;
      }
      const resumo = pelada.resumoPagamentos(lista.id);
      const cobranca = lista.status === 'aberta'
        ? (lista.lembrete_em === hoje ? 'cobrança de hoje já saiu' : 'cobrança de hoje ainda não saiu')
        : 'lista fechada, sem cobrança diária';
      linhas.push(
        `• ${g.nome || g.chat_id} — *${lista.data_jogo}* (${lista.status})\n` +
        `   ${resumo.totalPessoas} na lista · ${resumo.emDia}/${resumo.totalCobrados} em dia · ${cobranca}`
      );
    }
  }

  // --- figurinhas: arquivo faltando só aparece na hora de enviar, tarde demais
  const temas = ['agiota-pago', 'cade-meu-pix'];
  const contagem = temas.map((t) => `${t}: ${listarFigurinhas(t).length}`).join(' · ');
  const faltando = temas.filter((t) => listarFigurinhas(t).length === 0);
  if (faltando.length) problemas.push(`sem figurinha de ${faltando.join(' e ')}`);
  linhas.push(`\n${faltando.length ? '⚠️' : '✅'} *Figurinhas:* ${contagem}`);

  const cabecalho = problemas.length === 0
    ? '🏐 *Tudo certo por aqui.*\n'
    : `⚠️ *Achei ${problemas.length} coisa(s) fora do lugar:*\n${problemas.map((p) => `• ${p}`).join('\n')}\n`;

  return `${cabecalho}\n${linhas.join('\n')}`;
}

const teste = comando('#teste', (msg) => msg.reply(montarRelatorioDeSaude(msg.saude ? msg.saude() : null)));

module.exports = { comandos: [teste], montarRelatorioDeSaude };
