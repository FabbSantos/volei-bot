require('dotenv').config();
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const wppconnect = require('@wppconnect-team/wppconnect');
const db = require('./db');
const { processarMensagem, acharFigurinhaCobranca, montarLembretePagamento } = require('./commands');
const { processarComandoAdmin } = require('./adminCommands');
const { notificarFalha } = require('./notify');
const { registrarPainel } = require('./painel');

const PORT = process.env.PORT || 3000;
const NOME_GRUPO_ALVO = process.env.NOME_GRUPO_ALVO || null; // opcional: filtrar por nome do grupo
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || null; // ex: 5521999999999@c.us — seu número, pra comandos de admin no privado

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

const app = express();
// A página do painel mora em public/, que é servida sem autenticação (é de lá
// que sai a tela do QR). Sem esta linha, /painel.html entregaria a página
// inteira por fora do login — os dados continuariam protegidos, mas não custa
// fechar a porta.
app.get('/painel.html', (req, res) => res.redirect('/painel'));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/status', (req, res) => {
  res.json({ status: statusConexao, tentativasReconexao });
});

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

// Estado que só o bot.js conhece (conexão, processo, máquina). Vai como
// dependência pro #teste do grupo de admins — o resto do diagnóstico
// (banco, listas, figurinhas) o adminCommands monta sozinho.
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

app.get('/qr', (req, res) => {
  if (!ultimoQrBase64) {
    return res.status(404).json({ erro: 'QR ainda não gerado ou já conectado' });
  }
  res.json({ qr: ultimoQrBase64 });
});

registrarPainel(app, {
  // Usa sempre o cliente vigente — o painel publica times no grupo por aqui
  enviarPara: (chatId, texto, opcoes) => {
    if (!clienteAtual) return Promise.reject(new Error('bot desconectado'));
    return clienteAtual.sendText(chatId, texto, opcoes);
  },
});

const servidorHttp = app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

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
      start(client);
    })
    .catch((erro) => {
      if (geracao !== geracaoAtual) return;
      console.error('Erro ao iniciar WPPConnect:', erro);
      agendarReconexao(`erro ao iniciar: ${erro.message}`);
    });
}

// O Railway manda SIGTERM ao trocar de container. Sem tratar, o Node sai
// com código 143 e o deploy antigo é carimbado como 'crashed' (e vem
// e-mail). Saindo com 0 depois de fechar tudo, a troca fica limpa.
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
    if (clienteAtual) await clienteAtual.close();
  } catch (err) {
    console.warn(`[shutdown] navegador: ${err.message}`);
  }
  db.fecharBanco();
  console.log('[shutdown] tudo fechado, até logo');
  process.exit(0);
}

process.on('SIGTERM', () => { encerrarComGraca('SIGTERM'); });
process.on('SIGINT', () => { encerrarComGraca('SIGINT'); });

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

iniciarSessao();

// ---- teste de vida da página -----------------------------------------------
// O modo de morte mais traiçoeiro: o Chrome continua de pé e os eventos até
// chegam, mas a PÁGINA do WhatsApp congela — toda chamada pendura e estoura
// em ProtocolError. Nenhum estado de desconexão é emitido, então o bot fica
// zumbi achando que está inChat. Um ping leve, com prazo curto, desmascara.
const SAUDE_INTERVALO_MS = 3 * 60_000;
const SAUDE_TIMEOUT_MS = 25_000;
let falhasSaude = 0;

function paginaTravou(err) {
  const msg = String(err?.message || err);
  return msg.includes('timed out') || msg.includes('Target closed')
    || msg.includes('Session closed') || msg.includes('detached');
}

async function verificarSaude() {
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
      statusConexao = 'sem_resposta';
      agendarReconexao('página do WhatsApp travada (teste de vida falhou 2x)');
    }
  }
}

setInterval(() => {
  verificarSaude().catch((err) => console.warn(`[saude] erro no teste: ${err.message}`));
}, SAUDE_INTERVALO_MS);

// ---- lembrete diário de pagamento ------------------------------------------
// Uma vez por dia (a partir de LEMBRETE_HORA, horário de Brasília), toda lista
// ABERTA que ainda tem devedor recebe o recado do agiota no grupo. O carimbo
// lembrete_em na lista garante no máximo um por dia, mesmo com deploy/restart.
const LEMBRETE_HORA = parseInt(process.env.LEMBRETE_HORA || '10', 10);
const TZ_BRASILIA = 'America/Sao_Paulo';

