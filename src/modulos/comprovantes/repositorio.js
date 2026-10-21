// Comprovantes lidos (pra nunca valer duas vezes) e quem paga por quem.
const { db, migrarColunas } = require('../../nucleo/banco');
const { normalizarTexto } = require('../../nucleo/texto');

db.exec(`
  CREATE TABLE IF NOT EXISTS comprovantes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    lista_id INTEGER,
    remetente TEXT,               -- número de quem enviou no grupo
    remetente_nome TEXT,
    chave TEXT,                   -- id da transação (ou valor+data+pagador, sem id)
    valor_centavos INTEGER,
    data_hora TEXT,
    pagador_nome TEXT,
    recebedor_nome TEXT,
    status TEXT NOT NULL,         -- marcado | pendente | resolvido | ignorado
    motivo TEXT,
    marcados TEXT,                -- nomes marcados (JSON)
    criado_em TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_comprovantes_chave ON comprovantes(chave);

  -- Quem costuma pagar por quem: Fabrício → Kamila, Thiago → Duda. Aprendido
  -- quando os admins resolvem um comprovante, ou cadastrado com #pagapor
  CREATE TABLE IF NOT EXISTS pagadores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    pagador_numero TEXT NOT NULL,
    pagador_nome TEXT,
    dependente_nome TEXT NOT NULL,
    dependente_numero TEXT,       -- quando a pessoa tem WhatsApp de verdade
    criado_em TEXT NOT NULL,
    UNIQUE(chat_id, pagador_numero, dependente_nome)
  );
`);

// Pergunta "é teu ou da Duda?" feita no grupo pra quem enviou: a resposta
// dele resolve o comprovante sem precisar de admin
migrarColunas('comprovantes', {
  pergunta_em: 'TEXT',        // quando o bot perguntou no grupo (null = só os admins sabem)
  pergunta_msg_id: 'TEXT',    // a mensagem da pergunta, pra reconhecer quem responde citando
  pessoas: 'INTEGER',         // quantas pessoas o valor cobre
  candidatos: 'TEXT',         // ids das entradas que podiam ser (JSON)
  do_remetente: 'TEXT',       // ids das entradas do próprio remetente — o "meu" (JSON)
});

// Mesma pessoa no WhatsApp, com ou sem sufixo (@c.us / @lid)
const usuario = (numero) => String(numero || '').split('@')[0];

// Comprovante sem id de transação ainda precisa de uma chave pra não valer
// duas vezes: valor + data + pagador é o que muda de um Pix pro outro
function chaveDoComprovante(leitura) {
  if (leitura.id_transacao) return `id:${leitura.id_transacao.replace(/\s+/g, '').toUpperCase()}`;
  return `sem-id:${leitura.valor_centavos}|${leitura.data_hora}|${normalizarTexto(leitura.pagador_nome || '')}`;
}

function jaUsado(chave) {
  return db.prepare(
    "SELECT * FROM comprovantes WHERE chave = ? AND status IN ('marcado', 'resolvido', 'pendente') ORDER BY id LIMIT 1"
  ).get(chave);
}

function registrar(c) {
  const info = db.prepare(`
    INSERT INTO comprovantes (chat_id, lista_id, remetente, remetente_nome, chave, valor_centavos, data_hora,
      pagador_nome, recebedor_nome, status, motivo, marcados, criado_em)
    VALUES (@chat_id, @lista_id, @remetente, @remetente_nome, @chave, @valor_centavos, @data_hora,
      @pagador_nome, @recebedor_nome, @status, @motivo, @marcados, @criado_em)
  `).run({
    lista_id: null, remetente_nome: null, chave: null, valor_centavos: null, data_hora: null,
    pagador_nome: null, recebedor_nome: null, motivo: null,
    ...c,
    marcados: JSON.stringify(c.marcados || []),
    criado_em: new Date().toISOString(),
  });
  return getComprovante(info.lastInsertRowid);
}

function registrarPergunta(id, { msgId, pessoas, candidatos, doRemetente }) {
  db.prepare('UPDATE comprovantes SET pergunta_em = ?, pergunta_msg_id = ?, pessoas = ?, candidatos = ?, do_remetente = ? WHERE id = ?')
    .run(new Date().toISOString(), msgId || null, pessoas, JSON.stringify(candidatos), JSON.stringify(doRemetente), id);
}

