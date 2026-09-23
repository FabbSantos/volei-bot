// Junta os comandos de todos os módulos e decide quem responde cada mensagem.
// Não sabe nada de WhatsApp: recebe a "porta" `msg` (ver nucleo/comandos.js)
// de quem estiver na ponta — o whatsapp/ hoje, os testes também.
const { despachar } = require('./nucleo/comandos');
const grupos = require('./modulos/grupos/repositorio');
const peladaGrupo = require('./modulos/pelada/comandosGrupo');
const peladaAdmin = require('./modulos/pelada/comandosAdmin');
const mensalistasGrupo = require('./modulos/mensalistas/comandosGrupo');
const mensalistasAdmin = require('./modulos/mensalistas/comandosAdmin');
const inadimplentesGrupo = require('./modulos/inadimplentes/comandosGrupo');
const gruposAdmin = require('./modulos/grupos/comandosAdmin');
const elencoAdmin = require('./modulos/elenco/comandosAdmin');
const diagnostico = require('./modulos/diagnostico');
const ajuda = require('./modulos/ajuda');

// Dentro do grupo da pelada
const COMANDOS_DO_GRUPO = [
  ...peladaGrupo.comandos,
  ...mensalistasGrupo.comandos,
  ...inadimplentesGrupo.comandos,
  ...peladaGrupo.comandosDeTeste,
  ...ajuda.comandosGrupo,
];

// No privado do dono do bot ou no grupo de admins
const COMANDOS_DE_ADMIN = [
  ...gruposAdmin.comandosCadastro,
  ...peladaAdmin.comandos,
  ...elencoAdmin.comandos,
  ...mensalistasAdmin.comandos,
  ...gruposAdmin.comandos,
  ...diagnostico.comandos,
  ...ajuda.comandosAdmin,
];

async function processarMensagem(msg) {
  const texto = (msg.body || '').trim();

  // Cadastra o grupo silenciosamente na primeira mensagem — não faz
  // nada além disso até algum comando de fato ser reconhecido.
  const grupo = grupos.registrarGrupoSeNovo(msg.chatId, msg.nomeGrupo);

  if (!grupo.ativo) {
    // Só avisa se for de fato um comando reconhecido do bot (ex: #lista,
    // #lista05/07, #mostralista...), não qualquer mensagem com # no meio
    // do papo normal do grupo (tipo "#quintou").
    if (COMANDOS_DO_GRUPO.some((c) => c.casa(texto))) {
      return msg.reply('🔒 Esse grupo ainda não foi liberado pra usar o bot. Fala com quem administra.');
    }
    return;
  }

  if (await despachar(COMANDOS_DO_GRUPO, texto, msg, { grupo })) return;
  return ajuda.responderMalformadoNoGrupo(msg, texto);
}

// Já validado antes de chegar aqui: veio do número admin (privado) ou do grupo de admins.
async function processarComandoAdmin(msg) {
  const texto = (msg.body || '').trim();
  if (await despachar(COMANDOS_DE_ADMIN, texto, msg, {})) return;
  return ajuda.responderMalformadoNoAdmin(msg, texto);
}

module.exports = { processarMensagem, processarComandoAdmin };
