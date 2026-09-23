// A sessão do WhatsApp: abrir o navegador, parear, reconectar quando cai e
// perceber quando o bot ficou surdo sem avisar. Só existe UM cliente por vez.
const fs = require('fs');
const os = require('os');
const path = require('path');
const wppconnect = require('@wppconnect-team/wppconnect');
const { notificarFalha } = require('../nucleo/alertas');
const { avaliarSincronizacao } = require('./saude');

// browserClose = o Chrome morreu com o processo vivo; autocloseCalled = o
// wppconnect desistiu de esperar o QR — nos dois casos, sem reconectar aqui
// o bot ficaria zumbi (de pé, mas surdo)
const ESTADOS_DESCONEXAO = ['CONFLICT', 'CLOSED', 'DISCONNECTED', 'DEPRECATED_VERSION', 'UNPAIRED', 'UNPAIRED_IDLE', 'browserClose', 'autocloseCalled', 'serverClose', 'disconnectedMobile', 'desconnectedMobile', 'qrReadFail'];
const DELAY_BASE_MS = 15_000;
const DELAY_MAX_MS = 60_000; // teto de 1min: quando o Chrome nem abre, esperar 5min só atrasa o container limpo
const TENTATIVAS_ANTES_DE_NOTIFICAR = 2;
const TENTATIVAS_ANTES_DE_REINICIAR = 5; // depois disso, sai do processo pro host subir um container limpo

let ultimoQrBase64 = null;
let statusConexao = 'iniciando';
let tentativasReconexao = 0;
let reconexaoAgendada = false;
let notificacaoEnviada = false; // evita spammar o Telegram a cada retry do mesmo incidente

// Quem vai escutar as mensagens de cada cliente novo (ver ./mensagens.js)
let aoConectar = () => {};

