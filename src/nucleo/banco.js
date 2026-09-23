// Conexão única com o SQLite, compartilhada por todos os módulos. Cada módulo
// cria e migra as PRÓPRIAS tabelas (ver modulos/*/repositorio.js); aqui fica
// só o que é comum: abrir, migrar coluna, tirar cópia e fechar.
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'volei.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Migração: bancos criados antes dessas colunas ganham elas no boot,
// sem perder o que já está no volume.
function migrarColunas(tabela, colunas) {
  const existentes = db.pragma(`table_info(${tabela})`).map((c) => c.name);
  for (const [nome, definicao] of Object.entries(colunas)) {
    if (!existentes.includes(nome)) {
      db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${nome} ${definicao}`);
    }
  }
}

// Cópia consistente do banco pra download/backup. Copiar o .db na mão perde o
// que ainda está no WAL; VACUUM INTO gera um arquivo já compactado e íntegro,
// sem parar de atender quem estiver usando o bot no meio.
function snapshotBanco(destino) {
  try {
    fs.rmSync(destino, { force: true }); // VACUUM INTO recusa arquivo existente
  } catch {}
  db.prepare('VACUUM INTO ?').run(destino);
  return destino;
}

// Fecha o banco com calma no desligamento: o WAL faz checkpoint e o
// arquivo no volume fica íntegro pro próximo container
function fecharBanco() {
  try {
    db.close();
    return true;
  } catch {
    return false;
  }
}

module.exports = { db, migrarColunas, snapshotBanco, fecharBanco };
