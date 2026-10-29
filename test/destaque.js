// Destaque da noite: quando as enquetes saem, quando sai o resultado, quem
// ganha e o voto em si mesmo que não conta. Datas de verdade: sexta normal
// 23/10 (até 23h), última sexta 30/10 (até 00h), extra de terça "(20h ~ 22h)".
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'volei-destaque-'));
process.env.DB_PATH = path.join(pasta, 'teste.db');

const grupos = require('../src/modulos/grupos/repositorio');
const pelada = require('../src/modulos/pelada/repositorio');
const elenco = require('../src/modulos/elenco/repositorio');
const times = require('../src/modulos/elenco/times');
const destaque = require('../src/modulos/destaque');
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

const br = (dia, mes, hora, minuto = 0) => Date.UTC(2026, mes - 1, dia, hora + 3, minuto);
const G = 'pelada@g.us';
const ADM = 'admins@g.us';

// Canal de mentira: guarda o que foi enviado e devolve os votos combinados
function canalFalso(votosPorTitulo = {}) {
  const enviados = [];
  const titulos = {};
  return {
    enviados,
    enviarTexto: async (chatId, texto) => { enviados.push({ chatId, texto }); },
    enviarEnquete: async (chatId, titulo, opcoes) => {
      const id = `poll-${enviados.length}`;
      titulos[id] = titulo;
      enviados.push({ chatId, titulo, opcoes, id });
      return id;
    },
    lerVotos: async (id) => {
      const chave = Object.keys(votosPorTitulo).find((k) => titulos[id].includes(k));
      return chave ? votosPorTitulo[chave] : [];
    },
    gruposAdmin: () => [ADM],
  };
}

