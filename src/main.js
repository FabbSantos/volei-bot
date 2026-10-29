// Ponto de entrada: liga o servidor HTTP, a sessão do WhatsApp e os relógios.
//
// O bot é um monólito modular:
//   nucleo/    o que todo módulo usa (banco, dinheiro, texto, tempo, alertas)
//   modulos/   um por assunto (grupos, pelada, mensalistas, inadimplentes,
//              elenco...), cada um com repositório, comandos e rotas do painel
//   roteador   junta os comandos de todos os módulos
//   whatsapp/  o canal: sessão, contatos e a tradução mensagem → comando
//   http/      servidor, QR e painel
require('dotenv').config();
const { fecharBanco } = require('./nucleo/banco');
const sessao = require('./whatsapp/sessao');
const { escutar } = require('./whatsapp/mensagens');
const { enviarFigurinhaNoChat, enviarArquivoNoChat, enviarEnqueteNoChat, lerVotosDaEnquete } = require('./whatsapp/contatos');
const destaque = require('./modulos/destaque');
const { listarGruposAdmin } = require('./modulos/grupos/repositorio');
const { iniciarVigiaDoDrive } = require('./modulos/video/vigiaDrive');
const agenda = require('./modulos/pelada/agenda');
const { processarComandoAdmin } = require('./roteador');
const { criarServidor } = require('./http/servidor');
const lembrete = require('./modulos/pelada/lembrete');

const PORT = process.env.PORT || 3000;

const servidorHttp = criarServidor(sessao).listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

// O host manda SIGTERM ao trocar de container. Sem tratar, o Node sai com
// código 143 e o container antigo é carimbado como 'crashed'. Saindo com 0
// depois de fechar tudo, a troca fica limpa.
let encerrando = false;
async function encerrarComGraca(sinal) {
  if (encerrando) return;
  encerrando = true;
  console.log(`[shutdown] ${sinal} recebido — encerrando com calma`);

  // Rede lenta não pode segurar o desligamento: 8s e vai embora assim mesmo
  const prazo = setTimeout(() => {
    console.warn('[shutdown] demorou demais, saindo do jeito que dá');
    process.exit(0);
  }, 8000);
  prazo.unref();

  try {
    await new Promise((resolve) => servidorHttp.close(resolve));
  } catch (err) {
    console.warn(`[shutdown] servidor http: ${err.message}`);
  }
  try {
    const cliente = sessao.cliente();
    if (cliente) await cliente.close();
  } catch (err) {
    console.warn(`[shutdown] navegador: ${err.message}`);
  }
  fecharBanco();
  console.log('[shutdown] tudo fechado, até logo');
  process.exit(0);
}

process.on('SIGTERM', () => { encerrarComGraca('SIGTERM'); });
process.on('SIGINT', () => { encerrarComGraca('SIGINT'); });

sessao.iniciar({ aoConectar: (client) => escutar(client, sessao) });

setInterval(() => {
  sessao.verificarSaude().catch((err) => console.warn(`[saude] erro no teste: ${err.message}`));
}, sessao.SAUDE_INTERVALO_MS);

console.log(lembrete.descreverConfiguracao());

// Vídeo do jogo que chega pela pasta do Drive: os cortes dos #replay saem
// pelo cliente vigente do WhatsApp
iniciarVigiaDoDrive({
  enviarTexto: (chatId, texto) => {
    const cliente = sessao.cliente();
    if (!cliente) return Promise.reject(new Error('bot desconectado'));
    return cliente.sendText(chatId, texto);
  },
  enviarArquivo: (chatId, caminho, legenda) => {
    const cliente = sessao.cliente();
    if (!cliente) return Promise.reject(new Error('bot desconectado'));
    return enviarArquivoNoChat(cliente, chatId, caminho, legenda);
  },
  gruposAdmin: () => listarGruposAdmin(),
});

// Agenda de abertura da lista ("toda quarta 13h, a da sexta"): quem abre é
// o próprio #abrirlistade, como se um admin tivesse mandado — mesma lista,
// mesmo anúncio. A resposta dele vai pro grupo de admins.
async function abrirListaAgendada(agendaDoGrupo, { dataJogo, valor, nome }) {
  const cliente = sessao.cliente();
  if (!cliente) throw new Error('bot desconectado');
  const avisarAdmins = async (texto) => {
    for (const chatId of listarGruposAdmin()) {
      try { await cliente.sendText(chatId, texto); } catch (err) { console.warn(`[agenda] aviso não saiu: ${err.message}`); }
    }
  };
  const especial = valor != null ? ` ${(valor / 100).toString().replace('.', ',')}${nome ? ` ${nome}` : ''}` : '';
  console.log(`[agenda] abrindo a lista de ${dataJogo} em ${agendaDoGrupo.chat_id}`);
  await processarComandoAdmin({
    body: `#abrirlistade ${agendaDoGrupo.chat_id} ${dataJogo}${especial}`,
    origem: 'agenda',
    chatId: null,
    autor: 'agenda',
    reply: (texto) => avisarAdmins(`🤖📅 (agenda) ${texto}`),
    enviarPara: (chatId, texto, opcoes) => cliente.sendText(chatId, texto, opcoes),
    enviarFigurinhaPara: (chatId, caminho) => enviarFigurinhaNoChat(cliente, chatId, caminho),
  });
}

setInterval(() => {
  const cliente = sessao.cliente();
  if (!cliente) return; // fora do ar: tenta de novo quando voltar
  agenda.verificar(abrirListaAgendada).catch((err) => console.warn(`[agenda] erro: ${err.message}`));
  // Destaque da noite: enquetes 30min depois do jogo, resultado no dia seguinte
  destaque.verificar({
    enviarTexto: (chatId, texto) => cliente.sendText(chatId, texto),
    enviarEnquete: (chatId, titulo, opcoes) => enviarEnqueteNoChat(cliente, chatId, titulo, opcoes),
    lerVotos: (msgId) => lerVotosDaEnquete(cliente, msgId),
    gruposAdmin: () => listarGruposAdmin(),
  }).catch((err) => console.warn(`[destaque] erro: ${err.message}`));
}, 60_000);

setInterval(() => {
  const cliente = sessao.cliente();
  const canal = cliente && {
    enviarTexto: (chatId, texto, opcoes) => cliente.sendText(chatId, texto, opcoes),
    enviarFigurinha: (chatId, caminho) => enviarFigurinhaNoChat(cliente, chatId, caminho),
  };
  lembrete.enviarLembretesDePagamento(canal).catch((err) => console.warn(`[lembrete] erro: ${err.message}`));
}, lembrete.INTERVALO_MS);
