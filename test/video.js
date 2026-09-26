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
const { importar, lerInicioInformado, caminhoDoFfprobe, inicioPeloNome } = require('../src/modulos/video/importador');

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
// Caminho montado com o separador do sistema onde o teste roda — um caminho
// do Windows não faz sentido no Linux, onde a barra invertida não é pasta.
// A pasta se chama "ffmpeg" de propósito: só o executável pode ser trocado.
caso('ffprobe mora do lado do ffmpeg, mesmo com pasta chamada ffmpeg', () => {
  const pasta = path.join(os.tmpdir(), 'ffmpeg', 'bin');
  assert.strictEqual(caminhoDoFfprobe(path.join(pasta, 'ffmpeg.exe')), path.join(pasta, 'ffprobe.exe'));
});
caso('ffprobe do PATH continua sem pasta', () => assert.strictEqual(caminhoDoFfprobe('ffmpeg'), 'ffprobe'));

console.log('\nimportação — hora de início pelo nome do arquivo');
const local = (a, m, d, h, mi, s) => new Date(a, m - 1, d, h, mi, s).getTime();
caso('Realme: VID20260925211316.mp4', () =>
  assert.strictEqual(inicioPeloNome('C:/x/VID20260925211316.mp4')?.getTime(), local(2026, 9, 25, 21, 13, 16)));
caso('Android genérico: VID_20260925_211316.mp4', () =>
  assert.strictEqual(inicioPeloNome('VID_20260925_211316.mp4')?.getTime(), local(2026, 9, 25, 21, 13, 16)));
caso('Samsung: 20240712_140535.mp4', () =>
  assert.strictEqual(inicioPeloNome('20240712_140535.mp4')?.getTime(), local(2024, 7, 12, 14, 5, 35)));
caso('Pixel usa UTC no nome', () =>
  assert.strictEqual(inicioPeloNome('PXL_20260926_001316123.mp4')?.getTime(), Date.UTC(2026, 8, 26, 0, 13, 16)));
caso('iPhone (IMG_1234.MOV) não tem hora no nome', () => assert.strictEqual(inicioPeloNome('IMG_1234.MOV'), null));
caso('número que não é data não vira data', () => assert.strictEqual(inicioPeloNome('VID20261399999999.mp4'), null));

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

  // Um corte de 8s atravessando a fronteira entre dois pedaços. Do 2º pro 3º,
  // e não do 1º: o PRIMEIRO pedaço de cada gravação ao vivo nasce com o nome
  // ~2s antes do primeiro quadro (o arquivo abre antes do ffmpeg esquentar),
  // então o horário dele é aproximado. Isso é limitação do gravador, não do
  // cortador — e não afeta vídeo importado do celular.
  const inicio = new Date(pedacos[2].inicio.getTime() - 3000);
  const fim = new Date(inicio.getTime() + 8000);
  const r = await cortar(cfg, inicio, fim);
  caso('o corte gera um MP4', () => assert.ok(r.arquivo && fs.statSync(r.arquivo).size > 10_000));
  const d = duracoes(ffmpeg, r.arquivo);
  // quadro-chave a cada 2s: o começo pode voltar até 2s
  // Pode vir até 3s (a folga) a MAIS no começo, nunca a menos — perder o
  // começo da jogada é o erro ruim
  caso(`o corte cobre o pedido e nunca começa depois (8s a 11s + arredondamento, declarado ${d.declarada}s)`, () =>
    assert.ok(d.declarada >= 7.9 && d.declarada <= 11.5));
  caso(`e não esconde nada: guarda o que declara (${d.guardada}s guardados × ${d.declarada}s declarados)`, () =>
    assert.ok(d.guardada <= d.declarada + 0.5));

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
// Duas medidas de duração, porque elas podem discordar e já discordaram:
// (só o lado de guardar A MAIS é bug: celular à noite pula quadros e grava
// a menos que os 60/s nominais — o jogo de 25/09 teve até 0,9s a menos em 33s)
// "declarada" é o que o MP4 diz (respeita a marca de "comece a tocar daqui");
// "guardada" é quantos quadros existem de fato no arquivo ÷ quadros por
// segundo. O bug do corte (25/09/2026) declarava 30s e guardava 4min48s — um
// teste que só olhasse a declarada passava enganado, e passou.
function duracoes(ffmpeg, arquivo) {
  const ffprobe = caminhoDoFfprobe(ffmpeg);
  const r = spawnSync(ffprobe, [
    '-v', 'quiet', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_frames,r_frame_rate:format=duration',
    '-of', 'default=noprint_wrappers=1', arquivo,
  ], { encoding: 'utf8' }).stdout;
  const quadros = Number((r.match(/nb_frames=(\d+)/) || [])[1]);
  const [n, dv] = ((r.match(/r_frame_rate=(\d+)\/(\d+)/) || []).slice(1)).map(Number);
  const declarada = Number((r.match(/duration=([\d.]+)/) || [])[1]);
  return { declarada: Math.round(declarada * 100) / 100, guardada: Math.round((quadros / (n / dv)) * 100) / 100 };
}

// Gera um "vídeo de celular" de 20s com o nome e o metadado que a gente quiser
function gerarVideo(ffmpeg, arquivo, creationTime) {
  return spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=20:size=320x240:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
    '-c:v', 'libx264', '-g', '15', '-c:a', 'aac',
    '-metadata', `creation_time=${creationTime}`,
    arquivo,
  ], { encoding: 'utf8' });
}

