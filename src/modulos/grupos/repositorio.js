// Grupos do WhatsApp em que o bot está: cadastro automático, liberação pelo
// admin, tamanho da lista e o grupo de admins.
const { db, migrarColunas } = require('../../nucleo/banco');
const { normalizarTexto } = require('../../nucleo/texto');

// Padrões — cada grupo pode ter o seu, ajustado via #ativargrupo no privado do admin
const LIMITE_PRINCIPAL = 18;
const LIMITE_ESPERA = 6;

db.exec(`
  CREATE TABLE IF NOT EXISTS grupos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL UNIQUE,   -- JID do grupo, ex: 123456789-987654321@g.us
    nome TEXT,
    ativo INTEGER NOT NULL DEFAULT 1, -- reservado pra futuro liga/desliga por cobrança
    primeira_mensagem_em TEXT NOT NULL,
    limite_principal INTEGER NOT NULL DEFAULT ${LIMITE_PRINCIPAL},
    limite_espera INTEGER NOT NULL DEFAULT ${LIMITE_ESPERA},
    eh_admin INTEGER NOT NULL DEFAULT 0, -- grupo de admins: comandos remotos, não tem lista própria
    valor_padrao_centavos INTEGER NOT NULL DEFAULT 0 -- 0 = sem valor definido
  );
`);
migrarColunas('grupos', {
  limite_principal: `INTEGER NOT NULL DEFAULT ${LIMITE_PRINCIPAL}`,
  limite_espera: `INTEGER NOT NULL DEFAULT ${LIMITE_ESPERA}`,
  eh_admin: 'INTEGER NOT NULL DEFAULT 0',
  valor_padrao_centavos: 'INTEGER NOT NULL DEFAULT 0',
});

// Cadastra o grupo na primeira vez que ele manda qualquer mensagem.
// Fica INATIVO por padrão — precisa ser liberado manualmente via comando
// de admin no privado (#ativargrupo) antes de aceitar comandos de lista.
function registrarGrupoSeNovo(chatId, nomeGrupo) {
  const existente = db.prepare('SELECT * FROM grupos WHERE chat_id = ?').get(chatId);
  if (existente) {
    // Mantém o nome fresco: grupo renomeado no WhatsApp continua achável
    // por nome nos comandos remotos (#listade, #valorde...)
    if (nomeGrupo && nomeGrupo !== existente.nome) {
      db.prepare('UPDATE grupos SET nome = ? WHERE chat_id = ?').run(nomeGrupo, chatId);
      existente.nome = nomeGrupo;
    }
    return existente;
  }

  // Limites explícitos no INSERT: o DEFAULT da coluna congela no valor da época
  // da migração, então banco antigo teria o padrão velho pra grupos novos
  db.prepare(
    'INSERT INTO grupos (chat_id, nome, ativo, primeira_mensagem_em, limite_principal, limite_espera) VALUES (?, ?, 0, ?, ?, ?)'
  ).run(chatId, nomeGrupo || null, new Date().toISOString(), LIMITE_PRINCIPAL, LIMITE_ESPERA);

  console.log(`[grupos] novo grupo cadastrado (inativo): ${chatId} (${nomeGrupo || 'sem nome'})`);
  return db.prepare('SELECT * FROM grupos WHERE chat_id = ?').get(chatId);
}

function getGrupo(chatId) {
  return db.prepare('SELECT * FROM grupos WHERE chat_id = ?').get(chatId);
}

// limites é opcional: { principal, espera } — só atualiza o que vier como número,
// então dá pra reativar/redimensionar sem perder o tamanho já configurado.
// Quem estava na espera e passou a caber sobe no comando (#ativargrupo), que
// chama o módulo da pelada — grupo não conhece lista.
function ativarGrupo(chatId, limites = {}) {
  const sets = ['ativo = 1'];
  const params = [];
  if (Number.isInteger(limites.principal)) {
    sets.push('limite_principal = ?');
    params.push(limites.principal);
  }
  if (Number.isInteger(limites.espera)) {
    sets.push('limite_espera = ?');
    params.push(limites.espera);
  }
  const info = db.prepare(`UPDATE grupos SET ${sets.join(', ')} WHERE chat_id = ?`).run(...params, chatId);
  return info.changes > 0;
}

function desativarGrupo(chatId) {
  const info = db.prepare('UPDATE grupos SET ativo = 0 WHERE chat_id = ?').run(chatId);
  return info.changes > 0;
}

function listarGrupos() {
  return db.prepare('SELECT * FROM grupos ORDER BY primeira_mensagem_em DESC').all();
}

function setarValorPadraoGrupo(chatId, centavos) {
  const info = db.prepare('UPDATE grupos SET valor_padrao_centavos = ? WHERE chat_id = ?').run(centavos, chatId);
  return info.changes > 0;
}

// ---- grupo de admins e busca de grupo por termo (comandos remotos)

function marcarGrupoAdmin(chatId, ehAdmin) {
  const info = db.prepare('UPDATE grupos SET eh_admin = ? WHERE chat_id = ?').run(ehAdmin ? 1 : 0, chatId);
  return info.changes > 0;
}

// chat_ids dos grupos de admins — membro deles é "admin geral" e tem
// permissão de admin em qualquer grupo de pelada
function listarGruposAdmin() {
  return db.prepare('SELECT chat_id FROM grupos WHERE eh_admin = 1').all().map((g) => g.chat_id);
}

// termo pode ser o chat_id exato ou um pedaço do nome do grupo
function buscarGrupos(termo) {
  const porId = db.prepare('SELECT * FROM grupos WHERE chat_id = ?').get(termo);
  if (porId) return [porId];

  const alvo = normalizarTexto(termo).trim();
  if (!alvo) return [];
  // Filtra em JS em vez de LIKE: acento-insensível e sem %/_ virando coringa
  return db.prepare(
    'SELECT * FROM grupos WHERE eh_admin = 0 ORDER BY primeira_mensagem_em DESC'
  ).all().filter((g) => normalizarTexto(g.nome).includes(alvo));
}

module.exports = {
  LIMITE_PRINCIPAL,
  LIMITE_ESPERA,
  registrarGrupoSeNovo,
  getGrupo,
  ativarGrupo,
  desativarGrupo,
  listarGrupos,
  setarValorPadraoGrupo,
  marcarGrupoAdmin,
  listarGruposAdmin,
  buscarGrupos,
};
