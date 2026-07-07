require('dotenv').config();
const express = require('express');
const path = require('path');
const wppconnect = require('@wppconnect-team/wppconnect');
const { processarMensagem } = require('./commands');
const { notificarFalha } = require('./notify');

const PORT = process.env.PORT || 3000;
const NOME_GRUPO_ALVO = process.env.NOME_GRUPO_ALVO || null; // opcional: filtrar por nome do grupo

const ESTADOS_DESCONEXAO = ['CONFLICT', 'CLOSED', 'DISCONNECTED', 'DEPRECATED_VERSION', 'UNPAIRED', 'UNPAIRED_IDLE'];
const DELAY_BASE_MS = 15_000;
const DELAY_MAX_MS = 5 * 60_000; // teto de 5min entre tentativas, pra não martelar o host
const TENTATIVAS_ANTES_DE_NOTIFICAR = 2;

let ultimoQrBase64 = null;
let statusConexao = 'iniciando';
let tentativasReconexao = 0;
let reconexaoAgendada = false;
let notificacaoEnviada = false; // evita spammar o Telegram a cada retry do mesmo incidente

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/status', (req, res) => {
  res.json({ status: statusConexao, tentativasReconexao });
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

function iniciarSessao() {
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

        if (statusSession === 'CONNECTED' || statusSession === 'inChat') {
          ultimoQrBase64 = null;
          tentativasReconexao = 0; // conexão de volta ao normal, zera o contador
          notificacaoEnviada = false;
        }

        if (ESTADOS_DESCONEXAO.includes(statusSession)) {
          agendarReconexao(`status da sessão: "${statusSession}"`);
        }
      },
      headless: true,
      puppeteerOptions: {
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      },
    })
    .then((client) => start(client))
    .catch((erro) => {
      console.error('Erro ao iniciar WPPConnect:', erro);
      agendarReconexao(`erro ao iniciar: ${erro.message}`);
    });
}

function agendarReconexao(motivo) {
  if (reconexaoAgendada) return; // evita empilhar várias reconexões em paralelo
  reconexaoAgendada = true;
  tentativasReconexao++;

  // backoff exponencial (15s, 30s, 60s... até 5min), pra não martelar o host
  // toda hora quando o problema é falta de recurso (ex: "Cannot fork")
  const delay = Math.min(DELAY_BASE_MS * 2 ** (tentativasReconexao - 1), DELAY_MAX_MS);

  console.warn(`[reconexao] tentativa ${tentativasReconexao} — motivo: ${motivo} — próxima em ${delay / 1000}s`);

  if (tentativasReconexao >= TENTATIVAS_ANTES_DE_NOTIFICAR && !notificacaoEnviada) {
    notificacaoEnviada = true; // só um alerta por incidente, não um por tentativa
    notificarFalha(
      `${tentativasReconexao} tentativas de reconexão seguidas falharam. Motivo mais recente: ${motivo}. Confere o /qr, pode ser que precise parear de novo ou faltar recurso no host.`
    );
  }

  setTimeout(() => {
    reconexaoAgendada = false;
    iniciarSessao();
  }, delay);
}

iniciarSessao();

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

  // Log auxiliar — a reconexão em si já é tratada via statusFind acima,
  // pra não disparar duas rotinas de retry em paralelo.
  client.onStateChange((state) => {
    console.log('Mudança de estado:', state);
  });

  console.log('Bot pronto e escutando mensagens.');
}
