// Testes do vídeo.
//   1. leitura de horários ("sexta 20h-21h" etc.) — sempre roda
//   2. gravar e cortar de verdade com a fonte sintética — precisa de ffmpeg
//      (FFMPEG_PATH ou "ffmpeg" no PATH); sem ele, é pulado com aviso
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { lerPeriodo } = require('../src/modulos/video/periodo');
const { iniciarGravador } = require('../src/modulos/video/gravador');
const { cortar } = require('../src/modulos/video/cortador');
const { listarPedacos, apagarAntigos } = require('../src/modulos/video/pedacos');

let falhas = 0;
function caso(nome, fn) {
  try {
    fn();
    console.log(`  ok  ${nome}`);
  } catch (err) {
    falhas++;
    console.log(`  FALHOU  ${nome}\n        ${err.message}`);
  }
}
const emTexto = (d) => `${d.getDate()}/${d.getMonth() + 1} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

console.log('horários');
// Quarta, 23/09/2026, 22h
const agora = new Date(2026, 8, 23, 22, 0);
const periodo = (t) => {
  const r = lerPeriodo(t, agora);
  return r.erro ? r.erro : `${emTexto(r.inicio)} - ${emTexto(r.fim)}`;
};
caso('hoje', () => assert.strictEqual(periodo('hoje 20h-21h'), '23/9 20:00 - 23/9 21:00'));
caso('sem dia = hoje, com minutos', () => assert.strictEqual(periodo('20h30-21h15'), '23/9 20:30 - 23/9 21:15'));
caso('formato 20:30', () => assert.strictEqual(periodo('hoje 20:30-21:00'), '23/9 20:30 - 23/9 21:00'));
caso('ontem', () => assert.strictEqual(periodo('ontem 19h-20h'), '22/9 19:00 - 22/9 20:00'));
caso('sexta = a última que passou', () => assert.strictEqual(periodo('sexta 20h-21h'), '18/9 20:00 - 18/9 21:00'));
caso('sexta-feira com acento e caixa', () => assert.strictEqual(periodo('Sexta-Feira 20h-21h'), '18/9 20:00 - 18/9 21:00'));
caso('quarta num dia de quarta = hoje', () => assert.strictEqual(periodo('quarta 20h-21h'), '23/9 20:00 - 23/9 21:00'));
caso('sábado abreviado', () => assert.strictEqual(periodo('sáb 9h-11h'), '19/9 9:00 - 19/9 11:00'));
caso('data DD/MM', () => assert.strictEqual(periodo('18/09 20h-21h'), '18/9 20:00 - 18/9 21:00'));
caso('data no futuro vira ano passado', () => assert.strictEqual(periodo('28/12 20h-21h'), '28/12 20:00 - 28/12 21:00'));
caso('virando a meia-noite', () => assert.strictEqual(periodo('ontem 23h-1h'), '22/9 23:00 - 23/9 1:00'));
caso('horário que não aconteceu', () => assert.match(periodo('hoje 23h-23h30'), /ainda não aconteceu/));
caso('horário ilegível', () => assert.match(periodo('sexta às 20'), /Não entendi o horário/));
caso('dia ilegível', () => assert.match(periodo('amanhã 20h-21h'), /Não entendi o dia/));
caso('31/02 não existe', () => assert.match(periodo('31/02 20h-21h'), /Não entendi o dia/));

async function gravacaoDeVerdade() {
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  if (spawnSync(ffmpeg, ['-version']).error) {
    console.log(`\ngravação — PULADO (sem ffmpeg em "${ffmpeg}"; aponte FFMPEG_PATH pra rodar)`);
    return;
  }
  console.log('\ngravação (fonte sintética, ~25s)');
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'volei-video-'));
  const cfg = { fonte: 'teste', pasta, segundosPorPedaco: 6, retencaoDias: 7, ffmpeg };
  const logs = [];
  const gravador = iniciarGravador(cfg, { log: (l) => logs.push(l) });
  const comeco = new Date();
  await new Promise((r) => setTimeout(r, 22_000));
  await gravador.parar();

  const pedacos = listarPedacos(pasta);
  caso('gravou vários pedaços com a hora no nome', () => assert.ok(pedacos.length >= 3, `só ${pedacos.length} pedaço(s); logs: ${logs.join(' / ')}`));

  // Um corte de 8s atravessando a fronteira entre dois pedaços
  const inicio = new Date(pedacos[1].inicio.getTime() - 3000);
  const fim = new Date(inicio.getTime() + 8000);
  const r = await cortar(cfg, inicio, fim);
  caso('o corte gera um MP4', () => assert.ok(r.arquivo && fs.statSync(r.arquivo).size > 10_000));
  const info = spawnSync(ffmpeg, ['-hide_banner', '-i', r.arquivo], { encoding: 'utf8' }).stderr;
  const [, hh, mm, ss] = info.match(/Duration: (\d+):(\d+):([\d.]+)/) || [];
  const duracao = Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
  // quadro-chave a cada 2s: o começo pode voltar até 2s
  caso(`o corte dura o pedido (8s ± 2s, saiu ${duracao}s)`, () => assert.ok(Math.abs(duracao - 8) <= 2.1));

  const antes = new Date(comeco.getTime() - 3_600_000);
  const nada = await cortar(cfg, antes, new Date(antes.getTime() + 60_000));
  caso('horário sem gravação avisa em vez de gerar vídeo vazio', () => assert.strictEqual(nada.erro, 'sem_gravacao'));

  // Retenção: com prazo zero, só o último pedaço (o "atual") sobrevive
  apagarAntigos(pasta, 0, new Date(Date.now() + 60_000));
  caso('a faxina apaga os velhos e preserva o último', () => assert.strictEqual(listarPedacos(pasta).length, 1));

  fs.rmSync(pasta, { recursive: true, force: true });
}

gravacaoDeVerdade()
  .catch((err) => {
    falhas++;
    console.log(`  FALHOU  ${err.stack}`);
  })
  .finally(() => {
    console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo ok');
    process.exit(falhas ? 1 : 0);
  });