function agoraBrasilia() {
  const agora = new Date();
  return {
    dia: agora.toLocaleDateString('en-CA', { timeZone: TZ_BRASILIA }), // YYYY-MM-DD
    // hourCycle h23 explícito: com hour12:false, alguns ICU (ex: Node 20 do
    // container) usam ciclo 1-24 e meia-noite vira "24" — que passava no
    // filtro `>= LEMBRETE_HORA` e disparava o lembrete de madrugada
    hora: parseInt(
      new Intl.DateTimeFormat('en-GB', { timeZone: TZ_BRASILIA, hour: '2-digit', hourCycle: 'h23' }).format(agora),
      10
    ),
  };
}

async function enviarLembretesDePagamento() {
  const client = clienteAtual;
  if (!client) return; // desconectado — tenta de novo no próximo ciclo

  const { dia, hora } = agoraBrasilia();
  // Anti-NaN: se a hora vier ilegível por qualquer motivo, NÃO manda —
  // (NaN < X) é false e furaria o filtro silenciosamente
  if (!Number.isInteger(hora) || hora < LEMBRETE_HORA) return;

  for (const lista of db.listasParaLembrete(dia)) {
    const resumo = db.resumoPagamentos(lista.id);
    // Sem devedor não tem recado — e sem carimbo: se alguém entrar devendo
    // ainda hoje, o lembrete sai no próximo ciclo
    if (resumo.pendentes.length === 0) continue;
    try {
      // Marca quem tem WhatsApp conhecido — cutucão de verdade, com notificação
      const recado = montarLembretePagamento(resumo.pendentesComZap);
      await client.sendText(lista.chat_id, recado.texto, { mentionedList: recado.mencoes });
      // Figurinha "cadê meu pix" na sequência, se a imagem existir nos assets
      const figurinha = acharFigurinhaCobranca(resumo.pendentes);
      if (figurinha && fs.existsSync(figurinha)) {
        try {
          await enviarFigurinhaNoChat(client, lista.chat_id, figurinha);
        } catch (err) {
          console.warn(`[lembrete] figurinha falhou: ${err.message}`);
        }
      }
      db.marcarLembreteEnviado(lista.id, dia);
      console.log(`[lembrete] enviado pra lista ${lista.data_jogo} de ${lista.chat_id} (${resumo.pendentes.length} devendo)`);
    } catch (err) {
      console.warn(`[lembrete] falha ao enviar pra ${lista.chat_id}: ${err.message}`);
    }
  }
}

setInterval(() => {
  enviarLembretesDePagamento().catch((err) => console.warn(`[lembrete] erro: ${err.message}`));
}, 30 * 60_000);

// O wppconnect devolve ids como Wid (objeto) ou string, dependendo da chamada —
// normaliza tudo pra string tipo "5521999999999@c.us"
// Figurinha animada (.gif / .webp) precisa do método próprio; estática
// (.png/.jpg) vai pelo normal. Quem converte é o sharp, dentro do wppconnect.
function enviarFigurinhaNoChat(client, chatId, caminho) {
  const animada = /[.](gif|webp)$/i.test(caminho);
  return animada
    ? client.sendImageAsStickerGif(chatId, caminho)
    : client.sendImageAsSticker(chatId, caminho);
}

function widParaString(wid) {
  if (!wid) return null;
  if (typeof wid === 'string') return wid;
  if (wid._serialized) return wid._serialized;
  if (wid.user && wid.server) return `${wid.user}@${wid.server}`;
  return String(wid);
}

// Cache da lista de admins por grupo — evita consultar o WhatsApp a cada #pago.
// 5min de TTL: promover/rebaixar admin no grupo demora até isso pra valer no bot.
const CACHE_ADMINS_TTL_MS = 5 * 60_000;
const cacheAdmins = new Map(); // chatId -> { ids: string[], expira: epoch ms }

async function listarAdminsDoGrupo(client, chatId) {
  const agora = Date.now();
  const cache = cacheAdmins.get(chatId);
  if (cache && cache.expira > agora) return cache.ids;

  const wids = await client.getGroupAdmins(chatId);
  // Resolve @lid -> número real, senão a comparação com o remetente falha
  const ids = await Promise.all(
    (wids || []).map((w) => lidParaNumero(client, w))
  );
  const idsValidos = ids.filter(Boolean);
  cacheAdmins.set(chatId, { ids: idsValidos, expira: agora + CACHE_ADMINS_TTL_MS });
  return idsValidos;
}

// O WhatsApp novo endereça contatos como @lid (ID opaco de privacidade), sem
// relação numérica com o telefone. O wa-js mapeia LID -> número real; cacheia
// pra não consultar a página a cada mensagem.
const cacheLidNumero = new Map(); // '...@lid' -> '...@c.us'

async function lidParaNumero(client, id) {
  const jid = widParaString(id);
  if (!jid || !jid.endsWith('@lid')) return jid;
  if (cacheLidNumero.has(jid)) return cacheLidNumero.get(jid);
  try {
    const entrada = await client.page.evaluate(
      (x) => WPP.contact.getPnLidEntry(x),
      jid
    );
    const numero = entrada?.phoneNumber?._serialized;
    if (numero) {
      cacheLidNumero.set(jid, numero);
      return numero;
    }
  } catch (err) {
    console.warn(`[lid] falha ao resolver ${jid}: ${err.message}`);
  }
  return jid; // sem mapeamento, segue com o lid mesmo
}

