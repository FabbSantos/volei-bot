// Agenda de abertura da lista: quando abre, qual data, a última sexta do mês,
// e que nunca abre duas vezes. Datas de verdade: quarta 21/10/2026 às 13h
// abre a sexta 23/10; a última sexta de outubro é 30/10.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'volei-agenda-'));
process.env.DB_PATH = path.join(pasta, 'teste.db');

const grupos = require('../src/modulos/grupos/repositorio');
const pelada = require('../src/modulos/pelada/repositorio');
const agenda = require('../src/modulos/pelada/agenda');
const { processarComandoAdmin } = require('../src/roteador');
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

// "21/10 13:00" no horário de Brasília → instante
const br = (dia, mes, hora, minuto = 0) => Date.UTC(2026, mes - 1, dia, hora + 3, minuto);
const QUARTA_13H_SEXTA = { dia_abertura: 3, hora: 13, minuto: 0, dia_jogo: 5 };

console.log('\nagenda da lista');

caso('quarta 21/10 12:59: ainda é o ciclo da sexta 16/10, que já passou', () => {
  const c = agenda.cicloAtual(QUARTA_13H_SEXTA, br(21, 10, 12, 59));
  assert.strictEqual(c.dataJogo, '16/10');
  assert.strictEqual(c.jaPassou, true);
});
caso('quarta 21/10 13:00: abre a sexta 23/10', () => {
  const c = agenda.cicloAtual(QUARTA_13H_SEXTA, br(21, 10, 13, 0));
  assert.strictEqual(c.dataJogo, '23/10');
  assert.strictEqual(c.jaPassou, false);
  assert.strictEqual(c.ultimaDoMes, false);
});
caso('sexta 23/10 22h (jogo rolando): ainda é o ciclo dela', () =>
  assert.strictEqual(agenda.cicloAtual(QUARTA_13H_SEXTA, br(23, 10, 22)).jaPassou, false));
caso('sábado 24/10: o jogo de 23/10 já passou', () =>
  assert.strictEqual(agenda.cicloAtual(QUARTA_13H_SEXTA, br(24, 10, 9)).jaPassou, true));
caso('quarta 28/10 13h: sexta 30/10 é a última do mês', () => {
  const c = agenda.cicloAtual(QUARTA_13H_SEXTA, br(28, 10, 13));
  assert.strictEqual(c.dataJogo, '30/10');
  assert.strictEqual(c.ultimaDoMes, true);
});
caso('virada de mês: quarta 30/12 abre a sexta 01/01', () =>
  assert.strictEqual(agenda.cicloAtual(QUARTA_13H_SEXTA, br(30, 12, 14)).dataJogo, '01/01'));
caso('dias e horas por extenso', () => {
  assert.strictEqual(agenda.lerDia('quarta'), 3);
  assert.strictEqual(agenda.lerDia('Quarta-feira'), 3);
  assert.strictEqual(agenda.lerDia('sábado'), 6);
  assert.strictEqual(agenda.lerDia('sex'), 5);
  assert.strictEqual(agenda.lerDia('xyz'), -1);
  assert.deepStrictEqual(agenda.lerHora('13h'), { hora: 13, minuto: 0 });
  assert.deepStrictEqual(agenda.lerHora('13:30'), { hora: 13, minuto: 30 });
  assert.deepStrictEqual(agenda.lerHora('13h30'), { hora: 13, minuto: 30 });
  assert.strictEqual(agenda.lerHora('25h'), null);
});

