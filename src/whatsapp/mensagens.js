// Escuta um cliente do WhatsApp: transforma cada mensagem na "porta" que os
// módulos entendem (ver nucleo/comandos.js) e entrega pro roteador.
const { processarMensagem, processarComandoAdmin } = require('../roteador');
const { notificarFalha } = require('../nucleo/alertas');
const grupos = require('../modulos/grupos/repositorio');
const {
  ADMIN_NUMBER, enviarFigurinhaNoChat, lidParaNumero, listarAdminsDoGrupo, listarMembrosDoGrupo, ehAdminDoBot, ehAdminDoGrupo,
} = require('./contatos');

const NOME_GRUPO_ALVO = process.env.NOME_GRUPO_ALVO || null; // opcional: filtrar por nome do grupo

// Porta dos comandos de admin — igual no privado e no grupo de admins
function portaDeAdmin(client, message, origem, sessao) {
  return {
    body: message.body,
    origem,
    reply: (texto) => client.sendText(message.from, texto),
    enviarPara: (chatId, texto, opcoes) => client.sendText(chatId, texto, opcoes),
    enviarFigurinhaPara: (chatId, caminho) => enviarFigurinhaNoChat(client, chatId, caminho),
    getAdminsDoGrupo: (chatId) => listarAdminsDoGrupo(client, chatId),
    saude: sessao.saudeDoProcesso,
    getMembrosDoGrupo: (chatId) => listarMembrosDoGrupo(client, chatId),
  };
}

function escutar(client, sessao) {
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
          await processarComandoAdmin(portaDeAdmin(client, message, 'privado', sessao));
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
      const grupoConhecido = grupos.getGrupo(message.from);
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
      const grupo = grupos.registrarGrupoSeNovo(message.from, nomeGrupo);
      if (grupo.eh_admin) {
        await processarComandoAdmin(portaDeAdmin(client, message, 'grupoadmin', sessao));
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

      await processarMensagem({
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
      });
    } catch (err) {
      console.error('Erro ao processar mensagem:', err);
      // Página travada não é erro de comando: é sessão morta. Reconecta em
      // vez de repetir o mesmo timeout em cada mensagem que chegar.
      if (sessao.paginaTravou(err)) {
        sessao.reconectarPorTravamento('página travou ao processar mensagem');
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
      sessao.agendarReconexao('conexão instável (flapping OPENING/PAIRING sem estabilizar)');
    }
  });

  console.log('Bot pronto e escutando mensagens.');
}

module.exports = { escutar };
