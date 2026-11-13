// Montador pelo perfil (planilha do Diego, 13/11/2026): Função 1 → Função 2,
// saque, meninas. Os perfis abaixo têm o formato da planilha de verdade (18
// pessoas, 5 meninas, 5 batedores), com nomes fictícios.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'volei-perfis-'));
process.env.DB_PATH = path.join(pasta, 'teste.db');

const grupos = require('../src/modulos/grupos/repositorio');
const pelada = require('../src/modulos/pelada/repositorio');
const elenco = require('../src/modulos/elenco/repositorio');
const perfis = require('../src/modulos/elenco/perfis');
const times = require('../src/modulos/elenco/times');
const { processarComandoAdmin } = require('../src/roteador');
const { fecharBanco } = require('../src/nucleo/banco');

let falhas = 0;
async function caso(nome, fn) {
  try {
    await fn();
    console.log(`  ok  ${nome}`);
  } catch (err) {
    falhas++;
    console.log(`  FALHOU  ${nome}\n          ${err.message}`);
  }
}

const G = 'pelada@g.us';
const ADM = 'admins@g.us';
// [nome, role1, role2, saque, menina]
const PLANILHA = [
  ['Alfa', 'Bloqueador', 'Normal', 'Normal', false],
  ['Bravo', 'Normal', 'Normal', 'Bom', false],
  ['Charlie', 'Normal', 'Normal', 'Regular', false],
  ['Dora', 'Normal', 'Normal', 'Regular', true],
  ['Eco', 'Defensor', 'Receptor', 'Bom', false],
  ['Fani', 'Normal', 'Normal', 'Regular', true],
  ['Gabi', 'Normal', 'Normal', 'Regular', true],
  ['Hotel', 'Normal', 'Normal', 'Bom', false],
  ['Iara', 'Defensor', 'Receptor', 'Normal', true],
  ['Juca', 'Levantador', 'Defensor', 'Muito bom', false],
  ['Kilo', 'Batedor', 'Defensor', 'Muito bom', false],
  ['Lima', 'Defensor', 'Receptor', 'Bom', false],
  ['Mike', 'Batedor', 'Receptor', 'Bom', false],
  ['Nico', 'Batedor', 'Bloqueador', 'Muito bom', false],
  ['Oscar', 'Batedor', 'Normal', 'Bom', false],
  ['Papa', 'Normal', 'Normal', 'Bom', false],
  ['Rita', 'Normal', 'Normal', 'Regular', true],
  ['Sierra', 'Batedor', 'Normal', 'Bom', false],
];

