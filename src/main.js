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
const { enviarFigurinhaNoChat, enviarArquivoNoChat } = require('./whatsapp/contatos');
const { listarGruposAdmin } = require('./modulos/grupos/repositorio');
const { iniciarVigiaDoDrive } = require('./modulos/video/vigiaDrive');
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

setInterval(() => {
  const cliente = sessao.cliente();
  const canal = cliente && {
    enviarTexto: (chatId, texto, opcoes) => cliente.sendText(chatId, texto, opcoes),
    enviarFigurinha: (chatId, caminho) => enviarFigurinhaNoChat(cliente, chatId, caminho),
  };
  lembrete.enviarLembretesDePagamento(canal).catch((err) => console.warn(`[lembrete] erro: ${err.message}`));
}, lembrete.INTERVALO_MS);
