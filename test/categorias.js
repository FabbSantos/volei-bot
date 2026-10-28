// Nível por categoria de impacto (28/10/2026): ninguém vota em si mesmo, as
// notas antigas viram categoria, e o montador espalha os 🔥 e os 😬.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'volei-categorias-'));
process.env.DB_PATH = path.join(pasta, 'teste.db');

const grupos = require('../src/modulos/grupos/repositorio');
const elenco = require('../src/modulos/elenco/repositorio');
const times = require('../src/modulos/elenco/times');
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

console.log('\nnível por categoria');
const G = 'pelada@g.us';
grupos.registrarGrupoSeNovo(G, 'Vôlei');
const jogador = (nome) => elenco.upsertJogador(G, nome);
const nivelDe = (nome) => elenco.listarJogadores(G).find((j) => j.nome === nome);

caso('notas antigas viram categoria', () => {
  assert.strictEqual(elenco.categoriaDasNotas(2), 1);
  assert.strictEqual(elenco.categoriaDasNotas(3), 2);
  assert.strictEqual(elenco.categoriaDasNotas(3.5), 3);
  assert.strictEqual(elenco.categoriaDasNotas(4), 4);
  assert.strictEqual(elenco.categoriaDasNotas(null), null);
});

// O caso que começou tudo: o Marcel se deu nota alta
const marcel = jogador('Marcel Garcia');
elenco.votarImpacto(marcel.id, 'Marcel', 4);
elenco.votarImpacto(marcel.id, 'Diego', 2);
elenco.votarImpacto(marcel.id, 'Fabrício', 2);
caso('o voto do Marcel no Marcel Garcia não conta', () => {
  const m = nivelDe('Marcel Garcia');
  assert.strictEqual(m.nivel, 2);
  assert.strictEqual(m.categoria, 2);
});
caso('"Marcel" votando é ele mesmo; "Marcelle" não', () => {
  assert.ok(elenco.votaEmSiMesmo('Marcel', { nome: 'Marcel Garcia' }, []));
  assert.ok(!elenco.votaEmSiMesmo('Marcelle', { nome: 'Marcel Garcia' }, []));
  assert.ok(elenco.votaEmSiMesmo('Fabrício', { nome: 'Fabrício Bahiense' }, []));
  assert.ok(elenco.votaEmSiMesmo('Kamila', { nome: 'Kamila Vianna' }, []));
  assert.ok(elenco.votaEmSiMesmo('Diego', { nome: 'DiegoB' }, ['Diego Borges']));
});

const vini = jogador('Vini');
elenco.votarHabilidade(vini.id, 'Fabrício', 'ataque', 4);
elenco.votarHabilidade(vini.id, 'Fabrício', 'defesa', 4);
elenco.votarImpacto(vini.id, 'Diego', 3);
caso('quem não escolheu categoria tem a dela tirada das notas antigas (4 → 🔥), e mistura com quem escolheu', () => {
  const v = nivelDe('Vini');
  assert.strictEqual(v.nivel, 3.5); // Fabrício 🔥 (4) + Diego 👍 (3)
  assert.strictEqual(v.habilidade, 4); // 3,5 na escala de nota
});
caso('categoria escolhida vence as notas antigas do mesmo votante', () => {
  elenco.votarImpacto(vini.id, 'Fabrício', 2);
  assert.strictEqual(nivelDe('Vini').nivel, 2.5);
});
caso('apagar a categoria volta pras notas antigas', () => {
  elenco.votarImpacto(vini.id, 'Fabrício', null);
  assert.strictEqual(nivelDe('Vini').nivel, 3.5);
});
caso('categoria inválida é recusada', () => assert.strictEqual(elenco.votarImpacto(vini.id, 'Diego', 7).erro, 'categoria_invalida'));

console.log('\ntimes com os craques espalhados');
// 4 craques, 4 "puts", 4 medianos, 2 times: cada time tem que levar 2 de cada
const nomes = [];
const criar = (prefixo, cat, n) => {
  for (let i = 1; i <= n; i++) {
    const j = jogador(`${prefixo} ${i}`);
    elenco.votarImpacto(j.id, 'Votante', cat);
    nomes.push({ nome: j.nome, numero: null });
  }
};
criar('Craque', 4, 4);
criar('Puts', 1, 4);
criar('Medio', 2, 4);
const montados = times.montarTimes(G, 2, nomes);
const conta = (t, prefixo) => t.jogadores.filter((j) => j.nome.startsWith(prefixo)).length;
caso('os 🔥 ficam divididos (2 e 2)', () => assert.deepStrictEqual(montados.map((t) => conta(t, 'Craque')), [2, 2]));
caso('os 😬 também (2 e 2)', () => assert.deepStrictEqual(montados.map((t) => conta(t, 'Puts')), [2, 2]));
caso('e as médias ficam iguais', () => assert.ok(Math.abs(montados[0].media - montados[1].media) < 0.01, montados.map((t) => t.media).join(' × ')));

// 3 craques em 3 times: um em cada, mesmo que o zigue-zague quisesse diferente
const tres = [];
for (let i = 1; i <= 3; i++) {
  const j = jogador(`Top ${i}`);
  elenco.votarImpacto(j.id, 'Votante', 4);
  tres.push({ nome: j.nome, numero: null });
}
for (let i = 1; i <= 9; i++) {
  const j = jogador(`Normal ${i}`);
  elenco.votarImpacto(j.id, 'Votante', 2);
  tres.push({ nome: j.nome, numero: null });
}
const tresTimes = times.montarTimes(G, 3, tres);
caso('3 craques em 3 times: um em cada', () => assert.deepStrictEqual(tresTimes.map((t) => conta(t, 'Top')), [1, 1, 1]));

fecharBanco();
fs.rmSync(pasta, { recursive: true, force: true });
console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo ok');
process.exit(falhas ? 1 : 0);
