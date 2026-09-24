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
const { listarPedacos, apagarAntigos, pedacosDoIntervalo, nomeDoInicio, inicioDoNome } = require('../src/modulos/video/pedacos');
const { importar, lerInicioInformado, caminhoDoFfprobe } = require('../src/modulos/video/importador');

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

console.log('\npedaços no disco (sem ffmpeg)');
{
  // Duas gravações separadas por uma semana: sexta 25/09 e sexta 02/10.
  // Arquivos vazios bastam — o listarPedacos só olha nome e mtime.
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'volei-pedacos-'));
  const criar = (inicio, fim) => {
    const caminho = path.join(pasta, nomeDoInicio(inicio));
    fs.writeFileSync(caminho, '');
    fs.utimesSync(caminho, fim, fim);
  };
  const s25 = (h, m) => new Date(2026, 8, 25, h, m);
  const s02 = (h, m) => new Date(2026, 9, 2, h, m);
  criar(s25(20, 0), s25(20, 5));
  criar(s25(20, 5), s25(20, 10)); // último da sexta 25
  criar(s02(20, 0), s02(20, 5));

  const lista = listarPedacos(pasta);
  caso('nome ↔ hora vai e volta igual', () =>
    assert.strictEqual(inicioDoNome(nomeDoInicio(s25(20, 7))).getTime(), s25(20, 7).getTime()));
  caso('o último pedaço de um dia termina quando parou de gravar, não no próximo jogo', () =>
    assert.strictEqual(lista[1].fim.getTime(), s25(20, 10).getTime(),
      `terminou em ${lista[1].fim.toLocaleString('pt-BR')} — a semana inteira virou "gravação"`));
  caso('pedido no meio da semana sem jogo não acha nada', () =>
    assert.strictEqual(pedacosDoIntervalo(pasta, new Date(2026, 8, 29, 20, 0), new Date(2026, 8, 29, 21, 0)).length, 0));
  caso('pedido na sexta seguinte acha só o pedaço dela', () => {
    const achados = pedacosDoIntervalo(pasta, s02(20, 1), s02(20, 3));
    assert.deepStrictEqual(achados.map((p) => p.nome), [nomeDoInicio(s02(20, 0))]);
  });

  // mtime torto (cópia que preservou data velha) não pode zerar o pedaço
  const torto = path.join(pasta, nomeDoInicio(s25(20, 0)));
  fs.utimesSync(torto, new Date(2020, 0, 1), new Date(2020, 0, 1));
  caso('mtime antes do próprio começo cai no começo do seguinte, como era', () =>
    assert.strictEqual(listarPedacos(pasta)[0].fim.getTime(), s25(20, 5).getTime()));
  fs.rmSync(pasta, { recursive: true, force: true });
}

console.log('\nimportação — leitura do início informado');
caso('"25/09 20h03"', () => assert.strictEqual(emTexto(lerInicioInformado('25/09 20h03', agora)), '25/9 20:03'));
caso('"sexta 20:03" = a última sexta', () => assert.strictEqual(emTexto(lerInicioInformado('sexta 20:03', agora)), '18/9 20:03'));
caso('só a hora = hoje', () => assert.strictEqual(emTexto(lerInicioInformado('20h', agora)), '23/9 20:00'));
caso('lixo devolve null em vez de chutar', () => assert.strictEqual(lerInicioInformado('ontem de noite', agora), null));
caso('ffprobe mora do lado do ffmpeg (Windows)', () =>
  assert.strictEqual(caminhoDoFfprobe('C:\\ffmpeg\\bin\\ffmpeg.exe'), path.join('C:\\ffmpeg\\bin', 'ffprobe.exe')));
caso('ffprobe do PATH continua sem pasta', () => assert.strictEqual(caminhoDoFfprobe('ffmpeg'), 'ffprobe'));

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

  await importacaoDeVerdade(ffmpeg);
}

// Um "vídeo de celular" de 20s, com a hora de início gravada no arquivo como
// o celular grava (UTC com Z), mais uma trilha de dados que o formato dos
// pedaços não aceita — igual às de GPS/metadado que os celulares põem.
async function importacaoDeVerdade(ffmpeg) {
  console.log('\nimportação de vídeo do celular (~20s de vídeo)');
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'volei-import-'));
  const celular = path.join(pasta, 'VID_20260925_200312.mp4');
  const inicioNoCelular = '2026-09-25T23:03:12.000000Z'; // 20:03:12 no Brasil
  const gerar = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=20:size=320x240:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
    '-c:v', 'libx264', '-g', '15', '-c:a', 'aac',
    '-metadata', `creation_time=${inicioNoCelular}`,
    celular,
  ], { encoding: 'utf8' });
  if (gerar.status !== 0) {
    caso('gerar o vídeo de teste', () => assert.fail(gerar.stderr));
    return;
  }

  const cfg = { pasta: path.join(pasta, 'gravacoes'), segundosPorPedaco: 5, ffmpeg };
  const r = await importar(cfg, celular);
  const esperado = new Date(inicioNoCelular);

  caso('lê a hora de início do próprio arquivo', () =>
    assert.strictEqual(r.inicio.getTime(), esperado.getTime()));
  caso('20s em pedaços de 5s dá 4 pedaços', () => assert.strictEqual(r.pedacos, 4));
  const pedacos = listarPedacos(cfg.pasta);
  caso('o primeiro pedaço tem a hora de início no nome', () =>
    assert.strictEqual(pedacos[0].nome, nomeDoInicio(esperado)));
  caso('o último pedaço termina no fim do vídeo, não na hora da importação', () => {
    const fimReal = esperado.getTime() + 20_000;
    assert.ok(Math.abs(pedacos.at(-1).fim.getTime() - fimReal) < 1500,
      `terminou em ${pedacos.at(-1).fim.toISOString()}, esperado ~${new Date(fimReal).toISOString()}`);
  });
  caso('não sobra pasta de trabalho pra trás', () =>
    assert.deepStrictEqual(fs.readdirSync(cfg.pasta).filter((n) => n.startsWith('.importando')), []));

  // O cortador de sempre, em cima do que veio do celular
  const corte = await cortar(cfg, new Date(esperado.getTime() + 6_000), new Date(esperado.getTime() + 14_000));
  const info = spawnSync(ffmpeg, ['-hide_banner', '-i', corte.arquivo], { encoding: 'utf8' }).stderr;
  const [, hh, mm, ss] = info.match(/Duration: (\d+):(\d+):([\d.]+)/) || [];
  const duracao = Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
  caso(`o cortar funciona igual no vídeo importado (8s ± 2s, saiu ${duracao}s)`, () =>
    assert.ok(Math.abs(duracao - 8) <= 2.1));

  // Hora informada na mão vence a do arquivo (o caso do Samsung com fuso torto)
  const outraPasta = { ...cfg, pasta: path.join(pasta, 'outra') };
  const forcado = new Date(2026, 8, 25, 21, 0, 0);
  const r2 = await importar(outraPasta, celular, { inicio: forcado });
  caso('--inicio corrige a hora quando o celular erra o fuso', () =>
    assert.strictEqual(listarPedacos(outraPasta.pasta)[0].nome, nomeDoInicio(forcado)));
  caso('com --inicio o resultado respeita a hora informada', () =>
    assert.strictEqual(r2.inicio.getTime(), forcado.getTime()));

  // Reimportar o mesmo vídeo substitui, não duplica
  await importar(cfg, celular);
  caso('reimportar substitui em vez de duplicar', () => assert.strictEqual(listarPedacos(cfg.pasta).length, 4));

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
