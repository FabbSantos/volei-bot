// Inadimplentes: aparecem em toda lista do grupo e ficam bloqueados de
// entrar em lista nova até um admin dar #quitado.
const { db } = require('../../nucleo/banco');
const { normalizarTexto } = require('../../nucleo/texto');

db.exec(`
  CREATE TABLE IF NOT EXISTS inadimplentes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    nome TEXT NOT NULL,
    numero TEXT,                    -- quando conhecido, bloqueia a entrada em listas novas
    valor_centavos INTEGER NOT NULL DEFAULT 0, -- quanto deve (0 = não informado)
    criado_em TEXT NOT NULL
  );
`);

function listarInadimplentes(chatId) {
  if (!chatId) return [];
  return db.prepare(
    'SELECT * FROM inadimplentes WHERE chat_id = ? ORDER BY criado_em ASC, id ASC'
  ).all(chatId);
}

// Casa por número (com o fallback @c.us/@lid) ou por nome normalizado —
// inadimplente marcado só por nome também bloqueia
function ehInadimplente(chatId, numero, nome) {
  const lista = listarInadimplentes(chatId);
  const usuario = String(numero || '').split('@')[0];
  return lista.find((i) =>
    (i.numero && (i.numero === numero || (usuario && String(i.numero).split('@')[0] === usuario)))
    || (nome && normalizarTexto(i.nome) === normalizarTexto(nome))
  );
}

function adicionarInadimplente(chatId, { nome, numero, valorCentavos }) {
  if (ehInadimplente(chatId, numero, nome)) return { erro: 'ja_esta' };
  db.prepare(
    'INSERT INTO inadimplentes (chat_id, nome, numero, valor_centavos, criado_em) VALUES (?, ?, ?, ?, ?)'
  ).run(chatId, nome, numero || null, valorCentavos || 0, new Date().toISOString());
  return { nome };
}

// termo: posição na listagem de inadimplentes ou nome (acento-insensível)
function quitarInadimplente(chatId, termo) {
  const lista = listarInadimplentes(chatId);
  let alvo;
  if (/^\d+$/.test(termo)) {
    alvo = lista[parseInt(termo, 10) - 1];
  } else {
    alvo = lista.find((i) => normalizarTexto(i.nome) === normalizarTexto(termo))
      || lista.find((i) => normalizarTexto(i.nome).includes(normalizarTexto(termo)));
  }
  if (!alvo) return { erro: 'nao_achado' };
  db.prepare('DELETE FROM inadimplentes WHERE id = ?').run(alvo.id);
  return { nome: alvo.nome };
}

module.exports = { listarInadimplentes, ehInadimplente, adicionarInadimplente, quitarInadimplente };
