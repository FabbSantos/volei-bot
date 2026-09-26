// O que acontece quando um vídeo termina de subir pelo painel:
//   1. importa (vira pedaços de 5min com a hora no nome) e apaga o original
//   2. pega os #replay pendentes que caem no horário do vídeo
//   3. corta cada um e manda no chat onde foi pedido
//   4. avisa o grupo de admins do resultado
//
// Um vídeo por vez: dois ffmpeg lendo o disco ao mesmo tempo só deixam os
// dois lentos, e a fila garante que um replay não seja cortado duas vezes.
const fs = require('fs');
const path = require('path');
const repo = require('./repositorio');
const { lerConfig } = require('./config');
const { apagarAntigos } = require('./pedacos');
const { trabalhar: trabalharDeVerdade } = require('./trabalhador');
const { TZ_BRASILIA } = require('../../nucleo/tempo');
const { horaDe, duracao } = require('./comandosAdmin');

const DIA_MS = 24 * 60 * 60 * 1000;
const MAX_MB_NO_WHATSAPP = parseFloat(process.env.VIDEO_MAX_MB_WHATSAPP || '60');

const quando = (ms) => new Date(ms).toLocaleString('pt-BR', {
  timeZone: TZ_BRASILIA, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

// Nome do arquivo do corte: replay_2026-09-25_21h53m05s_30s.mp4
function nomeDoCorte(replay) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_BRASILIA, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(replay.momento));
  const p = Object.fromEntries(partes.map((x) => [x.type, x.value]));
  return `replay_${p.year}-${p.month}-${p.day}_${p.hour}h${p.minute}m${p.second}s_${replay.segundos}s.mp4`;
}

let fila = Promise.resolve();

// canal: { enviarTexto(chatId, texto), enviarArquivo(chatId, caminho, legenda), gruposAdmin() }
// Devolve a promessa do processamento (os testes esperam; o painel não).
function processarVideo(videoId, arquivo, canal, opcoes = {}) {
  fila = fila.then(() => processar(videoId, arquivo, canal, opcoes)).catch((err) => {
    console.error(`[video] erro processando o vídeo ${videoId}: ${err.message}`);
  });
  return fila;
}

async function processar(videoId, arquivo, canal, { trabalhar = trabalharDeVerdade, cfg = lerConfig() } = {}) {
  const avisarAdmins = async (texto) => {
    for (const chatId of canal.gruposAdmin()) {
      try { await canal.enviarTexto(chatId, texto); } catch (err) { console.warn(`[video] aviso não saiu: ${err.message}`); }
    }
  };

  let importado;
  try {
    importado = await trabalhar({ acao: 'importar', arquivo });
  } catch (err) {
    repo.marcarVideo(videoId, { status: 'erro', erro: err.message });
    await avisarAdmins(`⚠️ O vídeo não importou: ${err.message}`);
    return;
  } finally {
    // O original já virou pedaços (ou não serve); o celular de quem subiu
    // continua com ele. 5 GB parados no disco da VPS não ajudam ninguém.
    fs.rmSync(arquivo, { force: true });
  }
  repo.marcarVideo(videoId, { inicio: importado.inicio, fim: importado.fim, aviso: importado.aviso });
  console.log(`[video] vídeo ${videoId}: ${quando(importado.inicio)} → ${quando(importado.fim)}, ${importado.pedacos} pedaço(s)`);

  const pendentes = repo.replaysPendentesEntre(importado.inicio, importado.fim);
  let enviados = 0;
  for (const r of pendentes) {
    try {
      const corte = await trabalhar({ acao: 'cortar', inicio: r.momento - r.segundos * 1000, fim: r.momento, nome: nomeDoCorte(r) });
      if (corte.erro) throw new Error('a câmera não gravou esse horário');
      const legenda = `🎬 Replay de ${horaDe(r.momento)} · ${duracao(r.segundos)}${r.autor ? ` · pedido por ${r.autor}` : ''}`;
      const mb = fs.statSync(corte.arquivo).size / 1024 / 1024;
      if (mb <= MAX_MB_NO_WHATSAPP) {
        await canal.enviarArquivo(r.chat_id, corte.arquivo, legenda);
      } else {
        // O arquivo atravessa o navegador do bot em base64: 140 MB (o
        // #replay 5 do jogo de 25/09) é pedir pra travar a página
        const link = `${process.env.PAINEL_URL || ''}/api/video/corte/${encodeURIComponent(path.basename(corte.arquivo))}`;
        await canal.enviarTexto(r.chat_id, `${legenda}\nFicou com ${Math.round(mb)} MB, grande demais pro WhatsApp. Baixa pelo painel:\n${link}`);
      }
      repo.marcarReplay(r.id, { status: 'enviado', videoId, arquivo: path.basename(corte.arquivo) });
      enviados++;
    } catch (err) {
      console.warn(`[video] replay ${r.id} falhou: ${err.message}`);
      repo.marcarReplay(r.id, { status: 'erro', videoId, erro: err.message });
    }
  }
  repo.marcarVideo(videoId, { status: 'pronto' });

  const falhas = pendentes.length - enviados;
  const resumo = [
    `🎥 Vídeo de ${quando(importado.inicio)} até ${horaDe(importado.fim).slice(0, 5)} importado.`,
    pendentes.length === 0
      ? 'Nenhum #replay pedido nesse horário.'
      : `${enviados} replay(s) enviado(s)${falhas ? ` · ⚠️ ${falhas} falharam` : ''}.`,
    importado.aviso ? `Obs.: ${importado.aviso}.` : null,
  ].filter(Boolean).join('\n');
  await avisarAdmins(resumo);

  arrumarACasa(cfg);
}

// Faxina depois de cada vídeo: pedaços e cortes velhos saem do disco, e
// replay que nenhum vídeo cobriu sai da fila
function arrumarACasa(cfg, agora = Date.now()) {
  try {
    apagarAntigos(cfg.pasta, cfg.retencaoDias, new Date(agora));
    const pastaCortes = path.join(cfg.pasta, 'cortes');
    for (const nome of fs.existsSync(pastaCortes) ? fs.readdirSync(pastaCortes) : []) {
      const caminho = path.join(pastaCortes, nome);
      if (fs.statSync(caminho).mtimeMs < agora - cfg.retencaoDias * DIA_MS) fs.rmSync(caminho, { recursive: true, force: true });
    }
    repo.expirarReplays(agora - cfg.retencaoDias * DIA_MS);
  } catch (err) {
    console.warn(`[video] faxina falhou: ${err.message}`);
  }
}

module.exports = { processarVideo, nomeDoCorte };