async function fluxo() {
  const G = 'pelada@g.us';
  grupos.registrarGrupoSeNovo(G, 'Vôlei no Riachuelo');
  grupos.ativarGrupo(G);
  grupos.setarValorPadraoGrupo(G, 1200);
  const velha = pelada.criarLista(G, '16/10').lista;

  const respostas = [];
  const enviados = [];
  const portaAdmin = (texto) => ({
    body: texto, origem: 'grupoadmin', chatId: 'adm@g.us',
    reply: async (t) => respostas.push(t),
    enviarPara: async (chatId, t) => enviados.push({ chatId, t }),
    enviarFigurinhaPara: async () => {},
  });
  const admin = (texto) => processarComandoAdmin(portaAdmin(texto));
  // O que o main.js faz: o próprio #abrirlistade
  const abertas = [];
  const abrir = async (a, { dataJogo, valor, nome }) => {
    abertas.push({ dataJogo, valor, nome });
    const especial = valor != null ? ` ${(valor / 100).toString().replace('.', ',')}${nome ? ` ${nome}` : ''}` : '';
    await processarComandoAdmin(portaAdmin(`#abrirlistade ${a.chat_id} ${dataJogo}${especial}`));
  };

  await admin('#agendalistade riachuelo quarta 13h sexta ultima 17 Sexta 3h');
  caso('#agendalistade liga e descreve', () =>
    assert.match(respostas.at(-1), /ligada: 🟢 toda \*quarta\* às \*13h\* abre a lista da \*sexta\* · na última sexta do mês: R\$ 17,00 "Sexta 3h"/));

  await agenda.verificar(abrir, br(21, 10, 12, 59));
  caso('12:59: não abre nada', () => assert.strictEqual(abertas.length, 0));

  await agenda.verificar(abrir, br(21, 10, 13, 0));
  caso('13:00: abre a lista de 23/10 com o valor de sempre', () => {
    assert.deepStrictEqual(abertas, [{ dataJogo: '23/10', valor: null, nome: null }]);
    const nova = pelada.getListaMaisRecente(G);
    assert.strictEqual(nova.data_jogo, '23/10');
    assert.strictEqual(nova.valor_centavos, 1200);
  });
  caso('e anuncia no grupo, igual ao #abrirlistade', () =>
    assert.ok(enviados.some((m) => m.chatId === G && /Lista aberta pro dia \*23\/10\*/.test(m.t))));
  caso('e fecha a da semana passada que ficou aberta', () => assert.strictEqual(pelada.getLista(velha.id).status, 'encerrada'));

  await agenda.verificar(abrir, br(21, 10, 13, 1));
  await agenda.verificar(abrir, br(22, 10, 9));
  caso('os minutos seguintes não abrem de novo', () => assert.strictEqual(abertas.length, 1));

  await admin(`#cancelarlistade riachuelo`);
  await agenda.verificar(abrir, br(21, 10, 15));
  caso('cancelada por um admin: a agenda não reabre', () => {
    assert.strictEqual(abertas.length, 1);
    assert.ok(!pelada.listasDoGrupo(G).some((l) => l.data_jogo === '23/10'));
  });

  // Semana seguinte: o bot estava fora às 13h e volta às 18h
  await agenda.verificar(abrir, br(28, 10, 18));
  caso('bot fora às 13h da última quarta do mês: abre quando volta, com R$ 17 "Sexta 3h"', () => {
    assert.deepStrictEqual(abertas.at(-1), { dataJogo: '30/10', valor: 1700, nome: 'Sexta 3h' });
    const l = pelada.getListaMaisRecente(G);
    assert.strictEqual(l.valor_centavos, 1700);
    assert.strictEqual(l.nome, 'Sexta 3h');
  });

  // Admin abriu na mão antes: a agenda não duplica
  pelada.criarLista(G, '06/11');
  await agenda.verificar(abrir, br(4, 11, 13));
  caso('lista já aberta na mão: a agenda só anota, não abre outra', () => assert.notStrictEqual(abertas.at(-1).dataJogo, '06/11'));

  await admin('#agendalistade riachuelo off');
  await agenda.verificar(abrir, br(11, 11, 13));
  caso('desligada: não abre mais', () => assert.notStrictEqual(abertas.at(-1).dataJogo, '13/11'));
  await admin('#agendalistade riachuelo');
  caso('#agendalistade sem nada mostra a agenda (desligada)', () => assert.match(respostas.at(-1), /desligada/));
  await admin('#agendalistade riachuelo toda hora');
  caso('formato errado: explica', () => assert.match(respostas.at(-1), /Não entendi/));
}

fluxo()
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
