// Os pedaços gravados no disco. O nome de cada arquivo é a hora em que ele
// começou (AAAA-MM-DD_HH-MM-SS.ts, no relógio da máquina que grava) — é isso
// que permite achar "o jogo das 20h" sem banco de dados nenhum.
const fs = require('fs');
const path = require('path');

const PADRAO = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.ts$/;
// O mesmo formato, do jeito que o ffmpeg escreve (-strftime)
const MODELO_FFMPEG = '%Y-%m-%d_%H-%M-%S.ts';

function inicioDoNome(nome) {
  const m = nome.match(PADRAO);
  if (!m) return null;
  const [, a, mes, d, h, mi, s] = m.map(Number);
  return new Date(a, mes - 1, d, h, mi, s);
}

// Todos os pedaços, do mais antigo pro mais novo. O fim de cada um é o
// começo do seguinte; o último (ainda sendo gravado) vai até a última escrita.
function listarPedacos(pasta) {
  let nomes;
  try {
    nomes = fs.readdirSync(pasta);
  } catch {
    return [];
  }
  const pedacos = nomes
    .map((nome) => ({ nome, caminho: path.join(pasta, nome), inicio: inicioDoNome(nome) }))
    .filter((p) => p.inicio)
    .sort((a, b) => a.inicio - b.inicio);

  pedacos.forEach((p, i) => {
    const proximo = pedacos[i + 1];
    p.fim = proximo ? proximo.inicio : fs.statSync(p.caminho).mtime;
  });
  return pedacos;
}

// Pedaços que têm pelo menos um pedaço do intervalo pedido
function pedacosDoIntervalo(pasta, inicio, fim) {
  return listarPedacos(pasta).filter((p) => p.inicio < fim && p.fim > inicio);
}

// Apaga o que passou do prazo. Nunca apaga o último pedaço: é o que está
// sendo gravado agora.
function apagarAntigos(pasta, retencaoDias, agora = new Date()) {
  const limite = agora.getTime() - retencaoDias * 24 * 60 * 60 * 1000;
  const pedacos = listarPedacos(pasta);
  let apagados = 0;
  for (const p of pedacos.slice(0, -1)) {
    if (p.fim.getTime() < limite) {
      try {
        fs.rmSync(p.caminho, { force: true });
        apagados++;
      } catch {}
    }
  }
  return apagados;
}

module.exports = { MODELO_FFMPEG, inicioDoNome, listarPedacos, pedacosDoIntervalo, apagarAntigos };
