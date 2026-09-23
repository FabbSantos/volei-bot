// Ponto único onde os testes de comportamento encontram o bot — se a
// estrutura de pastas mudar, só este arquivo muda.
const { processarMensagem } = require('../../src/commands');
const { processarComandoAdmin } = require('../../src/adminCommands');
const { registrarPainel } = require('../../src/painel');
const db = require('../../src/db');

module.exports = { processarMensagem, processarComandoAdmin, registrarPainel, fecharBanco: db.fecharBanco };

// O processo inteiro (conexão, HTTP, relógios) — usado pelo teste do WhatsApp
module.exports.entrada = require.resolve('../../src/bot.js');
