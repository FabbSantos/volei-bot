// Traz pra dentro um vídeo gravado por fora — o celular no tripé, com a câmera
// normal dele, sem app nem computador na quadra. O arquivo vira os mesmos
// pedaços com a hora no nome que o gravador gera, então `cortar` e `pedacos`
// funcionam igual pros dois.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { rodarFfmpeg, rodarFfprobe, caminhoDoFfprobe } = require('./cortador');
const { nomeDoInicio, escreverRotacao } = require('./pedacos');
const { lerHora, lerDia } = require('./periodo');

// A hora de início escrita no NOME do arquivo pela câmera do celular. É a
// fonte mais confiável: o metadado creation_time varia de fabricante pra
// fabricante (o Realme do Fabrício grava a hora do FIM ali — descoberto com o
// vídeo do jogo de 25/09/2026, que teria saído 2h56 deslocado).
//   VID20260925211316.mp4       Realme/OPPO — hora local
//   VID_20260925_211316.mp4     Android genérico — hora local
//   20260925_211316.mp4         Samsung — hora local
//   PXL_20260925_001316123.mp4  Google Pixel — UTC
function inicioPeloNome(arquivo) {
  const nome = path.basename(arquivo);
  const m = nome.match(/(?:^|[^\d])(\d{4})(\d{2})(\d{2})_?(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, a, mes, d, h, mi, s] = m.map(Number);
  if (mes < 1 || mes > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const data = /^PXL_/i.test(nome)
    ? new Date(Date.UTC(a, mes - 1, d, h, mi, s))
    : new Date(a, mes - 1, d, h, mi, s);
  return Number.isNaN(data.getTime()) ? null : data;
}

// O que o arquivo diz sobre si mesmo: creation_time, duração e rotação.
// Rotação: celular não gira os pixels — grava de um jeito e anota "gire X°
// ao mostrar". O MPEG-TS dos pedaços não tem onde guardar essa anotação, e o
// jogo de 25/09/2026 (celular de cabeça pra baixo no tripé, rotation=-180)
// saiu com todos os cortes de ponta-cabeça.
async function lerMetadados(cfg, arquivo) {
  const bruto = await rodarFfprobe(caminhoDoFfprobe(cfg.ffmpeg), [
    '-v', 'quiet',
    '-select_streams', 'v:0',
    '-show_entries', 'format=duration:format_tags=creation_time:stream_side_data=rotation',
    '-of', 'default=noprint_wrappers=1',
    arquivo,
  ]);
  const campo = (nome) => (bruto.match(new RegExp(`^${nome}=(.+)$`, 'm')) || [])[1]?.trim();
  const criacao = campo('TAG:creation_time') ? new Date(campo('TAG:creation_time')) : null;
  const duracao = parseFloat(campo('duration'));
  const rotacao = parseFloat(campo('rotation'));
  return {
    criacao: criacao && !Number.isNaN(criacao.getTime()) ? criacao : null,
    duracaoS: Number.isFinite(duracao) ? duracao : null,
    rotacao: Number.isFinite(rotacao) && rotacao % 360 !== 0 ? rotacao : null,
  };
}

// A hora em que o celular COMEÇOU a gravar. Devolve { inicio, fonte, aviso }.
// Nome do arquivo primeiro; o metadado só é usado quando não tem nome com
// hora, e mesmo assim é conferido: se creation_time bater com "nome + duração",
// este celular grava o FIM no metadado — vale avisar, porque é o erro que
// desloca todos os cortes.
async function detectarInicio(cfg, arquivo) {
  const pelo = inicioPeloNome(arquivo);
  const { criacao, duracaoS } = await lerMetadados(cfg, arquivo);
  const TOLERANCIA_MS = 15_000;

  if (pelo) {
    let aviso = null;
    if (criacao && duracaoS != null) {
      const fimPeloNome = pelo.getTime() + duracaoS * 1000;
      if (Math.abs(criacao - fimPeloNome) <= TOLERANCIA_MS) {
        aviso = 'este celular grava a hora do FIM no metadado — usei a hora do nome do arquivo';
      } else if (Math.abs(criacao - pelo) > TOLERANCIA_MS) {
        const difMin = Math.round((criacao - pelo) / 60_000);
        aviso = `o metadado discorda do nome do arquivo em ${difMin} min — usei a hora do nome`;
      }
    }
    return { inicio: pelo, fonte: 'nome do arquivo', aviso };
  }

  if (!criacao) return { inicio: null };
  return {
    inicio: criacao,
    fonte: 'metadado do arquivo',
    aviso: 'sem hora no nome do arquivo: alguns celulares gravam no metadado a hora do FIM ou o fuso errado — confira',
  };
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

  const detectado = inicio ? { inicio, fonte: 'informado' } : await detectarInicio(cfg, arquivo);
  const comeco = detectado.inicio;
  if (!comeco) {
    throw new Error('o arquivo não diz quando começou a gravar. Informe na mão: --inicio "25/09 20h03"');
  }

  const { rotacao } = await lerMetadados(cfg, arquivo);

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
      // A rotação que o MPEG-TS não guarda vai num arquivinho do lado
      escreverRotacao(destino, rotacao);
      // A "última escrita" do pedaço é o fim dele no jogo, não a hora da
      // importação — é assim que o listarPedacos sabe onde cada um termina
      fs.utimesSync(destino, fim, fim);
      if (fim > fimGeral) fimGeral = fim;
    }
    return { pedacos: linhas.length, inicio: comeco, fim: fimGeral, fonte: detectado.fonte, aviso: detectado.aviso || null, rotacao };
  } finally {
    fs.rmSync(trabalho, { recursive: true, force: true });
  }
}

module.exports = { importar, detectarInicio, inicioPeloNome, lerInicioInformado, caminhoDoFfprobe };