// Memória do CONTAINER inteiro, não só do Node: o Chrome roda em processo
// separado e é ele que pesa — medir só o process.memoryUsage() mostrava 89 MB
// enquanto o conjunto passava de 600. Fora de container, cai pro RSS mesmo.
function memoriaMb() {
  for (const caminho of ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory/memory.usage_in_bytes']) {
    try {
      const bytes = parseInt(fs.readFileSync(caminho, 'utf8').trim(), 10);
      if (Number.isFinite(bytes) && bytes > 0) return Math.round(bytes / 1024 / 1024);
    } catch {}
  }
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

// Estado que só a sessão conhece (conexão, processo, máquina). Vai como
// dependência pro #teste do grupo de admins — o resto do diagnóstico
// (banco, listas, figurinhas) o módulo de diagnóstico monta sozinho.
function saudeDoProcesso() {
  return {
    status: statusConexao,
    tentativas: tentativasReconexao,
    esperandoQr: Boolean(ultimoQrBase64),
    uptimeSegundos: Math.floor(process.uptime()),
    memoriaMb: memoriaMb(),
    // HOST_APELIDO é o nome que aparece no #teste. Dentro do container o
    // hostname é o ID do Docker, que muda a cada build e não diz nada.
    maquina: process.env.HOST_APELIDO || os.hostname(),
  };
}

// O Chrome grava travas (SingletonLock etc.) dentro do perfil. Com o perfil
// num volume persistente, a trava do container anterior sobrevive ao deploy e
// o Chrome novo recusa abrir ("profile is in use... on another computer").
// Remove as travas órfãs antes de cada tentativa de abrir o navegador.
function limparLocksDoChrome(dir) {
  let removidos = 0;
  const varrer = (pasta) => {
    let itens;
    try {
      itens = fs.readdirSync(pasta, { withFileTypes: true });
    } catch {
      return; // pasta ainda não existe (primeiro boot)
    }
    for (const item of itens) {
      const caminho = path.join(pasta, item.name);
      if (item.name.startsWith('Singleton')) {
        try {
          fs.rmSync(caminho, { force: true });
          removidos++;
        } catch {}
      } else if (item.isDirectory()) {
        varrer(caminho);
      }
    }
  };
  varrer(dir);
  if (removidos > 0) {
    console.log(`[browser] ${removidos} trava(s) órfã(s) do Chrome removida(s) de ${dir}`);
  }
}

// O perfil do Chrome mora no volume e o Chrome quase nunca sai limpo (kill na
// reconexão, OOM, restart do container): o perfil fica marcado "Crashed" e o
// boot seguinte RESTAURA as abas da sessão anterior — somando mais abas a cada
// reinício. Em 22/09/2026 eram 71 alvos no navegador: 20 abas do WhatsApp Web
// disputando a mesma conta e 38 about:blank. Com elas abertas, a aba do bot
// retinha o log interno do WhatsApp Web e a RAM subia ~0,5 GB/h até a página
// travar. Fechar as abas extras ao vivo derrubou o heap da aba do bot de 3,1 GB
// pra 71 MB, e ele parou de crescer. Apagar os arquivos de restauração antes de
// abrir o navegador corta a pilha na raiz. O pareamento mora no
// IndexedDB/Local Storage e não é tocado
// ("Session Storage" também fica: é outra coisa, do site).
const ARQUIVOS_DE_RESTAURACAO = new Set(['Current Session', 'Current Tabs', 'Last Session', 'Last Tabs']);

function limparSessaoRestauravel(dir) {
  let removidos = 0;
  const varrer = (pasta) => {
    let itens;
    try {
      itens = fs.readdirSync(pasta, { withFileTypes: true });
    } catch {
      return; // pasta ainda não existe (primeiro boot)
    }
    for (const item of itens) {
      const caminho = path.join(pasta, item.name);
      if ((item.isDirectory() && item.name === 'Sessions') || ARQUIVOS_DE_RESTAURACAO.has(item.name)) {
        try {
          fs.rmSync(caminho, { recursive: true, force: true });
          removidos++;
        } catch {}
      } else if (item.isDirectory()) {
        varrer(caminho);
      }
    }
  };
  varrer(dir);
  if (removidos > 0) {
    console.log(`[browser] ${removidos} arquivo(s) de restauração de abas removido(s) de ${dir}`);
  }
}

// Segunda linha de defesa: se mesmo assim o navegador subir com abas a mais,
// fecha todas menos a que o wppconnect usa. Duas abas do WhatsApp na mesma
// conta disputam a mesma sessão.
async function fecharAbasExtras(client) {
  const principal = client.page;
  if (!principal) return;
  const abas = await principal.browser().pages();
  let fechadas = 0;
  for (const aba of abas) {
    // O puppeteer guarda a Page em cache por alvo, então a identidade já basta.
    // A checagem pelo alvo é seguro: errar aqui fecharia a aba do próprio bot.
    if (aba === principal || aba.target() === principal.target()) continue;
    try {
      await aba.close();
      fechadas++;
    } catch {}
  }
  if (fechadas > 0) {
    console.log(`[browser] ${fechadas} aba(s) extra(s) fechada(s), sobrou só a do bot`);
  }
}

// Zera a sessão inteira (perfil do Chrome + pareamento) uma única vez no boot,
// quando RESET_SESSAO=1. Serve pra quando o perfil no volume fica corrompido
// depois de um crash — o Chrome trava em "database is locked" e não abre nem
// com as travas removidas. Custo: tem que ler o QR de novo.
let sessaoZerada = false;
function zerarSessaoSePedido(dir) {
  if (process.env.RESET_SESSAO !== '1' || sessaoZerada) return;
  sessaoZerada = true; // só no primeiro boot: reconexão não apaga sessão viva
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[browser] RESET_SESSAO=1 — perfil apagado de ${dir}, vai pedir QR novo`);
  } catch (err) {
    console.warn(`[browser] não consegui apagar ${dir}: ${err.message}`);
  }
}

// Só pode existir UM cliente por vez: dois clientes na mesma sessão ficam se
// derrubando em loop (OPENING → PAIRING → CONNECTED sem fim) e nenhum responde.
// A geração invalida eventos de clientes aposentados; o close() derruba o
// navegador antigo antes de abrir outro.
let clienteAtual = null;
let geracaoAtual = 0;

// Marca se o cliente ATUAL chegou a autenticar. Enquanto for falso, estados de
// "desconectado" significam sessão nova esperando QR, não queda de conexão.
let jaLogouNestaSessao = false;

async function iniciarSessao() {
  const geracao = ++geracaoAtual;
  jaLogouNestaSessao = false;

  const anterior = clienteAtual;
  clienteAtual = null;
  if (anterior) {
    try {
      await anterior.close();
      console.log('[browser] cliente antigo fechado antes de reconectar');
    } catch (err) {
      console.warn(`[browser] falha ao fechar cliente antigo: ${err.message}`);
    }
  }
  if (geracao !== geracaoAtual) return; // outra reconexão passou na frente

  zerarSessaoSePedido(process.env.TOKENS_DIR || 'tokens');
  limparLocksDoChrome(process.env.TOKENS_DIR || 'tokens');
  limparSessaoRestauravel(process.env.TOKENS_DIR || 'tokens');
  wppconnect
    .create({
      session: 'volei-bot',
      catchQR: (base64Qrimg, asciiQR, attempts) => {
        if (geracao !== geracaoAtual) return; // evento de cliente aposentado
        console.log(`QR code gerado (tentativa ${attempts})`);
        ultimoQrBase64 = base64Qrimg;
        statusConexao = 'aguardando_qr';
      },
      statusFind: (statusSession) => {
        if (geracao !== geracaoAtual) return; // evento de cliente aposentado
        console.log('Status da sessão:', statusSession);
        statusConexao = statusSession;

        if (['CONNECTED', 'inChat', 'isLogged'].includes(statusSession)) {
          jaLogouNestaSessao = true;
        }
        if (statusSession === 'CONNECTED' || statusSession === 'inChat') {
          ultimoQrBase64 = null;
          tentativasReconexao = 0; // conexão de volta ao normal, zera o contador
          notificacaoEnviada = false;
        }

        // Sessão desvinculada reporta "notLogged"/"disconnectedMobile" ENQUANTO
        // espera alguém ler o QR. Reconectar aí é fatal: o cliente novo aposenta
        // o antigo, o catchQR do antigo é descartado pela geração, e o /qr fica
        // 404 pra sempre — o bot nunca consegue mostrar o QR pra ser salvo.
        // Nesse caso quem decide é o autoclose do wppconnect (autocloseCalled),
        // que continua na lista e agenda a próxima tentativa.
        const esperandoPareamento =
          !jaLogouNestaSessao &&
          ['notLogged', 'disconnectedMobile', 'desconnectedMobile'].includes(statusSession);

        if (!esperandoPareamento && ESTADOS_DESCONEXAO.includes(statusSession)) {
          agendarReconexao(`status da sessão: "${statusSession}"`);
        }
      },
      // 5min pra ler o QR: com 60s a pessoa mal recebe o aviso e abre a página
      autoClose: 5 * 60_000,
      headless: true,
      // Sessão do WhatsApp no volume persistente — sem isso, cada redeploy
      // apaga o pareamento e obriga a escanear o QR de novo
      folderNameToken: process.env.TOKENS_DIR || 'tokens',
      puppeteerOptions: {
        // Curto de propósito: página travada tem que doer rápido pro teste de
        // vida agir. (O histórico da reconexão já é descartado por timestamp,
        // então não há mais rajada pra justificar timeout longo.)
        protocolTimeout: 90_000,
        // Dieta de processos/threads: o container do Railway tem teto de PIDs
        // e o Chrome padrão estoura ("pthread_create: Resource temporarily
        // unavailable" / "Zygote could not fork") mesmo em container novo.
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--renderer-process-limit=1',
          '--disable-features=site-per-process,IsolateOrigins,Translate,BackForwardCache,MediaRouter,OptimizationHints',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-breakpad',
          '--disable-crash-reporter',
          '--disable-extensions',
          '--disable-sync',
          '--disable-default-apps',
          '--no-first-run',
          '--no-default-browser-check',
          '--mute-audio',
          '--metrics-recording-only',
        ],
      },
    })
    .then((client) => {
      if (geracao !== geracaoAtual) {
        // Uma reconexão mais nova assumiu enquanto este cliente subia
        client.close().catch(() => {});
        return;
      }
      clienteAtual = client;
      fecharAbasExtras(client).catch((err) => console.warn(`[browser] falha ao fechar abas extras: ${err.message}`));
      aoConectar(client);
    })
    .catch((erro) => {
      if (geracao !== geracaoAtual) return;
      console.error('Erro ao iniciar WPPConnect:', erro);
      agendarReconexao(`erro ao iniciar: ${erro.message}`);
    });
}

function agendarReconexao(motivo) {
  if (reconexaoAgendada) return; // evita empilhar várias reconexões em paralelo
  reconexaoAgendada = true;
  tentativasReconexao++;

  // Retry infinito no mesmo processo acumula zumbi do Chrome até esgotar os PIDs
  // do container (fork passa a falhar com EAGAIN). Melhor morrer e deixar o host
  // reiniciar o container do zero, que nasce sem zumbi nenhum.
  if (tentativasReconexao >= TENTATIVAS_ANTES_DE_REINICIAR) {
    console.error(`[reconexao] ${tentativasReconexao} tentativas seguidas falharam — encerrando pro host subir um container limpo. Motivo: ${motivo}`);
    notificarFalha(
      `${tentativasReconexao} tentativas de reconexão falharam (última: ${motivo}). Reiniciando o container pra limpar recursos.`
    ).finally(() => process.exit(1));
    return;
  }

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

// Página travada não é erro de comando: é sessão morta. Quem pega o erro
// marca e reconecta em vez de repetir o mesmo timeout em cada mensagem.
function paginaTravou(err) {
  const msg = String(err?.message || err);
  return msg.includes('timed out') || msg.includes('Target closed')
    || msg.includes('Session closed') || msg.includes('detached');
}

function reconectarPorTravamento(motivo) {
  statusConexao = 'sem_resposta';
  agendarReconexao(motivo);
}

// ---- teste de vida da página -----------------------------------------------
// O modo de morte mais traiçoeiro: o Chrome continua de pé e os eventos até
// chegam, mas a PÁGINA do WhatsApp congela — toda chamada pendura e estoura
// em ProtocolError. Nenhum estado de desconexão é emitido, então o bot fica
// zumbi achando que está inChat. Um ping leve, com prazo curto, desmascara.
const SAUDE_INTERVALO_MS = 3 * 60_000;
const SAUDE_TIMEOUT_MS = 25_000;
let falhasSaude = 0;

// Vigia a SEGUNDA metade da reconexão: chegar em isLogged não basta, tem que
// terminar em inChat. A regra mora em ./saude pra poder ser testada.
let desdeQuandoIsLogged = null;

function vigiarSincronizacao() {
  if (!clienteAtual) { desdeQuandoIsLogged = null; return; }

  const r = avaliarSincronizacao(statusConexao, desdeQuandoIsLogged, Date.now());
  desdeQuandoIsLogged = r.desde;
  if (!r.reconectar) return;

  console.warn(`[saude] preso em isLogged há ${Math.round(r.paradoMs / 1000)}s — autenticado mas surdo, reconectando`);
  agendarReconexao('travou em isLogged sem chegar em inChat');
}

async function verificarSaude() {
  vigiarSincronizacao();

  const client = clienteAtual;
  if (!client) return;
  try {
    await Promise.race([
      client.getConnectionState(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('ping timed out')), SAUDE_TIMEOUT_MS)),
    ]);
    falhasSaude = 0;
  } catch (err) {
    falhasSaude++;
    console.warn(`[saude] página não respondeu (${falhasSaude}/2): ${err.message}`);
    if (falhasSaude >= 2) {
      falhasSaude = 0;
      reconectarPorTravamento('página do WhatsApp travada (teste de vida falhou 2x)');
    }
  }
}

module.exports = {
  SAUDE_INTERVALO_MS,
  iniciar: (opcoes) => {
    aoConectar = opcoes.aoConectar;
    iniciarSessao();
  },
  cliente: () => clienteAtual,
  estado: () => ({ status: statusConexao, tentativasReconexao, qr: ultimoQrBase64 }),
  saudeDoProcesso,
  agendarReconexao,
  paginaTravou,
  reconectarPorTravamento,
  verificarSaude,
};