// Anota "gire X° ao mostrar", como o celular faz. ffmpeg 6.1+ tem
// -display_rotation; o 5.1 do Debian (o da VPS) só a tag "rotate"
function girarVideo(ffmpeg, origem, destino, graus) {
  const base = ['-hide_banner', '-loglevel', 'error', '-y'];
  const r = spawnSync(ffmpeg, [...base, '-display_rotation', String(graus), '-i', origem, '-c', 'copy', destino]);
  if (r.status === 0) return;
  spawnSync(ffmpeg, [...base, '-i', origem, '-c', 'copy', '-metadata:s:v:0', `rotate=${((graus % 360) + 360) % 360}`, destino]);
}

const carimboDoCelular = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]
  .map((n, i) => String(n).padStart(i ? 2 : 4, '0')).join('');

async function importacaoDeVerdade(ffmpeg) {
  console.log('\nimportação de vídeo do celular (~20s de vídeo)');
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'volei-import-'));
  // O caso real do Realme (jogo de 25/09/2026): o NOME tem a hora de início
  // no horário local, e o metadado tem a hora do FIM. Montado no fuso da
  // máquina que roda o teste, pra valer no Windows do Fabrício e no Linux.
  const esperado = new Date(2026, 8, 25, 20, 3, 12);
  const celular = path.join(pasta, `VID${carimboDoCelular(esperado)}.mp4`);
  const fimNoMetadado = new Date(esperado.getTime() + 20_000).toISOString();
  const gerar = gerarVideo(ffmpeg, celular, fimNoMetadado);
  if (gerar.status !== 0) {
    caso('gerar o vídeo de teste', () => assert.fail(gerar.stderr));
    return;
  }

  const cfg = { pasta: path.join(pasta, 'gravacoes'), segundosPorPedaco: 5, ffmpeg };
  const r = await importar(cfg, celular);

  caso('Realme: usa a hora do NOME, não a do metadado (que é o fim)', () =>
    assert.strictEqual(r.inicio.getTime(), esperado.getTime(),
      `pegou ${r.inicio.toLocaleString('pt-BR')} — com o metadado, sairia 20s deslocado`));
  caso('e avisa que este celular grava o fim no metadado', () =>
    assert.match(r.aviso || '', /FIM/, `aviso: ${r.aviso}`));

  // Sem hora no nome (tipo iPhone), cai pro metadado — e avisa pra conferir
  const semHora = path.join(pasta, 'IMG_0001.mp4');
  gerarVideo(ffmpeg, semHora, esperado.toISOString());
  const pastaIphone = { ...cfg, pasta: path.join(pasta, 'iphone') };
  const rIphone = await importar(pastaIphone, semHora);
  caso('sem hora no nome, usa o metadado', () => assert.strictEqual(rIphone.inicio.getTime(), esperado.getTime()));
  caso('e pede pra conferir', () => assert.match(rIphone.aviso || '', /confira/));
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

  // O cortador de sempre, em cima do que veio do celular. Começa a 3s de um
  // pedaço de 5s: com o bug antigo, guardaria 11s (3 escondidos + 8)
  const corte = await cortar(cfg, new Date(esperado.getTime() + 8_000), new Date(esperado.getTime() + 16_000));
  const d = duracoes(ffmpeg, corte.arquivo);
  caso(`o cortar funciona igual no vídeo importado, sem começar depois (8s a 11s + arredondamento, declarado ${d.declarada}s)`, () =>
    assert.ok(d.declarada >= 7.9 && d.declarada <= 11.5));
  caso(`e não esconde nada (${d.guardada}s guardados × ${d.declarada}s declarados)`, () =>
    assert.ok(d.guardada <= d.declarada + 0.5));

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
  caso('vídeo sem rotação não deixa arquivinho de rotação', () =>
    assert.deepStrictEqual(fs.readdirSync(cfg.pasta).filter((n) => n.endsWith('.json')), []));

  // Celular virado no tripé (jogo de 25/09/2026: rotation=-180, todos os
  // cortes saíram de ponta-cabeça). 90° e não 180°: com 180 o sentido do giro
  // não faz diferença, e um sinal trocado passaria despercebido.
  const virado = path.join(pasta, `VID${carimboDoCelular(esperado)}_virado.mp4`);
  girarVideo(ffmpeg, celular, virado, 90);
  const pastaVirada = { ...cfg, pasta: path.join(pasta, 'virado') };
  const rVirado = await importar(pastaVirada, virado);
  caso('importar lê a rotação do celular', () => assert.strictEqual(rVirado.rotacao, 90));
  caso('os pedaços viram .ts e a rotação fica do lado, sem virar "pedaço"', () =>
    assert.strictEqual(listarPedacos(pastaVirada.pasta).length, 4));
  const corteVirado = await cortar(pastaVirada, new Date(esperado.getTime() + 8_000), new Date(esperado.getTime() + 16_000));
  const rotacaoDoCorte = spawnSync(caminhoDoFfprobe(ffmpeg), [
    '-v', 'quiet', '-select_streams', 'v:0', '-show_entries', 'stream_side_data=rotation',
    '-of', 'default=noprint_wrappers=1', corteVirado.arquivo,
  ], { encoding: 'utf8' }).stdout;
  caso(`o corte sai com a mesma rotação do original (${rotacaoDoCorte.trim() || 'nenhuma'})`, () =>
    assert.match(rotacaoDoCorte, /^rotation=90$/m));
  caso('e a faxina leva o arquivinho de rotação junto', () => {
    apagarAntigos(pastaVirada.pasta, 0, new Date(esperado.getTime() + 86_400_000));
    const sobrou = fs.readdirSync(pastaVirada.pasta).filter((n) => n.endsWith('.json'));
    assert.strictEqual(sobrou.length, 1, `sobrou: ${sobrou}`); // só o do último pedaço, que nunca é apagado
  });

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
