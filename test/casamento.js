// Casamento de nomes da lista com o elenco — casos que já deram errado ao vivo.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'volei-casamento-'));
process.env.DB_PATH = path.join(pasta, 'teste.db');
const elenco = require('../src/modulos/elenco/repositorio');

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

const CHAT = 'casamento@g.us';
for (const nome of ['Marcel Garcia', 'Marcelle', 'Fabrício Bahiense', 'Renan', 'Thiago Prata']) {
  elenco.upsertJogador(CHAT, nome);
}
const jogadores = elenco.listarJogadores(CHAT);
const achar = (nome, numero = 'manual-1@bot') => elenco.acharJogadorDaEntrada(CHAT, { nome, numero }, jogadores)?.nome ?? null;

console.log('convidado com anfitrião entre parênteses');
// 25/09/2026: "(cvd Marcel)" contava como nome, "marcel" é prefixo de
// "marcelle", e o convidado foi pros times no lugar dela
caso('"Paulo Ribeiro (cvd Marcel)" não vira a Marcelle', () =>
  assert.strictEqual(achar('Paulo Ribeiro (cvd Marcel)'), null));
caso('nem o Marcel — o convidado é outra pessoa', () =>
  assert.notStrictEqual(achar('Paulo Ribeiro (cvd Marcel)'), 'Marcel Garcia'));
caso('"Lucas (cvd Fabrício)" não vira o Fabrício', () =>
  assert.strictEqual(achar('Lucas Brito (cvd Fabrício)'), null));
caso('só a anotação, sem nome, não casa com ninguém', () =>
  assert.strictEqual(achar('(cvd Marcel)'), null));

console.log('\no que já funcionava continua');
caso('"Marcel" casa com o Marcel Garcia', () => assert.strictEqual(achar('Marcel'), 'Marcel Garcia'));
caso('"Marcelle" casa com a Marcelle', () => assert.strictEqual(achar('Marcelle'), 'Marcelle'));
caso('"Prata" casa com o Thiago Prata', () => assert.strictEqual(achar('Prata'), 'Thiago Prata'));
caso('convidado cujo nome existe no elenco ainda casa', () =>
  assert.strictEqual(achar('Renan (cvd Fabrício)'), 'Renan'));

// No Windows o SQLite segura o arquivo aberto até o processo sair
try { fs.rmSync(pasta, { recursive: true, force: true }); } catch {}
console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo ok');
process.exit(falhas ? 1 : 0);
