// Prazo da mensalidade (07/11/2026: "pagamento até quarta 12h, quem não pagou
// sai"): o corte tira só não-fixo sem o mês pago, a espera sobe, fixo fica.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'volei-prazo-'));
process.env.DB_PATH = path.join(pasta, 'teste.db');

const grupos = require('../src/modulos/grupos/repositorio');
const mensalistas = require('../src/modulos/mensalistas/repositorio');
const prazo = require('../src/modulos/mensalistas/prazo');
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

(async () => {
  grupos.registrarGrupoSeNovo(G, 'Vôlei Riachuelo');
  grupos.registrarGrupoSeNovo(ADM, 'Admins');
  grupos.marcarGrupoAdmin(ADM, true);

  console.log('\npróxima quarta 12h');
  await caso('sábado 13:49 → quarta 11/11 12h', () => assert.strictEqual(prazo.proximaOcorrenciaMs(3, 12, 0, br(7, 11, 13, 49)), br(11, 11, 12)));
  await caso('quarta 11:59 → hoje 12h', () => assert.strictEqual(prazo.proximaOcorrenciaMs(3, 12, 0, br(11, 11, 11, 59)), br(11, 11, 12)));
  await caso('quarta 12:00 já passou → semana que vem', () => assert.strictEqual(prazo.proximaOcorrenciaMs(3, 12, 0, br(11, 11, 12, 0)), br(18, 11, 12)));

  // Quadro: 1 fixo sem pagar, 1 fixo pago, 3 mensais (1 paga), espera com 2
  mensalistas.listarMensalistas(G);
  const nomes = ['Fixa Pendente', 'Fixa Paga', 'Paga', 'Deve1', 'Deve2'];
  nomes.forEach((n, i) => mensalistas.adicionarMensalista(G, n, `${i}@bot`));
  mensalistas.setarLimiteMensalistas(G, 5);
  mensalistas.adicionarMensalista(G, 'Espera1', '9@bot');
  mensalistas.adicionarMensalista(G, 'Espera2', '10@bot');
  mensalistas.alternarFixoPorPosicao(G, 1);
  mensalistas.alternarFixoPorPosicao(G, 2);
  mensalistas.marcarMesPagoPorPosicao(G, 2, true, 4100);
  mensalistas.marcarMesPagoPorPosicao(G, 3, true, 4100);

  const enviados = [];
  const canal = { enviarTexto: async (chatId, texto) => { enviados.push({ chatId, texto }); }, gruposAdmin: () => [ADM] };
  const respostas = [];
  const porta = (body) => ({ body, origem: 'grupoadmin', chatId: ADM, autor: 'F', reply: async (t) => { respostas.push(t); } });

  console.log('\ncomando');
  await caso('marca o prazo', async () => {
    await processarComandoAdmin(porta('#prazomensalistasde riachuelo quarta 12h'));
    assert.ok(respostas.pop().includes('quarta'));
    assert.ok(prazo.getPrazo(G).prazo_ms > Date.now());
  });
  await caso('sem nada mostra, off cancela', async () => {
    await processarComandoAdmin(porta('#prazomensalistasde riachuelo'));
    assert.ok(respostas.pop().includes('Prazo da mensalidade'));
    await processarComandoAdmin(porta('#prazomensalistasde riachuelo off'));
    assert.ok(respostas.pop().includes('cancelado'));
    assert.strictEqual(prazo.getPrazo(G), undefined);
  });
  await caso('texto estranho é recusado', async () => {
    await processarComandoAdmin(porta('#prazomensalistasde riachuelo banana 99h'));
    assert.ok(respostas.pop().includes('Não entendi'));
  });

  console.log('\ncorte');
  prazo.salvarPrazo(G, br(11, 11, 12));
  await caso('11:59 ainda não corta', async () => {
    await prazo.verificar(canal, br(11, 11, 11, 59));
    assert.strictEqual(enviados.length, 0);
    assert.strictEqual(mensalistas.listarMensalistas(G).length, 7);
  });
  await caso('12:00 corta só quem é mensal e não pagou, e a espera sobe', async () => {
    await prazo.verificar(canal, br(11, 11, 12, 0));
    const quadro = mensalistas.listarMensalistas(G);
    assert.deepStrictEqual(quadro.filter((m) => !m.espera).map((m) => m.nome), ['Fixa Pendente', 'Fixa Paga', 'Paga', 'Espera1', 'Espera2']);
    assert.strictEqual(quadro.some((m) => m.espera), false);
    const grupo = enviados.find((e) => e.chatId === G).texto;
    assert.ok(grupo.includes('*Deve1*') && grupo.includes('*Deve2*'), grupo);
    assert.ok(grupo.includes('Subiram da espera'), grupo);
    assert.ok(!grupo.includes('Fixa Pendente'), 'fixo não é citado no grupo');
    const admins = enviados.find((e) => e.chatId === ADM).texto;
    assert.ok(admins.includes('Fixa Pendente'), admins);
  });
  await caso('vale uma vez só', async () => {
    const antes = enviados.length;
    await prazo.verificar(canal, br(11, 11, 12, 5));
    assert.strictEqual(enviados.length, antes);
  });

  fecharBanco();
  fs.rmSync(pasta, { recursive: true, force: true });
  if (falhas) {
    console.log(`\n${falhas} falha(s)`);
    process.exit(1);
  }
  console.log('\ntudo ok');
})();