const cacheMembros = new Map(); // chatId -> { ids, expira } — membros do grupo

// Usada pelo grupo de admins e pelo #anuncio. Num grupo endereçado por @lid,
// resolver 70 membros de uma vez são 70 consultas simultâneas à página — a
// mesma rajada que já estourou o protocolTimeout deste bot. Por isso vai em
// blocos: demora igual na primeira vez, mas não afoga a página.
async function listarMembrosDoGrupo(client, chatId) {
  const agora = Date.now();
  const cache = cacheMembros.get(chatId);
  if (cache && cache.expira > agora) return cache.ids;

  const membros = (await client.getGroupMembers(chatId)) || [];
  const idsValidos = [];
  const BLOCO = 10;
  for (let i = 0; i < membros.length; i += BLOCO) {
    const parte = await Promise.all(
      membros.slice(i, i + BLOCO).map((c) => lidParaNumero(client, c?.id ?? c))
    );
    idsValidos.push(...parte.filter(Boolean));
  }
  cacheMembros.set(chatId, { ids: idsValidos, expira: agora + CACHE_ADMINS_TTL_MS });
  return idsValidos;
}

// Compara com o ADMIN_NUMBER tolerando sufixo diferente (@c.us vs @lid) —
// o WhatsApp às vezes entrega o mesmo contato com endereçamentos distintos
function ehAdminDoBot(numero) {
  if (!ADMIN_NUMBER || !numero) return false;
  if (numero === ADMIN_NUMBER) return true;
  return String(numero).split('@')[0] === ADMIN_NUMBER.split('@')[0];
}

async function ehAdminDoGrupo(client, chatId, numero) {
  if (ehAdminDoBot(numero)) return true; // admin do bot pode tudo
  if (!numero) return false;

  // Fallback comparando só a parte antes do @ — cobre divergência de sufixo
  // (@c.us vs @lid) entre o remetente e as listas em alguns grupos
  const usuario = String(numero).split('@')[0];
  const bateCom = (ids) => ids.includes(numero) || ids.some((id) => id.split('@')[0] === usuario);

  try {
    if (bateCom(await listarAdminsDoGrupo(client, chatId))) return true;
  } catch (err) {
    console.warn(`[admins] falha ao consultar admins de ${chatId}: ${err.message}`);
  }

  // "Admin geral": quem está no grupo de admins manda em qualquer grupo de
  // pelada — quem controla é a membresia daquele grupo
  for (const grupoAdmin of db.listarGruposAdmin()) {
    try {
      if (bateCom(await listarMembrosDoGrupo(client, grupoAdmin))) return true;
    } catch (err) {
      console.warn(`[admins] falha ao consultar membros de ${grupoAdmin}: ${err.message}`);
    }
  }

  return false; // na dúvida, nega — melhor que liberar pagamento pra todo mundo
}

