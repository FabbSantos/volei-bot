// Ambiente determinístico pros testes de comportamento: banco temporário,
// relógio fixo e sorteio com semente. Precisa ser carregado ANTES de qualquer
// módulo do bot, porque o banco abre no require.
const fs = require('fs');
const os = require('os');
const path = require('path');

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'volei-golden-'));
process.env.DB_PATH = path.join(pasta, 'volei.db');
process.env.TOKENS_DIR = path.join(pasta, 'tokens');
process.env.TEST_MODE = 'true';
process.env.LEMBRETE_HORA = '10';
process.env.PAINEL_TOKEN = 'token-de-teste';
process.env.PAINEL_SENHA = 'senha';
process.env.HOST_APELIDO = 'maquina-de-teste';
delete process.env.FIGURINHA_QUITADO;
delete process.env.TELEGRAM_BOT_TOKEN;

// Sexta, 12h em Brasília. Cada leitura do relógio anda 1s, então os
// timestamps das entradas ficam em ordem sem depender da velocidade da máquina.
const DataReal = Date;
let agora = DataReal.parse('2026-09-18T15:00:00.000Z');
class DataFalsa extends DataReal {
  constructor(...args) {
    if (args.length === 0) {
      agora += 1000;
      super(agora);
    } else {
      super(...args);
    }
  }
  static now() {
    agora += 1000;
    return agora;
  }
}
global.Date = DataFalsa;

// mulberry32: mesma semente, mesmas zoeiras sorteadas
let semente = 42;
Math.random = () => {
  semente |= 0;
  semente = (semente + 0x6d2b79f5) | 0;
  let t = Math.imul(semente ^ (semente >>> 15), 1 | semente);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Caminhos absolutos mudam de máquina pra máquina; o que importa é o arquivo
const raiz = path.join(__dirname, '..', '..');
function limparCaminho(texto) {
  return String(texto).split(raiz).join('<raiz>').replace(/\\/g, '/');
}

function limpar() {
  try { fs.rmSync(pasta, { recursive: true, force: true }); } catch {}
}

module.exports = { pasta, limparCaminho, limpar };