(async () => {
  grupos.registrarGrupoSeNovo(G, 'Vôlei Riachuelo');
  grupos.registrarGrupoSeNovo(ADM, 'Admins');

  console.log('\nregra Função 1 → Função 2');
  const j = (nome, role1, role2 = 'Normal') => ({ nome, role1, role2 });
  await caso('Função 1 de cada um quando não repete', () =>
    assert.deepStrictEqual(perfis.funcoesDoTime([j('A', 'Batedor'), j('B', 'Defensor')]), { Batedor: 1, Defensor: 1 }));
  await caso('time já tem a Função 1: conta a Função 2', () =>
    assert.deepStrictEqual(perfis.funcoesDoTime([j('A', 'Batedor'), j('B', 'Batedor', 'Bloqueador')]), { Batedor: 1, Bloqueador: 1 }));
  await caso('sem Função 2: conta a Função 1 repetida', () =>
    assert.deepStrictEqual(perfis.funcoesDoTime([j('A', 'Batedor'), j('B', 'Batedor')]), { Batedor: 2 }));
  await caso('Normal não conta função nenhuma', () =>
    assert.deepStrictEqual(perfis.funcoesDoTime([j('A', 'Normal'), j('B', 'Normal')]), {}));

  console.log('\nperfil no banco');
  const ids = {};
  for (const [nome, role1, role2, saque, menina] of PLANILHA) {
    const jog = elenco.upsertJogador(G, nome);
    ids[nome] = jog.id;
    perfis.salvarPerfil(jog.id, { role1, role2, saque, menina });
  }
  await caso('salva uma célula sem mexer nas outras', () => {
    perfis.salvarPerfil(ids.Juca, { saque: 'bom' });
    assert.deepStrictEqual(perfis.perfilDe(ids.Juca), { role1: 'Levantador', role2: 'Defensor', saque: 'Bom', menina: false });
    perfis.salvarPerfil(ids.Juca, { saque: 'Muito bom' });
  });
  await caso('valor fora da lista é recusado', () => {
    assert.ok(perfis.salvarPerfil(ids.Juca, { role1: 'Goleiro' }).erro);
    assert.strictEqual(perfis.perfilDe(ids.Juca).role1, 'Levantador');
  });
  await caso('quem nunca foi preenchido é Normal', () =>
    assert.deepStrictEqual(perfis.perfilDe(9999), perfis.PADRAO));

  console.log('\nmontagem pelo perfil (18 em 3 times)');
  const participantes = PLANILHA.map(([nome]) => ({ nome, numero: null }));
  const montados = times.montarTimesPorPerfil(G, 3, participantes);
  const espalhamento = (vals) => Math.max(...vals) - Math.min(...vals);
  await caso('times de 6', () => assert.deepStrictEqual(montados.map((t) => t.jogadores.length), [6, 6, 6]));
  await caso('meninas espalhadas (5 → 2/2/1)', () =>
    assert.deepStrictEqual(montados.map((t) => t.meninas).sort(), [1, 2, 2]));
  await caso('cada função com no máximo 1 de diferença entre os times', () => {
    for (const f of ['Batedor', 'Bloqueador', 'Levantador', 'Defensor', 'Receptor']) {
      assert.ok(espalhamento(montados.map((t) => t.funcoes[f] || 0)) <= 1, `${f}: ${montados.map((t) => t.funcoes[f] || 0)}`);
    }
  });
  await caso('saque médio parecido (até 0,5 de diferença)', () =>
    assert.ok(espalhamento(montados.map((t) => t.saque)) <= 0.5, montados.map((t) => t.saque).join(' / ')));
  await caso('mesma gente, mesmos times (prévia = envio)', () => {
    const deNovo = times.montarTimesPorPerfil(G, 3, [...participantes].reverse());
    assert.deepStrictEqual(deNovo.map((t) => t.jogadores.map((x) => x.nome).sort()), montados.map((t) => t.jogadores.map((x) => x.nome).sort()));
  });

  console.log('\n#timesde com os dois montadores');
  const lista = pelada.criarLista(G, '20/11', null, 18).lista;
  for (const [nome] of PLANILHA) pelada.registrarPresencaHistorica(lista.id, nome, `${nome.toLowerCase()}@c.us`);
  const respostas = [];
  const porta = (body) => ({ body, origem: 'grupoadmin', chatId: ADM, autor: 'F', reply: async (t) => { respostas.push(t); }, enviarPara: async () => {} });

  await caso('comparar mostra os dois e não salva', async () => {
    await processarComandoAdmin(porta('#timesde riachuelo 3 comparar'));
    const r = respostas.pop();
    assert.ok(r.includes('pelas notas') && r.includes('pelo perfil'), r);
    assert.strictEqual(times.getTimesSalvos(lista.id), null);
  });
  await caso('"perfil" monta e salva com o montador do perfil', async () => {
    await processarComandoAdmin(porta('#timesde riachuelo 3 perfil'));
    const r = respostas.pop();
    assert.ok(r.includes('pelo perfil') && r.includes('Prévia'), r);
    const salvos = times.getTimesSalvos(lista.id);
    assert.strictEqual(salvos.metodo, 'perfil');
    assert.ok(salvos.times[0].jogadores.every((x) => x.temPerfil));
  });
  await caso('sem método mostra os salvos (e diz qual montador)', async () => {
    await processarComandoAdmin(porta('#timesde riachuelo'));
    const r = respostas.pop();
    assert.ok(r.includes('salvos') && r.includes('pelo perfil'), r);
  });
  await caso('"notas" troca pro montador de sempre', async () => {
    await processarComandoAdmin(porta('#timesde riachuelo 3 notas'));
    assert.strictEqual(times.getTimesSalvos(lista.id).metodo, 'notas');
  });
  await caso('anúncio: notas = NASA 2, perfil = NASA 3.0', async () => {
    const enviados = [];
    const portaEnvio = (body) => ({ ...porta(body), enviarPara: async (_c, t) => { enviados.push(t); } });
    await processarComandoAdmin(portaEnvio('#timesde riachuelo enviar'));
    assert.ok(enviados.pop().includes('NASA 2 🚀'));
    await processarComandoAdmin(porta('#timesde riachuelo 3 perfil'));
    await processarComandoAdmin(portaEnvio('#timesde riachuelo enviar'));
    assert.ok(enviados.pop().includes('NASA 3.0 🚀'));
  });

  console.log('\nsorteio puro');
  await caso('sorteio: times do mesmo tamanho, todo mundo uma vez só', () => {
    const ts = times.montarSorteio(G, 3, participantes);
    assert.deepStrictEqual(ts.map((t) => t.jogadores.length), [6, 6, 6]);
    assert.deepStrictEqual(ts.flatMap((t) => t.jogadores.map((x) => x.nome)).sort(), PLANILHA.map(([n]) => n).sort());
  });
  await caso('sorteio: muda conforme a sorte (e não é a ordem da lista)', () => {
    let s = 7;
    const semente = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const a = times.montarSorteio(G, 3, participantes, semente).map((t) => t.jogadores.map((x) => x.nome).join());
    const b = times.montarSorteio(G, 3, participantes, semente).map((t) => t.jogadores.map((x) => x.nome).join());
    assert.notDeepStrictEqual(a, b);
  });
  await caso('"#timesde ... aleatorio enviar": sorteia, salva e anuncia a NASA bugada', async () => {
    const enviados = [];
    await processarComandoAdmin({ ...porta('#timesde riachuelo 3 aleatorio enviar'), enviarPara: async (_c, t) => { enviados.push(t); } });
    assert.strictEqual(times.getTimesSalvos(lista.id).metodo, 'sorteio');
    const texto = enviados.pop();
    const bug = texto.match(/Montados com a TECNOLOGIA DA NASA (\S{5,7}) 🚀/);
    assert.ok(bug, texto);
    assert.ok(!/[*_~`a-z0-9]/i.test(bug[1]), `sem letra, número nem formatação do WhatsApp: ${bug[1]}`);
  });
  await caso('comparar continua só notas x perfil', async () => {
    await processarComandoAdmin(porta('#timesde riachuelo 3 comparar'));
    assert.ok(!respostas.pop().includes('sorteio'));
  });

  console.log('\nfotos dos times');
  const imagemTimes = require('../src/modulos/elenco/imagemTimes');
  const fotos = [];
  const portaFoto = (body, falha = false) => ({
    ...porta(body),
    enviarImagemHtml: async (html, legenda) => { if (falha) throw new Error('chrome ocupado'); fotos.push({ html, legenda }); },
    enviarImagemHtmlPara: async (chatId, html, legenda) => { if (falha) throw new Error('chrome ocupado'); fotos.push({ chatId, html, legenda }); },
    enviarPara: async (chatId, texto) => { fotos.push({ chatId, texto }); },
  });
  await caso('o HTML escapa nome com < e &', () => {
    const html = imagemTimes.htmlAnuncio({ dataJogo: '20/11', versao: 'X', times: [['<b>Zé & cia</b>']] });
    assert.ok(html.includes('&lt;b&gt;Zé &amp; cia&lt;/b&gt;') && !html.includes('<b>Zé'));
  });
  await caso('comparar vai em foto, com os dois montadores, sem salvar', async () => {
    times.apagarTimesSalvos(lista.id);
    respostas.length = 0;
    await processarComandoAdmin(portaFoto('#timesde riachuelo 3 comparar'));
    const f = fotos.pop();
    assert.ok(f.html.includes('Pelas notas') && f.html.includes('Pelo perfil') && f.html.includes('Juca'), 'html');
    assert.ok(f.legenda.includes('nada foi salvo'));
    assert.strictEqual(respostas.length, 0, 'não manda o texto junto');
    assert.strictEqual(times.getTimesSalvos(lista.id), null);
  });
  await caso('foto falhou: comparar cai no texto', async () => {
    await processarComandoAdmin(portaFoto('#timesde riachuelo 3 comparar', true));
    assert.ok(respostas.pop().includes('pelo perfil'));
  });
  await caso('"perfil foto" monta, salva e mostra a prévia em imagem', async () => {
    await processarComandoAdmin(portaFoto('#timesde riachuelo 3 perfil foto'));
    const f = fotos.pop();
    assert.ok(f.html.includes('Pelo perfil') && f.legenda.includes('Prévia'), f.legenda);
    assert.strictEqual(times.getTimesSalvos(lista.id).metodo, 'perfil');
  });
  await caso('#timesde sem nada no fim já mostra a prévia em foto', async () => {
    respostas.length = 0;
    await processarComandoAdmin(portaFoto('#timesde riachuelo'));
    const f = fotos.pop();
    assert.ok(f.html.includes('Time 1') && f.legenda.includes('Prévia'), f.legenda);
    assert.strictEqual(respostas.length, 0, 'sem texto junto');
  });
  await caso('"texto" no fim: a prévia antiga, em texto', async () => {
    const antes = fotos.length;
    await processarComandoAdmin(portaFoto('#timesde riachuelo texto'));
    assert.strictEqual(fotos.length, antes, 'não gera foto');
    assert.ok(respostas.pop().includes('Prévia — o grupo NÃO recebeu nada'));
  });
  await caso('enviar: o grupo recebe a foto só com os nomes', async () => {
    await processarComandoAdmin(portaFoto('#timesde riachuelo enviar'));
    const r = respostas.pop();
    assert.ok(r.includes('(em foto)'), r);
    const f = fotos.pop();
    assert.strictEqual(f.chatId, G);
    assert.ok(f.html.includes('NASA 3.0') && f.html.includes('Juca'));
    assert.ok(!/MB|👍|😬|💥|🛡️|🎀|📏|saque|class="cat"/i.test(f.html),'nada de nota, função ou saque na foto do grupo');
  });
  await caso('enviar com a foto falhando: vai o texto de sempre', async () => {
    await processarComandoAdmin(portaFoto('#timesde riachuelo enviar', true));
    const f = fotos.pop();
    assert.ok(f.texto && f.texto.includes('NASA 3.0 🚀') && f.texto.includes('• Juca'));
  });

  fecharBanco();
  fs.rmSync(pasta, { recursive: true, force: true });
  if (falhas) {
    console.log(`\n${falhas} falha(s)`);
    process.exit(1);
  }
  console.log('\ntudo ok');
})();
