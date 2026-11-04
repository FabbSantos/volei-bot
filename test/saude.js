// Teste de vida do WhatsApp: quando o bot está surdo e precisa reconectar.
const assert = require('assert');
const { avaliarEstadoDaConexao, avaliarSincronizacao, isLoggedAtrasado, LIMITE_FORA_DO_AR_MS } = require('../src/whatsapp/saude');

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

const MIN = 60_000;
console.log('\nestado da conexão (02/11/2026: parado em OPENING por 2 dias)');
caso('CONNECTED: tudo certo', () => assert.deepStrictEqual(avaliarEstadoDaConexao('CONNECTED', null, 0), { desde: null, reconectar: false }));
caso('OPENING: começa a vigiar', () => assert.deepStrictEqual(avaliarEstadoDaConexao('OPENING', null, 5 * MIN), { desde: 5 * MIN, reconectar: false }));
caso('OPENING há 9min: ainda espera', () => assert.strictEqual(avaliarEstadoDaConexao('OPENING', 0, 9 * MIN).reconectar, false));
caso('OPENING há 10min: reconecta', () => assert.strictEqual(avaliarEstadoDaConexao('OPENING', 0, LIMITE_FORA_DO_AR_MS).reconectar, true));
caso('voltou pra CONNECTED: zera', () => assert.strictEqual(avaliarEstadoDaConexao('CONNECTED', 0, 9 * MIN).desde, null));
caso('UNPAIRED: precisa de QR, não reconecta em loop', () => assert.strictEqual(avaliarEstadoDaConexao('UNPAIRED', 0, 60 * MIN).reconectar, false));
caso('estado vazio conta como fora do ar', () => assert.strictEqual(avaliarEstadoDaConexao(undefined, 0, 11 * MIN).reconectar, true));

console.log('\nsincronização');
caso('isLogged há 5min: reconecta', () => assert.strictEqual(avaliarSincronizacao('isLogged', 0, 5 * MIN).reconectar, true));
caso('inChat: tudo certo', () => assert.strictEqual(avaliarSincronizacao('inChat', 0, 5 * MIN).reconectar, false));
caso('isLogged depois de inChat é atraso, não surdez', () => assert.strictEqual(isLoggedAtrasado('isLogged', true), true));

if (falhas) {
  console.log(`\n${falhas} falha(s)`);
  process.exit(1);
}
console.log('\ntudo ok');
