const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'volei.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS grupos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL UNIQUE,   -- JID do grupo, ex: 123456789-987654321@g.us
    nome TEXT,
    ativo INTEGER NOT NULL DEFAULT 1, -- reservado pra futuro liga/desliga por cobrança
    primeira_mensagem_em TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS listas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,          -- isola a lista por grupo
    data_jogo TEXT NOT NULL,        -- ex: "05/07"
    status TEXT NOT NULL DEFAULT 'aberta', -- aberta | encerrada
    criada_em TEXT NOT NULL,
    UNIQUE(chat_id, data_jogo)
  );

  CREATE TABLE IF NOT EXISTS entradas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lista_id INTEGER NOT NULL,
    nome TEXT NOT NULL,
    numero TEXT NOT NULL,           -- número/JID individual de quem entrou (não o do grupo)
    tipo TEXT NOT NULL,             -- principal | espera
    timestamp TEXT NOT NULL,
    FOREIGN KEY (lista_id) REFERENCES listas(id)
  );
`);

const LIMITE_PRINCIPAL = 18;
const LIMITE_ESPERA = 4;

// Cadastra o grupo na primeira vez que ele manda qualquer mensagem.
// Fica INATIVO por padrão — precisa ser liberado manualmente via comando
// de admin no privado (ver adminCommands.js) antes de aceitar comandos de lista.
function registrarGrupoSeNovo(chatId, nomeGrupo) {
  const existente = db.prepare('SELECT * FROM grupos WHERE chat_id = ?').get(chatId);
  if (existente) return existente;

  db.prepare(
    'INSERT INTO grupos (chat_id, nome, ativo, primeira_mensagem_em) VALUES (?, ?, 0, ?)'
  ).run(chatId, nomeGrupo || null, new Date().toISOString());

  console.log(`[grupos] novo grupo cadastrado (inativo): ${chatId} (${nomeGrupo || 'sem nome'})`);
  return db.prepare('SELECT * FROM grupos WHERE chat_id = ?').get(chatId);
}

function getGrupo(chatId) {
  return db.prepare('SELECT * FROM grupos WHERE chat_id = ?').get(chatId);
}

function ativarGrupo(chatId) {
  const info = db.prepare('UPDATE grupos SET ativo = 1 WHERE chat_id = ?').run(chatId);
  return info.changes > 0;
}

function desativarGrupo(chatId) {
  const info = db.prepare('UPDATE grupos SET ativo = 0 WHERE chat_id = ?').run(chatId);
  return info.changes > 0;
}

function listarGrupos() {
  return db.prepare('SELECT * FROM grupos ORDER BY primeira_mensagem_em DESC').all();
}

function criarLista(chatId, dataJogo) {
  const existente = db.prepare(
    'SELECT * FROM listas WHERE chat_id = ? AND data_jogo = ?'
  ).get(chatId, dataJogo);
  if (existente) return { ja_existia: true, lista: existente };

  const info = db.prepare(
    'INSERT INTO listas (chat_id, data_jogo, status, criada_em) VALUES (?, ?, ?, ?)'
  ).run(chatId, dataJogo, 'aberta', new Date().toISOString());

  return { ja_existia: false, lista: { id: info.lastInsertRowid, chat_id: chatId, data_jogo: dataJogo, status: 'aberta' } };
}

function getListaAtiva(chatId) {
  // A "ativa" é a lista aberta mais recente DESSE grupo
  return db.prepare(
    "SELECT * FROM listas WHERE chat_id = ? AND status = 'aberta' ORDER BY id DESC LIMIT 1"
  ).get(chatId);
}

function encerrarLista(listaId) {
  db.prepare("UPDATE listas SET status = 'encerrada' WHERE id = ?").run(listaId);
}

function contarPorTipo(listaId, tipo) {
  const row = db.prepare(
    'SELECT COUNT(*) as total FROM entradas WHERE lista_id = ? AND tipo = ?'
  ).get(listaId, tipo);
  return row.total;
}

function jaEstaNaLista(listaId, numero) {
  return db.prepare(
    'SELECT * FROM entradas WHERE lista_id = ? AND numero = ?'
  ).get(listaId, numero);
}

// Retorna: { tipo: 'principal'|'espera', posicao, evento: null|'lista_cheia'|'tudo_lotado' }
function adicionarEntrada(listaId, nome, numero) {
  if (jaEstaNaLista(listaId, numero)) {
    return { erro: 'ja_esta_na_lista' };
  }

  const timestamp = new Date().toISOString();

  const totalPrincipal = contarPorTipo(listaId, 'principal');
  if (totalPrincipal < LIMITE_PRINCIPAL) {
    db.prepare(
      'INSERT INTO entradas (lista_id, nome, numero, tipo, timestamp) VALUES (?, ?, ?, ?, ?)'
    ).run(listaId, nome, numero, 'principal', timestamp);

    const novoTotal = totalPrincipal + 1;
    const evento = novoTotal === LIMITE_PRINCIPAL ? 'lista_cheia' : null;
    return { tipo: 'principal', posicao: novoTotal, evento };
  }

  const totalEspera = contarPorTipo(listaId, 'espera');
  if (totalEspera < LIMITE_ESPERA) {
    db.prepare(
      'INSERT INTO entradas (lista_id, nome, numero, tipo, timestamp) VALUES (?, ?, ?, ?, ?)'
    ).run(listaId, nome, numero, 'espera', timestamp);

    const novoTotal = totalEspera + 1;
    const evento = novoTotal === LIMITE_ESPERA ? 'tudo_lotado' : null;
    return { tipo: 'espera', posicao: novoTotal, evento };
  }

  return { erro: 'tudo_lotado' };
}

function montarListaFormatada(listaId, dataJogo) {
  const principal = db.prepare(
    "SELECT nome FROM entradas WHERE lista_id = ? AND tipo = 'principal' ORDER BY timestamp ASC"
  ).all(listaId);

  let texto = `📋 *Lista do vôlei — ${dataJogo}*\n`;
  texto += `━━━━━━━━━━━━━━━\n`;
  texto += `🟢 *PRINCIPAL* (${principal.length}/${LIMITE_PRINCIPAL})\n`;
  texto += principal.length
    ? principal.map((p, i) => `${i + 1}. ${p.nome}`).join('\n')
    : '_(vazia)_';

  const espera = db.prepare(
    "SELECT nome FROM entradas WHERE lista_id = ? AND tipo = 'espera' ORDER BY timestamp ASC"
  ).all(listaId);
  texto += `\n━━━━━━━━━━━━━━━\n`;
  texto += `🟡 *ESPERA* (${espera.length}/${LIMITE_ESPERA})\n`;
  texto += espera.length
    ? espera.map((p, idx) => `${principal.length + idx + 1}. ${p.nome}`).join('\n')
    : '_(vazia)_';

  return texto;
}

// Lista combinada (principal seguido de espera), na ordem de exibição/numeração
function listarCombinada(listaId) {
  const principal = db.prepare(
    "SELECT * FROM entradas WHERE lista_id = ? AND tipo = 'principal' ORDER BY timestamp ASC"
  ).all(listaId);
  const espera = db.prepare(
    "SELECT * FROM entradas WHERE lista_id = ? AND tipo = 'espera' ORDER BY timestamp ASC"
  ).all(listaId);
  return [...principal, ...espera];
}

// Remove pela posição exibida em #mostralista (1-18 principal, 19+ espera).
// Se remover da principal, promove automaticamente o primeiro da espera.
function removerPorPosicao(listaId, posicao) {
  const combinada = listarCombinada(listaId);
  const alvo = combinada[posicao - 1]; // posicao é 1-indexed

  if (!alvo) {
    return { erro: 'posicao_invalida' };
  }

  db.prepare('DELETE FROM entradas WHERE id = ?').run(alvo.id);

  let promovido = null;
  if (alvo.tipo === 'principal') {
    const proximoDaEspera = db.prepare(
      "SELECT * FROM entradas WHERE lista_id = ? AND tipo = 'espera' ORDER BY timestamp ASC LIMIT 1"
    ).get(listaId);
    if (proximoDaEspera) {
      db.prepare("UPDATE entradas SET tipo = 'principal' WHERE id = ?").run(proximoDaEspera.id);
      promovido = proximoDaEspera.nome;
    }
  }

  return { removido: alvo.nome, promovido };
}

function historico(chatId) {
  return db.prepare(
    'SELECT * FROM listas WHERE chat_id = ? ORDER BY id DESC LIMIT 20'
  ).all(chatId);
}

module.exports = {
  registrarGrupoSeNovo,
  getGrupo,
  ativarGrupo,
  desativarGrupo,
  listarGrupos,
  criarLista,
  getListaAtiva,
  encerrarLista,
  adicionarEntrada,
  montarListaFormatada,
  removerPorPosicao,
  historico,
  LIMITE_PRINCIPAL,
  LIMITE_ESPERA,
};
