// Servidor HTTP: página do QR, /status (o deploy espera o "inChat" daqui) e
// o painel dos admins.
const path = require('path');
const express = require('express');
const { registrarPainel } = require('./painel');
const { enviarArquivoNoChat } = require('../whatsapp/contatos');

// sessao: ver whatsapp/sessao.js — o servidor só lê o estado e envia por ela
function criarServidor(sessao) {
  const app = express();
  // A página do painel mora em public/, que é servida sem autenticação (é de lá
  // que sai a tela do QR). Sem esta linha, /painel.html entregaria a página
  // inteira por fora do login — os dados continuariam protegidos, mas não custa
  // fechar a porta.
  app.get('/painel.html', (req, res) => res.redirect('/painel'));
  app.get('/video.html', (req, res) => res.redirect('/painel/video'));
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  app.get('/status', (req, res) => {
    const { status, tentativasReconexao } = sessao.estado();
    res.json({ status, tentativasReconexao });
  });

  app.get('/qr', (req, res) => {
    const { qr } = sessao.estado();
    if (!qr) {
      return res.status(404).json({ erro: 'QR ainda não gerado ou já conectado' });
    }
    res.json({ qr });
  });

  registrarPainel(app, {
    // Usa sempre o cliente vigente — o painel publica times no grupo por aqui
    enviarPara: (chatId, texto, opcoes) => {
      const cliente = sessao.cliente();
      if (!cliente) return Promise.reject(new Error('bot desconectado'));
      return cliente.sendText(chatId, texto, opcoes);
    },
    // Os cortes de #replay saem por aqui quando o vídeo termina de processar
    enviarArquivoPara: (chatId, caminho, legenda) => {
      const cliente = sessao.cliente();
      if (!cliente) return Promise.reject(new Error('bot desconectado'));
      return enviarArquivoNoChat(cliente, chatId, caminho, legenda);
    },
  });

  return app;
}

module.exports = { criarServidor };