// A pergunta em aberto que essa mensagem responde: citando a pergunta, ou a
// mais recente pra esse remetente nesse grupo (dentro do prazo)
function perguntaAberta(chatId, { idCitado = null, remetente = null, desde }) {
  const abertas = db.prepare(
    "SELECT * FROM comprovantes WHERE chat_id = ? AND status = 'pendente' AND pergunta_em IS NOT NULL AND pergunta_em >= ? ORDER BY id DESC"
  ).all(chatId, desde.toISOString());
  if (idCitado) {
    const citada = abertas.find((c) => c.pergunta_msg_id === idCitado);
    if (citada) return { comprovante: citada, citou: true };
  }
  const doRemetente = abertas.find((c) => remetente && usuario(c.remetente) === usuario(remetente));
  return doRemetente ? { comprovante: doRemetente, citou: false } : null;
}

function getComprovante(id) {
  return db.prepare('SELECT * FROM comprovantes WHERE id = ?').get(id);
}

function resolver(id, status, marcados = []) {
  db.prepare('UPDATE comprovantes SET status = ?, marcados = ? WHERE id = ?').run(status, JSON.stringify(marcados), id);
}

// Um pagamento avulso não vira regra. Em 21/10/2026, no teste, o Fabrício
// respondeu "Diego" uma vez e o bot passou a achar que ele paga o DiegoB:
// o próximo Pix dele já pago marcaria o DiegoB sozinho. Agora o vínculo
// aprendido (resposta no grupo ou #comprovante) só vale a partir da 2ª vez;
// o ensinado pelos admins (#pagapor) vale na hora.
const VEZES_PRA_VALER = 2;
migrarColunas('pagadores', {
  origem: 'TEXT',                        // 'admin' | 'aprendido' (null = cadastrado na mão, vale)
  vezes: 'INTEGER NOT NULL DEFAULT 1',   // quantas vezes ele pagou por essa pessoa
});

const valendo = (p) => p.origem !== 'aprendido' || p.vezes >= VEZES_PRA_VALER;

// Só os vínculos que já valem pra marcar sozinho
function dependentesDe(chatId, pagadorNumero) {
  return db.prepare('SELECT * FROM pagadores WHERE chat_id = ?').all(chatId)
    .filter((p) => usuario(p.pagador_numero) === usuario(pagadorNumero) && valendo(p));
}

// origem 'admin' (#pagapor): vale na hora. 'aprendido': conta mais uma vez.
// Devolve o vínculo como ficou (com .valendo)
function vincular(chatId, { pagadorNumero, pagadorNome = null, dependenteNome, dependenteNumero = null, origem = 'admin' }) {
  db.prepare(`
    INSERT INTO pagadores (chat_id, pagador_numero, pagador_nome, dependente_nome, dependente_numero, criado_em, origem, vezes)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(chat_id, pagador_numero, dependente_nome) DO UPDATE SET
      pagador_nome = COALESCE(excluded.pagador_nome, pagador_nome),
      dependente_numero = COALESCE(excluded.dependente_numero, dependente_numero),
      vezes = vezes + CASE WHEN excluded.origem = 'aprendido' THEN 1 ELSE 0 END
  `).run(chatId, pagadorNumero, pagadorNome, dependenteNome, dependenteNumero, new Date().toISOString(), origem);
  if (origem === 'admin') {
    db.prepare("UPDATE pagadores SET origem = 'admin' WHERE chat_id = ? AND pagador_numero = ? AND dependente_nome = ?")
      .run(chatId, pagadorNumero, dependenteNome);
  }
  const p = db.prepare('SELECT * FROM pagadores WHERE chat_id = ? AND pagador_numero = ? AND dependente_nome = ?')
    .get(chatId, pagadorNumero, dependenteNome);
  return { ...p, valendo: valendo(p) };
}

function desvincular(chatId, pagadorNome, dependenteNome) {
  const alvoP = normalizarTexto(pagadorNome);
  const alvoD = normalizarTexto(dependenteNome);
  const linhas = db.prepare('SELECT * FROM pagadores WHERE chat_id = ?').all(chatId)
    .filter((p) => normalizarTexto(p.pagador_nome || '').startsWith(alvoP) && normalizarTexto(p.dependente_nome).startsWith(alvoD));
  for (const l of linhas) db.prepare('DELETE FROM pagadores WHERE id = ?').run(l.id);
  return linhas.length;
}

function listarVinculos(chatId) {
  return db.prepare('SELECT * FROM pagadores WHERE chat_id = ? ORDER BY pagador_nome COLLATE NOCASE, dependente_nome COLLATE NOCASE')
    .all(chatId).map((p) => ({ ...p, valendo: valendo(p) }));
}

module.exports = {
  usuario, chaveDoComprovante, jaUsado, registrar, getComprovante, resolver, registrarPergunta, perguntaAberta,
  dependentesDe, vincular, desvincular, listarVinculos,
};
