// Fluxo inteiro do #replay, com ffmpeg de verdade: o vídeo sobe pela API do
// painel em pedaços (com uma "queda" no meio), é importado no processo de
// vídeo (fuso de Brasília), e o replay pedido naquele horário sai cortado pro
// chat de onde veio. Sem ffmpeg, é pulado com aviso — como o test/video.js.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'volei-replay-'));
process.env.DB_PATH = path.join(pasta, 'teste.db');
process.env.VIDEO_PASTA = path.join(pasta, 'videos', 'gravacoes');
process.env.VIDEO_SEGUNDOS = '5';
process.env.PAINEL_TOKEN = 'token-de-teste';
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';

const express = require('express');
const repo = require('../src/modulos/video/repositorio');
const grupos = require('../src/modulos/grupos/repositorio');
const { registrarPainel } = require('../src/http/painel');
const { caminhoDoFfprobe } = require('../src/modulos/video/cortador');
const { fecharBanco } = require('../src/nucleo/banco');

let falhas = 0;
function caso(nome, fn) {
  try {
    fn();
    console.log(`  ok  ${nome}`);
  } catch (err) {
    falhas++;
    console.log(`  FALHOU  ${nome}\n          ${err.message}`);
  }
}

// "VID20260925211316" no relógio de Brasília, rode o teste onde rodar
function carimboEmBrasilia(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}${p.hour}${p.minute}${p.second}`;
}

function pedir(porta, metodo, caminho, corpo, cabecalhos = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: porta, method: metodo, path: caminho,
      headers: { 'x-painel-token': 'token-de-teste', ...cabecalhos },
    }, (res) => {
      let dados = '';
      res.on('data', (d) => { dados += d; });
      res.on('end', () => resolve({ status: res.statusCode, corpo: dados ? JSON.parse(dados) : null }));
    });
    req.on('error', reject);
    if (corpo) req.write(corpo);
    req.end();
  });
}

async function principal() {
  if (spawnSync(ffmpeg, ['-version']).status !== 0) {
    console.log(`\n⚠️  ffmpeg não encontrado ("${ffmpeg}") — teste do replay pulado`);
    return;
  }
  console.log('\nreplay de ponta a ponta (~20s de vídeo)');

  // Um "jogo" de 20s gravado com o celular de cabeça pra baixo
  const inicio = Math.floor(Date.now() / 1000) * 1000 - 3_600_000;
  const cru = path.join(pasta, 'cru.mp4');
  const celular = path.join(pasta, `VID${carimboEmBrasilia(inicio)}.mp4`);
  spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=20:size=320x240:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
    '-c:v', 'libx264', '-g', '15', '-c:a', 'aac', cru]);
  // ffmpeg 6.1+: -display_rotation; o 5.1 da VPS só tem a tag "rotate"
  const girar = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-display_rotation', '180', '-i', cru, '-c', 'copy', celular]);
  if (girar.status !== 0) {
    spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', cru, '-c', 'copy', '-metadata:s:v:0', 'rotate=180', celular]);
  }

  // Grupo de admins recebe o resumo; os replays voltam pro chat de origem
  grupos.registrarGrupoSeNovo('adm@g.us', 'Admins');
  grupos.marcarGrupoAdmin('adm@g.us', true);
  const dentro = repo.registrarReplay({ chatId: 'adm@g.us', autor: 'Fabricio', momento: inicio + 12_000, segundos: 5 });
  const antes = repo.registrarReplay({ chatId: 'adm@g.us', autor: 'Diego', momento: inicio - 3_600_000, segundos: 30 });

  const enviados = [];
  const textos = [];
  const app = express();
  registrarPainel(app, {
    enviarPara: async (chatId, texto) => { textos.push({ chatId, texto }); },
    enviarArquivoPara: async (chatId, caminho, legenda) => {
      enviados.push({ chatId, caminho, legenda, existia: fs.existsSync(caminho) });
    },
  });
  const servidor = app.listen(0);
  const porta = servidor.address().port;

  try {
    const conteudo = fs.readFileSync(celular);
    const id = `${conteudo.length}-1-${path.basename(celular)}`;
    const base = `/api/video/envio/${encodeURIComponent(id)}`;
    const octeto = { 'content-type': 'application/octet-stream' };

    const r0 = await pedir(porta, 'GET', `${base}?tamanho=${conteudo.length}`);
    caso('começa do zero', () => assert.deepStrictEqual(r0.corpo, { recebido: 0 }));

    const corte1 = Math.floor(conteudo.length / 3);
    await pedir(porta, 'PUT', base, conteudo.subarray(0, corte1), { ...octeto, 'x-offset': '0' });
    // A "queda": o celular reenvia o mesmo pedaço, sem saber que tinha chegado
    const repetido = await pedir(porta, 'PUT', base, conteudo.subarray(0, corte1), { ...octeto, 'x-offset': '0' });
    caso('pedaço repetido não é gravado duas vezes, só diz onde parou', () => {
      assert.strictEqual(repetido.status, 409);
      assert.strictEqual(repetido.corpo.recebido, corte1);
    });
    const retomada = await pedir(porta, 'GET', base);
    caso('perguntar "quanto chegou?" devolve de onde continuar', () => assert.strictEqual(retomada.corpo.recebido, corte1));
    await pedir(porta, 'PUT', base, conteudo.subarray(corte1), { ...octeto, 'x-offset': String(corte1) });

    const cedo = await pedir(porta, 'POST', `${base}/concluir`, JSON.stringify({ nome: 'x.mp4', tamanho: conteudo.length + 1 }), { 'content-type': 'application/json' });
    caso('não conclui se o tamanho não bate', () => assert.strictEqual(cedo.status, 409));

    const fim = await pedir(porta, 'POST', `${base}/concluir`,
      JSON.stringify({ nome: path.basename(celular), tamanho: conteudo.length }), { 'content-type': 'application/json' });
    caso('conclui o envio', () => assert.strictEqual(fim.status, 200));

    // Espera o processamento (importar + cortar), que roda em segundo plano
    const limite = Date.now() + 90_000;
    let video;
    do {
      await new Promise((r) => setTimeout(r, 300));
      video = repo.getVideo(fim.corpo.video.id);
    } while (video.status === 'processando' && Date.now() < limite);

    caso(`o vídeo termina pronto (${video.status}${video.erro ? `: ${video.erro}` : ''})`, () => assert.strictEqual(video.status, 'pronto'));
    caso('o horário do vídeo vem do nome, no fuso de Brasília', () => assert.strictEqual(video.inicio, inicio));
    caso('corta só o replay que cai dentro do vídeo', () => assert.strictEqual(enviados.length, 1));
    caso('e manda pro chat de onde veio, com legenda', () => {
      assert.strictEqual(enviados[0].chatId, 'adm@g.us');
      assert.match(enviados[0].legenda, /Replay de .* 5s · pedido por Fabricio/);
      assert.ok(enviados[0].existia);
    });
    caso('o replay fica marcado como enviado, o de fora continua esperando', () => {
      assert.strictEqual(repo.replaysDoVideo(video.id)[0].id, dentro.id);
      assert.strictEqual(repo.replaysDoVideo(video.id)[0].status, 'enviado');
      assert.deepStrictEqual(repo.listarReplaysPendentes().map((r) => r.id), [antes.id]);
    });
    caso('o grupo de admins recebe o resumo', () =>
      assert.ok(textos.some((t) => t.chatId === 'adm@g.us' && /importado[\s\S]*1 replay/.test(t.texto)), JSON.stringify(textos)));

    const probe = spawnSync(caminhoDoFfprobe(ffmpeg), ['-v', 'quiet', '-select_streams', 'v:0',
      '-show_entries', 'stream_side_data=rotation:format=duration', '-of', 'default=noprint_wrappers=1', enviados[0].caminho], { encoding: 'utf8' }).stdout;
    const duracao = Number((probe.match(/duration=([\d.]+)/) || [])[1]);
    caso(`o corte tem o tamanho pedido (5s + folga: ${duracao}s)`, () => assert.ok(duracao >= 4.9 && duracao <= 8.6));
    caso('e continua de cabeça pra cima', () => assert.match(probe, /rotation=-?180/));

    const entrada = path.join(pasta, 'videos', 'entrada');
    caso('o original não fica ocupando disco', () => assert.deepStrictEqual(fs.readdirSync(entrada), []));

    const baixar = await new Promise((resolve) => http.get({
      host: '127.0.0.1', port: porta, path: `/api/video/corte/${encodeURIComponent(path.basename(enviados[0].caminho))}`,
      headers: { 'x-painel-token': 'token-de-teste' },
    }, (res) => { res.resume(); resolve(res.statusCode); }));
    caso('o corte dá pra baixar pelo painel', () => assert.strictEqual(baixar, 200));
    const escapar = await pedir(porta, 'GET', `/api/video/corte/${encodeURIComponent('../../teste.db')}`);
    caso('e o download não sai da pasta de cortes', () => assert.strictEqual(escapar.status, 404));
  } finally {
    servidor.close();
  }
}

principal()
  .catch((err) => {
    falhas++;
    console.log(`  FALHOU  ${err.stack}`);
  })
  .finally(() => {
    fecharBanco();
    fs.rmSync(pasta, { recursive: true, force: true });
    console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo ok');
    process.exit(falhas ? 1 : 0);
  });
