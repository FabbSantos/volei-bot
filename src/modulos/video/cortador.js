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

// O ffprobe mora do lado do ffmpeg: "ffmpeg" vira "ffprobe", e
// "C:\ffmpeg\bin\ffmpeg.exe" vira "C:\ffmpeg\bin\ffprobe.exe". Âncora no
// começo do nome: sem ela, uma pasta chamada "ffmpeg" seria trocada no lugar.
function caminhoDoFfprobe(ffmpeg) {
  const nome = path.basename(ffmpeg).replace(/^ffmpeg/i, 'ffprobe');
  const pasta = path.dirname(ffmpeg);
  return pasta === '.' ? nome : path.join(pasta, nome);
}

function rodarFfprobe(ffprobe, args) {
  return new Promise((resolve, reject) => {
    const processo = spawn(ffprobe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let saida = '';
    processo.stdout.on('data', (d) => { saida += d; });
    processo.on('error', (err) => reject(err.code === 'ENOENT'
      ? new Error(`não achei o ffprobe em "${ffprobe}" — ele vem junto com o ffmpeg`)
      : err));
    processo.on('exit', () => resolve(saida.trim()));
  });
}

// Devolve { arquivo, inicio, fim, segundos, cortadoNoInicio, cortadoNoFim }
// ou { erro: 'sem_gravacao' } quando a câmera não pegou nada do intervalo.
const FOLGA_S = 3;

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

  // Dois passos: 1) junta os pedaços num arquivo só, sem cortar; 2) corta
  // esse arquivo com -ss/-t. Parece mais trabalhoso, mas é o único jeito que
  // corta DE VERDADE sem recomprimir. Cortar em volta do concat (-ss antes do
  // concat, ou inpoint/outpoint na lista) fazia o ffmpeg guardar tudo desde o
  // começo do pedaço de 5min e só marcar no MP4 "comece a tocar daqui": o
  // replay de 30s do jogo de 25/09/2026 saiu com 17.282 quadros (4min48s) e
  // 133 MB. O VLC respeitava a marca e parecia certo; outros players — e o
  // WhatsApp — podem mostrar os 5 minutos. Com o corte num arquivo só, o
  // mesmo trecho ficou com ~1.790 quadros e ~20 MB, começando num quadro-chave.
  const trabalho = fs.mkdtempSync(path.join(pastaCortes, '.cortando-'));
  try {
    let fonte = primeiro.caminho;
    if (pedacos.length > 1) {
      // Lista pro concat do ffmpeg: aspas simples no caminho viram '\''
      const lista = path.join(trabalho, 'lista.txt');
      fs.writeFileSync(lista, pedacos
        .map((p) => `file '${p.caminho.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
        .join('\n'));
      fonte = path.join(trabalho, 'junto.ts');
      await rodarFfmpeg(cfg.ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'concat', '-safe', '0', '-i', lista,
        '-c', 'copy', fonte,
      ]);
    }

    // Sem recomprimir, o corte só começa num quadro-chave, e o ffmpeg pula
    // até o PRÓXIMO depois do -ss. Pedindo FOLGA segundos antes, o quadro-chave
    // em que ele cai fica antes do ponto pedido (celular: 1 a cada 1-2s;
    // gravador: 1 a cada 2s). O fim continua exato: -t conta a partir do -ss.
    // Pra replay, uns segundos a mais antes da jogada não fazem mal; um a
    // menos pode cortar o saque.
    const folga = Math.min(FOLGA_S, deslocamento);
    await rodarFfmpeg(cfg.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', (deslocamento - folga).toFixed(3),
      '-i', fonte,
      '-t', (segundos + folga).toFixed(3),
      '-c', 'copy',
      // O índice no começo do arquivo: o vídeo começa a tocar no celular
      // antes de terminar de baixar
      '-movflags', '+faststart',
      arquivo,
    ]);
  } finally {
    fs.rmSync(trabalho, { recursive: true, force: true });
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

module.exports = { cortar, rodarFfmpeg, rodarFfprobe, caminhoDoFfprobe };
