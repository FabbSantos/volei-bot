// Ponto único onde os testes de comportamento encontram o bot — se a
// estrutura de pastas mudar, só este arquivo muda.
const { processarMensagem, processarComandoAdmin } = require('../../src/roteador');
const { registrarPainel } = require('../../src/http/painel');
const { fecharBanco } = require('../../src/nucleo/banco');

module.exports = { processarMensagem, processarComandoAdmin, registrarPainel, fecharBanco };

// O processo inteiro (conexão, HTTP, relógios) — usado pelo teste do WhatsApp
Object.defineProperty(module.exports, 'entrada', { get: () => require.resolve('../../src/main.js') });
