require('dotenv').config();
const express = require('express');
const path = require('path');
const wppconnect = require('@wppconnect-team/wppconnect');
const { processarMensagem } = require('./commands');
const { notificarFalha } = require('./notify');

const PORT = process.env.PORT || 3000;
const NOME_GRUPO_ALVO = process.env.NOME_GRUPO_ALVO || null; // opcional: filtrar por nome do grupo

let ultimoQrBase64 = null;
let statusConexao = 'iniciando';

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/status', (req, res) => {
  res.json({ status: statusConexao });
});

app.get('/qr', (req, res) => {
  if (!ultimoQrBase64) {
    return res.status(404).json({ erro: 'QR ainda não gerado ou já conectado' });
  }
  res.json({ qr: ultimoQrBase64 });
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

wppconnect
  .create({
    session: 'volei-bot',
    catchQR: (base64Qrimg, asciiQR, attempts) => {
      console.log(`QR code gerado (tentativa ${attempts})`);
      ultimoQrBase64 = base64Qrimg;
      statusConexao = 'aguardando_qr';
    },
    statusFind: (statusSession) => {
      console.log('Status da sessão:', statusSession);
      statusConexao = statusSession;
      if (['CONFLICT', 'CLOSED', 'DISCONNECTED', 'DEPRECATED_VERSION'].includes(statusSession)) {
        notificarFalha(`sessão caiu com status "${statusSession}". Precisa reconectar via /qr.`);
      }
      if (statusSession === 'CONNECTED' || statusSession === 'inChat') {
        ultimoQrBase64 = null;
      }
    },
    headless: true,
    puppeteerOptions: {
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  })
  .then((client) => start(client))
  .catch((erro) => {
    console.error('Erro ao iniciar WPPConnect:', erro);
    notificarFalha(`erro fatal ao iniciar: ${erro.message}`);
  });

function start(client) {
  client.onMessage(async (message) => {
    try {
      // Se quiser restringir a um grupo específico, descomente:
      // if (NOME_GRUPO_ALVO && message.chat?.name !== NOME_GRUPO_ALVO) return;

      if (!message.body) return;

      const msg = {
        body: message.body,
        pushname: message.notifyName || message.sender?.pushname,
        from: message.from,
        reply: (texto) => client.sendText(message.from, texto),
      };

      await processarMensagem(msg);
    } catch (err) {
      console.error('Erro ao processar mensagem:', err);
      notificarFalha(`erro processando mensagem: ${err.message}`);
    }
  });

  client.onStateChange((state) => {
    console.log('Mudança de estado:', state);
    if (state === 'CONFLICT' || state === 'UNPAIRED' || state === 'UNPAIRED_IDLE') {
      notificarFalha(`estado da conexão mudou para "${state}". Verifique o WhatsApp.`);
    }
  });

  console.log('Bot pronto e escutando mensagens.');
}