function start(client) {
  // Na reconexão o WhatsApp despeja o histórico offline como onMessage novo.
  // Processar isso responderia comando velho e afogaria a página do WhatsApp
  // em consultas (foi o que estourou o protocolTimeout) — só vale mensagem
  // que chegar de agora (com 60s de folga) em diante.
  const iniciadoEm = Math.floor(Date.now() / 1000) - 60;

  client.onMessage(async (message) => {
    try {
      if (!message.body) return;
      if (message.t && message.t < iniciadoEm) return; // histórico da reconexão

      const ehGrupo = message.isGroupMsg || (message.from || '').endsWith('@g.us');

      if (!ehGrupo) {
        // Mensagem privada: só processa se vier do número admin configurado.
        // Isso permite ativar/desativar grupos sem precisar estar neles.
        const remetente = await lidParaNumero(client, message.from);
        if (ehAdminDoBot(remetente)) {
          await processarComandoAdmin({
            body: message.body,
            origem: 'privado',
            reply: (texto) => client.sendText(message.from, texto),
            enviarPara: (chatId, texto, opcoes) => client.sendText(chatId, texto, opcoes),
            enviarFigurinhaPara: (chatId, caminho) => enviarFigurinhaNoChat(client, chatId, caminho),
            getAdminsDoGrupo: (chatId) => listarAdminsDoGrupo(client, chatId),
            saude: saudeDoProcesso,
            getMembrosDoGrupo: (chatId) => listarMembrosDoGrupo(client, chatId),
          });
        } else {
          // Log de diagnóstico: mostra o JID exato que chegou, pra conferir
          // com o ADMIN_NUMBER configurado no host
          console.log(
            `[privado] mensagem de ${remetente} ignorada — ADMIN_NUMBER=${ADMIN_NUMBER || '(não configurado!)'}`
          );
        }
        return;
      }

      // Grupo de admins: comandos remotos de gestão, não tem lista própria.
      // Qualquer membro dele pode comandar — quem controla é a membresia do grupo.
      let nomeGrupo = message.chat?.name || null;
      const grupoConhecido = db.getGrupo(message.from);
      if (!nomeGrupo && !grupoConhecido?.nome) {
        // Só consulta o chat quando ainda não temos o nome — fazer isso a cada
        // mensagem afogava a página do WhatsApp e estourava o protocolTimeout
        try {
          const chat = await client.getChatById(message.from);
          nomeGrupo = chat?.name || chat?.contact?.name || chat?.formattedTitle || null;
        } catch (err) {
          console.warn(`[grupos] falha ao buscar nome de ${message.from}: ${err.message}`);
        }
      }
      const grupo = db.registrarGrupoSeNovo(message.from, nomeGrupo);
      if (grupo.eh_admin) {
        await processarComandoAdmin({
          body: message.body,
          origem: 'grupoadmin',
          reply: (texto) => client.sendText(message.from, texto),
          enviarPara: (chatId, texto, opcoes) => client.sendText(chatId, texto, opcoes),
          enviarFigurinhaPara: (chatId, caminho) => enviarFigurinhaNoChat(client, chatId, caminho),
          getAdminsDoGrupo: (chatId) => listarAdminsDoGrupo(client, chatId),
          saude: saudeDoProcesso,
            getMembrosDoGrupo: (chatId) => listarMembrosDoGrupo(client, chatId),
        });
        return;
      }

      // Se quiser restringir a um grupo específico, descomente:
      // if (NOME_GRUPO_ALVO && message.chat?.name !== NOME_GRUPO_ALVO) return;

      // Remetente individual dentro do grupo, com @lid resolvido pro número
      // real — senão dedup, #pago via comprovante e permissão quebram
      const numero = await lidParaNumero(
        client,
        message.author || message.sender?.id || message.from
      );

      const msg = {
        body: message.body,
        pushname: message.notifyName || message.sender?.pushname,
        chatId: message.from, // JID do grupo — usado pra isolar cada lista por grupo
        numero,
        nomeGrupo,
        reply: (texto) => client.sendText(message.from, texto),
        enviarFigurinha: async (caminho) => {
          try {
            await enviarFigurinhaNoChat(client, message.from, caminho);
          } catch (err) {
            console.warn(`[figurinha] falha ao enviar: ${err.message}`);
          }
        },
        ehAdmin: () => ehAdminDoGrupo(client, message.from, numero),
        // Quem enviou a mensagem que está sendo respondida (ex: o comprovante)
        remetenteCitado: async () => {
          if (!message.quotedMsgId) return null;
          try {
            const citada = await client.getMessageById(message.quotedMsgId);
            return await lidParaNumero(client, citada?.author || citada?.sender?.id || citada?.from);
          } catch (err) {
            console.warn(`[citada] falha ao buscar mensagem citada: ${err.message}`);
            return null;
          }
        },
      };

      await processarMensagem(msg);
    } catch (err) {
      console.error('Erro ao processar mensagem:', err);
      // Página travada não é erro de comando: é sessão morta. Reconecta em
      // vez de repetir o mesmo timeout em cada mensagem que chegar.
      if (paginaTravou(err)) {
        statusConexao = 'sem_resposta';
        agendarReconexao('página travou ao processar mensagem');
      } else {
        notificarFalha(`erro processando mensagem: ${err.message}`);
      }
    }
  });

  // Vigia de flapping: quando a sessão morre de verdade (celular derruba o
  // aparelho), o wppconnect às vezes NÃO emite nenhum estado de desconexão —
  // fica ciclando OPENING → PAIRING → CONNECTED pra sempre, e o bot vira
  // zumbi "conectado". 8+ OPENINGs em 10min = instável: recria o cliente
  // (e se a sessão estiver morta, o QR aparece e o Telegram avisa).
  const aberturas = [];
  client.onStateChange((state) => {
    console.log('Mudança de estado:', state);
    if (state !== 'OPENING') return;
    const agora = Date.now();
    aberturas.push(agora);
    while (aberturas.length > 0 && agora - aberturas[0] > 10 * 60_000) aberturas.shift();
    if (aberturas.length >= 8) {
      aberturas.length = 0;
      console.warn('[reconexao] conexão instável: 8+ ciclos de OPENING em 10min — recriando o cliente');
      agendarReconexao('conexão instável (flapping OPENING/PAIRING sem estabilizar)');
    }
  });

  console.log('Bot pronto e escutando mensagens.');
}
