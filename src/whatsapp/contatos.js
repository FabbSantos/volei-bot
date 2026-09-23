// Quem é quem no WhatsApp: resolver @lid pro número real, admins e membros
// de grupo (com cache) e a regra de quem pode mandar como admin.
const grupos = require('../modulos/grupos/repositorio');

const ADMIN_NUMBER = process.env.ADMIN_NUMBER || null; // ex: 5521999999999@c.us — seu número, pra comandos de admin no privado

// O wppconnect devolve ids como Wid (objeto) ou string, dependendo da chamada —
// normaliza tudo pra string tipo "5521999999999@c.us"
function widParaString(wid) {
  if (!wid) return null;
  if (typeof wid === 'string') return wid;
  if (wid._serialized) return wid._serialized;
  if (wid.user && wid.server) return `${wid.user}@${wid.server}`;
  return String(wid);
}

// Figurinha animada (.gif / .webp) precisa do método próprio; estática
// (.png/.jpg) vai pelo normal. Quem converte é o sharp, dentro do wppconnect.
function enviarFigurinhaNoChat(client, chatId, caminho) {
  const animada = /[.](gif|webp)$/i.test(caminho);
  return animada
    ? client.sendImageAsStickerGif(chatId, caminho)
    : client.sendImageAsSticker(chatId, caminho);
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
  for (const grupoAdmin of grupos.listarGruposAdmin()) {
    try {
      if (bateCom(await listarMembrosDoGrupo(client, grupoAdmin))) return true;
    } catch (err) {
      console.warn(`[admins] falha ao consultar membros de ${grupoAdmin}: ${err.message}`);
    }
  }

  return false; // na dúvida, nega — melhor que liberar pagamento pra todo mundo
}

module.exports = {
  ADMIN_NUMBER,
  enviarFigurinhaNoChat,
  lidParaNumero,
  listarAdminsDoGrupo,
  listarMembrosDoGrupo,
  ehAdminDoBot,
  ehAdminDoGrupo,
};