(async () => {
  grupos.registrarGrupoSeNovo(G, 'Vôlei Riachuelo');
  grupos.registrarGrupoSeNovo(ADM, 'Admins');

  console.log('\nfim do jogo');
  const l23 = pelada.getLista(pelada.criarLista(G, '23/10', null, 12, { criadaEm: '2026-10-21T16:00:00.000Z' }).lista.id);
  const extra = pelada.getLista(pelada.criarLista(G, '27/10', 'Pelada surpresa (20h ~ 22h)', 12, { criadaEm: '2026-10-25T16:00:00.000Z' }).lista.id);
  await caso('sexta normal (23/10) acaba 23h', () => assert.strictEqual(destaque.fimDoJogoMs(l23), br(23, 10, 23)));
  await caso('extra "(20h ~ 22h)" acaba 22h', () => assert.strictEqual(destaque.fimDoJogoMs(extra), br(27, 10, 22)));

  const lista = pelada.getLista(pelada.criarLista(G, '30/10', 'Sexta 3h', 17, { criadaEm: '2026-10-28T16:00:00.000Z' }).lista.id);
  await caso('última sexta (30/10) acaba meia-noite', () => assert.strictEqual(destaque.fimDoJogoMs(lista), br(31, 10, 0)));

  // Elenco e lista: Marcel é fixo (número fictício), Ana entrou pelo WhatsApp
  // dela, Ramon é convidado do Fabrício
  for (const [nome, numero] of [
    ['Marcel', 'manual-1@bot'], ['Fabrício Bahiense', 'manual-2@bot'], ['Ana', '5521900000001@c.us'],
    ['Ramon (cvd Fabricio)', 'manual-3@bot'], ['Bia', '5521900000002@c.us'], ['Caio', '5521900000003@c.us'],
  ]) {
    pelada.registrarPresencaHistorica(lista.id, nome, numero);
    elenco.upsertJogador(G, nome.replace(/ \(cvd.*/, ''));
  }
  times.salvarTimes(lista.id, [
    { jogadores: [{ nome: 'Marcel' }, { nome: 'Ana' }, { nome: 'Ramon (cvd Fabricio)' }] },
    { jogadores: [{ nome: 'Fabrício Bahiense' }, { nome: 'Bia' }, { nome: 'Caio' }] },
  ]);

  console.log('\nenquetes depois do jogo');
  const canal = canalFalso({
    'Time 1': [
      { numero: '5521900000009@c.us', nome: 'Marcel Garcia', opcoes: [0] }, // fixo votando em si: não conta
      { numero: '5521900000001@c.us', nome: 'Ana', opcoes: [1] }, // Ana em si (pelo número): não conta
      { numero: '5521900000007@c.us', nome: 'Fabrício Bahiense', opcoes: [2] }, // no convidado dele: conta
      { numero: '5521900000002@c.us', nome: 'Bia', opcoes: [2] },
      { numero: '5521900000003@c.us', nome: 'Caio', opcoes: [1] },
    ],
    'Time 2': [
      { numero: '5521900000002@c.us', nome: 'Bia', opcoes: [1] }, // em si mesma
      { numero: '5521900000003@c.us', nome: 'Caio', opcoes: [1] },
    ],
    equilibrados: [
      { numero: '5521900000002@c.us', nome: 'Bia', opcoes: [0] },
      { numero: '5521900000003@c.us', nome: 'Caio', opcoes: [0] },
      { numero: '5521900000001@c.us', nome: 'Ana', opcoes: [2] },
    ],
  });

  await caso('00:29 ainda não posta', async () => {
    await destaque.verificar(canal, br(31, 10, 0, 29));
    assert.strictEqual(canal.enviados.length, 0);
  });
  await caso('00:30 posta: abertura + 1 enquete por time + equilíbrio', async () => {
    await destaque.verificar(canal, br(31, 10, 0, 30));
    assert.strictEqual(canal.enviados.length, 4);
    assert.ok(canal.enviados.every((e) => e.chatId === G));
    assert.deepStrictEqual(canal.enviados[1].opcoes, ['Marcel', 'Ana', 'Ramon (cvd Fabricio)']);
    assert.ok(canal.enviados[1].titulo.includes('acima do próprio normal'));
    assert.deepStrictEqual(canal.enviados[3].opcoes, destaque.EQUILIBRIO);
  });
  await caso('não posta de novo no minuto seguinte', async () => {
    await destaque.verificar(canal, br(31, 10, 0, 31));
    assert.strictEqual(canal.enviados.length, 4);
  });

  console.log('\nresultado no dia seguinte');
  await caso('11:59 ainda não anuncia', async () => {
    await destaque.verificar(canal, br(31, 10, 11, 59));
    assert.strictEqual(canal.enviados.length, 4);
  });
  await caso('12:00 anuncia no grupo e manda o detalhado pros admins', async () => {
    await destaque.verificar(canal, br(31, 10, 12, 0));
    const [grupo, admins] = canal.enviados.slice(4);
    assert.strictEqual(grupo.chatId, G);
    assert.strictEqual(admins.chatId, ADM);
    // Time 1: Ramon 2 votos (Fabrício e Bia); Ana só 1 (o dela não conta); Marcel 0
    assert.ok(grupo.texto.includes('Time 1: *Ramon (cvd Fabricio)* (2 votos)'), grupo.texto);
    assert.ok(grupo.texto.includes('Time 2: *Bia* (1 voto)'), grupo.texto);
    assert.ok(!grupo.texto.includes('Equilíbrio'), 'equilíbrio é só pros admins');
    assert.ok(admins.texto.includes('🚫 2 em si mesmo'), admins.texto);
    assert.ok(admins.texto.includes('⚖️ Bem equilibrados: 2'), admins.texto);
    assert.ok(admins.texto.includes('💀 Foi atropelo: 1'), admins.texto);
  });
  await caso('não anuncia duas vezes', async () => {
    const antes = canal.enviados.length;
    await destaque.verificar(canal, br(31, 10, 12, 5));
    assert.strictEqual(canal.enviados.length, antes);
  });

  console.log('\ncomando de teste (grupo de admins)');
  const respostas = [];
  const enviadosTeste = [];
  const porta = (body, origem = 'grupoadmin') => ({
    body, origem, chatId: ADM, autor: 'Fabrício',
    reply: async (t) => { respostas.push(t); },
    enviarPara: async (chatId, texto) => { enviadosTeste.push({ chatId, texto }); },
    enviarEnquetePara: async (chatId, titulo, opcoes) => { enviadosTeste.push({ chatId, titulo, opcoes }); return `t-${enviadosTeste.length}`; },
    lerVotos: async () => [],
  });
  await caso('teste posta só no grupo de admins', async () => {
    await processarComandoAdmin(porta('#destaquede riachuelo teste'));
    assert.strictEqual(enviadosTeste.length, 4);
    assert.ok(enviadosTeste.every((e) => e.chatId === ADM));
    assert.ok(enviadosTeste[0].texto.includes('TESTE'));
  });
  await caso('teste no privado explica que enquete só vai em grupo', async () => {
    await processarComandoAdmin(porta('#destaquede riachuelo teste', 'privado'));
    assert.ok(respostas.pop().includes('grupo de admins'));
  });
  await caso('resultado do teste mostra a apuração pra quem pediu', async () => {
    await processarComandoAdmin(porta('#destaquede riachuelo resultado'));
    const r = respostas.pop();
    assert.ok(r.includes('TESTE') && r.includes('Como sairia o anúncio'), r);
  });
  await caso('a real já postada não posta de novo pelo comando', async () => {
    await processarComandoAdmin(porta('#destaquede riachuelo'));
    assert.ok(respostas.pop().includes('já foram postadas'));
  });

  console.log('\nmesma pessoa');
  await caso('"Marcel Garcia" é o "Marcel"', () => assert.ok(destaque.mesmaPessoa('Marcel Garcia', 'Marcel')));
  await caso('"Marcelle" não é o "Marcel"', () => assert.ok(!destaque.mesmaPessoa('Marcelle', 'Marcel')));
  await caso('"Fabrício" não é o "Ramon (cvd Fabricio)"', () => assert.ok(!destaque.mesmaPessoa('Fabrício', 'Ramon (cvd Fabricio)')));

  fecharBanco();
  fs.rmSync(pasta, { recursive: true, force: true });
  if (falhas) {
    console.log(`\n${falhas} falha(s)`);
    process.exit(1);
  }
  console.log('\ntudo ok');
})();
