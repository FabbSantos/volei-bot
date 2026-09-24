// Traz pra dentro um vídeo gravado por fora — o celular no tripé, com a câmera
// normal dele, sem app nem computador na quadra. O arquivo vira os mesmos
// pedaços com a hora no nome que o gravador gera, então `cortar` e `pedacos`
// funcionam igual pros dois.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { rodarFfmpeg } = require('./cortador');
const { nomeDoInicio } = require('./pedacos');
const { lerHora, lerDia } = require('./periodo');

// O ffprobe mora do lado do ffmpeg: "ffmpeg" vira "ffprobe", e
// "C:\ffmpeg\bin\ffmpeg.exe" vira "C:\ffmpeg\bin\ffprobe.exe"
function caminhoDoFfprobe(ffmpeg) {
  // Âncora no começo do nome do executável: sem ela, uma pasta chamada
  // "ffmpeg" no caminho poderia ser trocada no lugar do arquivo
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

// A hora em que o celular COMEÇOU a gravar, lida do próprio arquivo. O
// metadado vem em UTC com "Z" no fim; alguns Samsung gravam a hora local e
// ainda assim põem o "Z", o que dá 3h de diferença — por isso o comando
// mostra a hora achada e aceita --inicio pra corrigir.
async function detectarInicio(cfg, arquivo) {
  const bruto = await rodarFfprobe(caminhoDoFfprobe(cfg.ffmpeg), [
    '-v', 'quiet',
    '-show_entries', 'format_tags=creation_time',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    arquivo,
  ]);
  if (!bruto) return null;
  const data = new Date(bruto);
  return Number.isNaN(data.getTime()) ? null : data;
}

// "--inicio 25/09 20h03", "sexta 20:03", "hoje 20h" → Date. Usa o mesmo
// leitor de dia e hora do cortar, então vale tudo que ele aceita.
function lerInicioInformado(texto, agora = new Date()) {
  const partes = String(texto || '').trim().split(/\s+/);
  const hora = lerHora(partes.pop() || '');
  const dia = lerDia(partes.join(' '), agora);
  if (!hora || !dia) return null;
  return new Date(dia.getFullYear(), dia.getMonth(), dia.getDate(), hora.h, hora.m);
}

// Devolve { pedacos, inicio, fim } ou lança erro com frase pronta
async function importar(cfg, arquivo, { inicio } = {}) {
  if (!fs.existsSync(arquivo)) throw new Error(`não achei o arquivo ${arquivo}`);

  const comeco = inicio || await detectarInicio(cfg, arquivo);
  if (!comeco) {
    throw new Error('o arquivo não diz quando começou a gravar. Informe na mão: --inicio "25/09 20h03"');
  }

  fs.mkdirSync(cfg.pasta, { recursive: true });
  // Pasta de trabalho DENTRO da pasta de gravações: renomear pro lugar final
  // é instantâneo (mesmo disco), e o ponto no nome faz o listarPedacos
  // ignorá-la se a importação cair no meio
  const trabalho = fs.mkdtempSync(path.join(cfg.pasta, '.importando-'));
  const lista = path.join(trabalho, 'lista.csv');

  try {
    await rodarFfmpeg(cfg.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', arquivo,
      // Só o vídeo e o áudio: celular grava trilhas extras (GPS, metadado
      // da Samsung/Apple) que o formato dos pedaços não carrega
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c', 'copy',
      '-f', 'segment',
      '-segment_time', String(cfg.segundosPorPedaco),
      '-segment_format', 'mpegts',
      '-reset_timestamps', '1',
      // A lista diz onde cada pedaço começa e termina DE VERDADE (o corte cai
      // no quadro-chave, então não é exatamente múltiplo de 5min)
      '-segment_list', lista,
      '-segment_list_type', 'csv',
      path.join(trabalho, '%05d.ts'),
    ]);

    const linhas = fs.readFileSync(lista, 'utf8').trim().split('\n').filter(Boolean);
    let fimGeral = comeco;
    for (const linha of linhas) {
      const [nome, deIni, deFim] = linha.split(',');
      const ini = new Date(comeco.getTime() + parseFloat(deIni) * 1000);
      const fim = new Date(comeco.getTime() + parseFloat(deFim) * 1000);
      const destino = path.join(cfg.pasta, nomeDoInicio(ini));
      fs.rmSync(destino, { force: true }); // reimportar o mesmo vídeo substitui
      fs.renameSync(path.join(trabalho, nome), destino);
      // A "última escrita" do pedaço é o fim dele no jogo, não a hora da
      // importação — é assim que o listarPedacos sabe onde cada um termina
      fs.utimesSync(destino, fim, fim);
      if (fim > fimGeral) fimGeral = fim;
    }
    return { pedacos: linhas.length, inicio: comeco, fim: fimGeral };
  } finally {
    fs.rmSync(trabalho, { recursive: true, force: true });
  }
}

module.exports = { importar, detectarInicio, lerInicioInformado, caminhoDoFfprobe };
