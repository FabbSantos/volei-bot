// Corta um intervalo da gravação: junta os pedaços que cobrem o horário e
// apara as pontas, sem recomprimir (-c copy) — rápido mesmo pra uma hora de
// jogo. O começo cai no quadro-chave mais próximo, então pode vir uns
// segundos antes do pedido; pra vídeo de jogo não faz diferença.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pedacosDoIntervalo } = require('./pedacos');

const doisDigitos = (n) => String(n).padStart(2, '0');
const carimbo = (d) =>
  `${d.getFullYear()}-${doisDigitos(d.getMonth() + 1)}-${doisDigitos(d.getDate())}_${doisDigitos(d.getHours())}-${doisDigitos(d.getMinutes())}`;

function rodarFfmpeg(ffmpeg, args) {
  return new Promise((resolve, reject) => {
    const processo = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let erro = '';
    processo.stderr.on('data', (d) => { erro += d; });
    processo.on('error', (err) => reject(err.code === 'ENOENT'
      ? new Error(`não achei o ffmpeg em "${ffmpeg}" — instala ou aponta FFMPEG_PATH`)
      : err));
    processo.on('exit', (codigo) => (codigo === 0
      ? resolve()
      : reject(new Error(`ffmpeg saiu com código ${codigo}: ${erro.trim().split('\n').slice(-3).join(' | ')}`))));
  });
}

// Devolve { arquivo, inicio, fim, segundos, cortadoNoInicio, cortadoNoFim }
// ou { erro: 'sem_gravacao' } quando a câmera não pegou nada do intervalo.
async function cortar(cfg, inicio, fim) {
  const pedacos = pedacosDoIntervalo(cfg.pasta, inicio, fim);
  if (pedacos.length === 0) return { erro: 'sem_gravacao' };

  // O intervalo real é o pedido aparado pelo que foi gravado de fato
  const primeiro = pedacos[0];
  const ultimo = pedacos[pedacos.length - 1];
  const inicioReal = new Date(Math.max(inicio, primeiro.inicio));
  const fimReal = new Date(Math.min(fim, ultimo.fim));
  const deslocamento = (inicioReal - primeiro.inicio) / 1000;
  const segundos = (fimReal - inicioReal) / 1000;

  const pastaCortes = path.join(cfg.pasta, 'cortes');
  fs.mkdirSync(pastaCortes, { recursive: true });
  const base = `corte_${carimbo(inicioReal)}_ate_${carimbo(fimReal).slice(11)}`;
  const arquivo = path.join(pastaCortes, `${base}.mp4`);

  // Lista pro concat do ffmpeg: aspas simples no caminho viram '\''
  const lista = path.join(pastaCortes, `${base}.txt`);
  fs.writeFileSync(lista, pedacos
    .map((p) => `file '${p.caminho.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
    .join('\n'));

  try {
    await rodarFfmpeg(cfg.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', deslocamento.toFixed(3),
      '-f', 'concat', '-safe', '0', '-i', lista,
      '-t', segundos.toFixed(3),
      '-c', 'copy',
      // O índice no começo do arquivo: o vídeo começa a tocar no celular
      // antes de terminar de baixar
      '-movflags', '+faststart',
      arquivo,
    ]);
  } finally {
    fs.rmSync(lista, { force: true });
  }

  return {
    arquivo,
    inicio: inicioReal,
    fim: fimReal,
    segundos,
    cortadoNoInicio: inicioReal > inicio,
    cortadoNoFim: fimReal < fim,
  };
}

module.exports = { cortar, rodarFfmpeg };
