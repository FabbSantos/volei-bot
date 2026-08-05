require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const wppconnect = require('@wppconnect-team/wppconnect');
const db = require('./db');
const { processarMensagem } = require('./commands');
const { processarComandoAdmin } = require('./adminCommands');
const { notificarFalha } = require('./notify');

const PORT = process.env.PORT || 3000;
const NOME_GRUPO_ALVO = process.env.NOME_GRUPO_ALVO || null; // opcional: filtrar por nome do grupo
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || null; // ex: 5521999999999@c.us — seu número, pra comandos de admin no privado

// browserClose = o Chrome morreu com o processo vivo; autocloseCalled = o
// wppconnect desistiu de esperar o QR — nos dois casos, sem reconectar aqui
// o bot ficaria zumbi (de pé, mas surdo)
const ESTADOS_DESCONEXAO = ['CONFLICT', 'CLOSED', 'DISCONNECTED', 'DEPRECATED_VERSION', 'UNPAIRED', 'UNPAIRED_IDLE', 'browserClose', 'autocloseCalled', 'serverClose'];
const DELAY_BASE_MS = 15_000;
const DELAY_MAX_MS = 5 * 60_000; // teto de 5min entre tentativas, pra não martelar o host
const TENTATIVAS_ANTES_DE_NOTIFICAR = 2;
const TENTATIVAS_ANTES_DE_REINICIAR = 10; // depois disso, sai do processo pro host subir um container limpo

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

// Só pode existir UM cliente por vez: dois clientes na mesma sessão ficam se
// derrubando em loop (OPENING → PAIRING → CONNECTED sem fim) e nenhum responde.
// A geração invalida eventos de clientes aposentados; o close() derruba o
// navegador antigo antes de abrir outro.
let clienteAtual = null;
let geracaoAtual = 0;

async function iniciarSessao() {
  const geracao = ++geracaoAtual;

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
      // Sessão do WhatsApp no volume persistente — sem isso, cada redeploy
      // apaga o pareamento e obriga a escanear o QR de novo
      folderNameToken: process.env.TOKENS_DIR || 'tokens',
      puppeteerOptions: {
        // A rajada de mensagens da reconexão enfileira chamadas na página e o
        // timeout padrão (180s) estoura ("Runtime.callFunctionOn timed out")
        protocolTimeout: 480_000,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
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

// O wppconnect devolve ids como Wid (objeto) ou string, dependendo da chamada —
// normaliza tudo pra string tipo "5521999999999@c.us"
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

const cacheMembros = new Map(); // chatId -> { ids, expira } — membros do grupo de admins

async function listarMembrosDoGrupo(client, chatId) {
  const agora = Date.now();
  const cache = cacheMembros.get(chatId);
  if (cache && cache.expira > agora) return cache.ids;

  const membros = await client.getGroupMembers(chatId);
  const ids = await Promise.all(
    (membros || []).map((c) => lidParaNumero(client, c?.id ?? c))
  );
  const idsValidos = ids.filter(Boolean);
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
            enviarPara: (chatId, texto) => client.sendText(chatId, texto),
            enviarFigurinhaPara: (chatId, caminho) => client.sendImageAsSticker(chatId, caminho),
            getAdminsDoGrupo: (chatId) => listarAdminsDoGrupo(client, chatId),
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
          enviarPara: (chatId, texto) => client.sendText(chatId, texto),
          enviarFigurinhaPara: (chatId, caminho) => client.sendImageAsSticker(chatId, caminho),
          getAdminsDoGrupo: (chatId) => listarAdminsDoGrupo(client, chatId),
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
            await client.sendImageAsSticker(message.from, caminho);
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
