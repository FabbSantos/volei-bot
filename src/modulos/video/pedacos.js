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

// O caminho inverso: a hora vira o nome do arquivo (usado na importação)
const doisDigitos = (n) => String(n).padStart(2, '0');
function nomeDoInicio(d) {
  return `${d.getFullYear()}-${doisDigitos(d.getMonth() + 1)}-${doisDigitos(d.getDate())}` +
    `_${doisDigitos(d.getHours())}-${doisDigitos(d.getMinutes())}-${doisDigitos(d.getSeconds())}.ts`;
}

// Todos os pedaços, do mais antigo pro mais novo.
//
// O fim de cada pedaço é a última escrita no arquivo (mtime). Antes era "o
// começo do seguinte" — e entre duas gravações separadas (sexta e a sexta
// seguinte, ou o gravador desligado de madrugada) o último pedaço da primeira
// passava a "durar" a semana inteira: pedir um trecho no meio dessa semana
// devolvia vídeo errado em vez de "não gravou nada". O começo do seguinte
// ainda serve de teto, e é o fallback se o mtime vier estranho.
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
    const escrita = fs.statSync(p.caminho).mtime;
    if (!proximo) {
      p.fim = escrita;
      return;
    }
    // mtime antes do próprio começo (relógio torto, cópia estranha) não
    // serve: aí vale o começo do seguinte, como era antes
    const escritaValida = escrita > p.inicio && escrita < proximo.inicio;
    p.fim = escritaValida ? escrita : proximo.inicio;
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

module.exports = { MODELO_FFMPEG, inicioDoNome, nomeDoInicio, listarPedacos, pedacosDoIntervalo, apagarAntigos };
