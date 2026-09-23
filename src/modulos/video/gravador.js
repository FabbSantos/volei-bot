// Gravador contínuo: um ffmpeg ligado direto, salvando pedaços de N minutos
// com a hora no nome, e uma faxina que apaga o que passou da retenção.
// Se o ffmpeg cair (câmera reiniciou, Wi-Fi piscou), sobe de novo sozinho.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { montarFonte } = require('./fontes');
const { MODELO_FFMPEG, apagarAntigos } = require('./pedacos');

const ESPERA_BASE_MS = 5_000;
const ESPERA_MAX_MS = 60_000;
const FAXINA_MS = 60 * 60_000;

function argumentosDoFfmpeg(cfg) {
  const fonte = montarFonte(cfg);
  return [
    '-hide_banner', '-loglevel', 'warning',
    ...fonte.entrada,
    ...fonte.codec,
    // MPEG-TS e não MP4: se a luz cair no meio, o pedaço continua legível
    // (MP4 só fica válido depois de fechado)
    '-f', 'segment',
    '-segment_time', String(cfg.segundosPorPedaco),
    '-segment_format', 'mpegts',
    '-reset_timestamps', '1',
    '-strftime', '1',
    path.join(cfg.pasta, MODELO_FFMPEG),
  ];
}

function iniciarGravador(cfg, { log = console.log } = {}) {
  fs.mkdirSync(cfg.pasta, { recursive: true });
  const args = argumentosDoFfmpeg(cfg); // fonte inválida estoura aqui, antes de tudo

  let processo = null;
  let parando = false;
  let falhasSeguidas = 0;
  let religar = null;

  function abrir() {
    const abertoEm = Date.now();
    let ultimasLinhas = '';
    let jaReagendou = false;

    log(`[gravador] gravando de "${cfg.fonte}" em ${cfg.pasta} (pedaços de ${cfg.segundosPorPedaco}s)`);
    processo = spawn(cfg.ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    processo.stderr.on('data', (dados) => {
      ultimasLinhas = (ultimasLinhas + dados).split('\n').slice(-8).join('\n');
    });

    const caiu = (motivo) => {
      if (jaReagendou || parando) return;
      jaReagendou = true;
      // Ficou de pé um tempo antes de cair? Então é problema novo, não o mesmo
      if (Date.now() - abertoEm > 60_000) falhasSeguidas = 0;
      falhasSeguidas++;
      const espera = Math.min(ESPERA_BASE_MS * 2 ** (falhasSeguidas - 1), ESPERA_MAX_MS);
      log(`[gravador] ffmpeg parou (${motivo}) — religando em ${espera / 1000}s${ultimasLinhas.trim() ? `\n${ultimasLinhas.trim()}` : ''}`);
      religar = setTimeout(abrir, espera);
    };
    processo.on('error', (err) => caiu(err.code === 'ENOENT' ? `não achei o ffmpeg em "${cfg.ffmpeg}" — instala ou aponta FFMPEG_PATH` : err.message));
    processo.on('exit', (codigo) => caiu(`código ${codigo}`));
  }

  const faxina = () => {
    const apagados = apagarAntigos(cfg.pasta, cfg.retencaoDias);
    if (apagados > 0) log(`[gravador] ${apagados} pedaço(s) com mais de ${cfg.retencaoDias} dia(s) apagado(s)`);
  };
  faxina();
  const relogioFaxina = setInterval(faxina, FAXINA_MS);

  abrir();

  // Para com calma: "q" pede pro ffmpeg fechar o pedaço atual direito
  function parar() {
    parando = true;
    clearInterval(relogioFaxina);
    clearTimeout(religar);
    return new Promise((resolve) => {
      if (!processo || processo.exitCode !== null) return resolve();
      const matar = setTimeout(() => processo.kill(), 5_000);
      processo.once('exit', () => {
        clearTimeout(matar);
        resolve();
      });
      try {
        processo.stdin.write('q');
      } catch {
        processo.kill();
      }
    });
  }

  return { parar };
}

module.exports = { iniciarGravador, argumentosDoFfmpeg };
