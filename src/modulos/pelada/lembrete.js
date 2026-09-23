// Lembrete diário de pagamento. Uma vez por dia (a partir de LEMBRETE_HORA,
// horário de Brasília), toda lista ABERTA que ainda tem devedor recebe o
// recado do agiota no grupo. O carimbo lembrete_em na lista garante no máximo
// um por dia, mesmo com deploy/restart.
//
// LEMBRETE_HORA=off (ou 'nao', ou vazio) desliga o recado automático: a cobrança
// passa a ser só sob demanda, com #cobrarde. Desligar por aqui é explícito —
// pôr uma hora impossível como 25 também funcionaria, mas ninguém entenderia
// o porquê seis meses depois.
// Variável AUSENTE continua valendo o padrão de sempre (10h) — quem nunca
// configurou não pode ser surpreendido com o recado desligado. Vazia desliga
// de propósito: hoje `LEMBRETE_HORA=` faz parseInt virar NaN, `hora < NaN` dá
// false, e o recado sairia de madrugada.
const fs = require('fs');
const { agoraBrasilia } = require('../../nucleo/tempo');
const { acharFigurinhaCobranca } = require('../figurinhas');
const pelada = require('./repositorio');
const { montarLembretePagamento } = require('./textos');

const LEMBRETE_DESLIGADO = process.env.LEMBRETE_HORA !== undefined
  && ['off', 'nao', 'não', 'no', '0', ''].includes(String(process.env.LEMBRETE_HORA).trim().toLowerCase());
const LEMBRETE_HORA = parseInt(process.env.LEMBRETE_HORA || '10', 10);
const INTERVALO_MS = 30 * 60_000;

function descreverConfiguracao() {
  return LEMBRETE_DESLIGADO
    ? '[lembrete] recado diário DESLIGADO — cobrança só com #cobrarde'
    : `[lembrete] recado diário ativo a partir das ${LEMBRETE_HORA}h de Brasília`;
}

// canal = { enviarTexto(chatId, texto, opcoes), enviarFigurinha(chatId, caminho) },
// ou null com o bot desconectado — aí tenta de novo no próximo ciclo
async function enviarLembretesDePagamento(canal) {
  if (LEMBRETE_DESLIGADO) return;
  if (!canal) return;

  const { dia, hora } = agoraBrasilia();
  // Anti-NaN: se a hora vier ilegível por qualquer motivo, NÃO manda —
  // (NaN < X) é false e furaria o filtro silenciosamente
  if (!Number.isInteger(hora) || hora < LEMBRETE_HORA) return;

  for (const lista of pelada.listasParaLembrete(dia)) {
    const resumo = pelada.resumoPagamentos(lista.id);
    // Sem devedor não tem recado — e sem carimbo: se alguém entrar devendo
    // ainda hoje, o lembrete sai no próximo ciclo
    if (resumo.pendentes.length === 0) continue;
    try {
      // Marca quem tem WhatsApp conhecido — cutucão de verdade, com notificação
      const recado = montarLembretePagamento(resumo.pendentesComZap);
      await canal.enviarTexto(lista.chat_id, recado.texto, { mentionedList: recado.mencoes });
      // Figurinha "cadê meu pix" na sequência, se a imagem existir nos assets
      const figurinha = acharFigurinhaCobranca(resumo.pendentes);
      if (figurinha && fs.existsSync(figurinha)) {
        try {
          await canal.enviarFigurinha(lista.chat_id, figurinha);
        } catch (err) {
          console.warn(`[lembrete] figurinha falhou: ${err.message}`);
        }
      }
      pelada.marcarLembreteEnviado(lista.id, dia);
      console.log(`[lembrete] enviado pra lista ${lista.data_jogo} de ${lista.chat_id} (${resumo.pendentes.length} devendo)`);
    } catch (err) {
      console.warn(`[lembrete] falha ao enviar pra ${lista.chat_id}: ${err.message}`);
    }
  }
}

module.exports = { INTERVALO_MS, descreverConfiguracao, enviarLembretesDePagamento };
