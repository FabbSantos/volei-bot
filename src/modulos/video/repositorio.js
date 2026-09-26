// Vídeos que subiram pelo painel e os #replay pedidos no grupo.
//
// O que liga um ao outro é o HORÁRIO: o replay guarda o instante em que foi
// pedido, o vídeo guarda o intervalo que cobre, e quando um vídeo termina de
// ser importado, todo replay pendente que cai dentro dele é cortado. Não
// depende de pelada nem de lista — vale pra pelada, Meier Lions, treino.
// Quando houver duas câmeras gravando ao mesmo tempo, a chave vira
// "local + horário" (uma coluna a mais nas duas tabelas).
//
// Horários em milissegundos desde 1970 (UTC): o container roda em UTC e o
// vídeo é processado no fuso de Brasília, então número puro é o único jeito
// de os dois lados concordarem sem conversão.
const { db } = require('../../nucleo/banco');

db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,              -- nome original do arquivo (tem a hora do celular)
    tamanho INTEGER NOT NULL,
    status TEXT NOT NULL,            -- processando | pronto | erro
    inicio INTEGER,                  -- intervalo coberto, preenchido na importação
    fim INTEGER,
    aviso TEXT,                      -- ex: "este celular grava a hora do FIM no metadado"
    erro TEXT,
    criado_em INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS replays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,           -- de onde veio o pedido; o corte volta pra lá
    autor TEXT,
    momento INTEGER NOT NULL,        -- hora da mensagem no WhatsApp
    segundos INTEGER NOT NULL,       -- quanto pra trás
    status TEXT NOT NULL DEFAULT 'pendente', -- pendente | enviado | erro | expirado
    video_id INTEGER,
    arquivo TEXT,
    erro TEXT,
    criado_em INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_replays_pendentes ON replays(status, momento);
`);

function registrarReplay({ chatId, autor, momento, segundos }) {
  const info = db.prepare(
    'INSERT INTO replays (chat_id, autor, momento, segundos, criado_em) VALUES (?, ?, ?, ?, ?)'
  ).run(chatId, autor || null, momento, segundos, Date.now());
  return db.prepare('SELECT * FROM replays WHERE id = ?').get(info.lastInsertRowid);
}

// Pendentes cuja janela [momento - segundos, momento] encosta no intervalo
function replaysPendentesEntre(inicio, fim) {
  return db.prepare(
    `SELECT * FROM replays
      WHERE status = 'pendente' AND momento > ? AND momento - segundos * 1000 < ?
      ORDER BY momento`
  ).all(inicio, fim);
}

function listarReplaysPendentes() {
  return db.prepare("SELECT * FROM replays WHERE status = 'pendente' ORDER BY momento").all();
}

function marcarReplay(id, { status, videoId = null, arquivo = null, erro = null }) {
  db.prepare('UPDATE replays SET status = ?, video_id = ?, arquivo = ?, erro = ? WHERE id = ?')
    .run(status, videoId, arquivo, erro, id);
}

// Replay que nenhum vídeo cobriu depois de tantos dias não vai ser cortado
// nunca (ninguém gravou, ou o vídeo já se perdeu) — sai da fila
function expirarReplays(antesDe) {
  return db.prepare("UPDATE replays SET status = 'expirado' WHERE status = 'pendente' AND momento < ?")
    .run(antesDe).changes;
}

function registrarVideo({ nome, tamanho }) {
  const info = db.prepare(
    "INSERT INTO videos (nome, tamanho, status, criado_em) VALUES (?, ?, 'processando', ?)"
  ).run(nome, tamanho, Date.now());
  return getVideo(info.lastInsertRowid);
}

function getVideo(id) {
  return db.prepare('SELECT * FROM videos WHERE id = ?').get(id);
}

function marcarVideo(id, campos) {
  const permitidos = ['status', 'inicio', 'fim', 'aviso', 'erro'];
  const pares = Object.entries(campos).filter(([k]) => permitidos.includes(k));
  if (pares.length === 0) return;
  db.prepare(`UPDATE videos SET ${pares.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...pares.map(([, v]) => v), id);
}

function listarVideos(limite = 10) {
  return db.prepare('SELECT * FROM videos ORDER BY id DESC LIMIT ?').all(limite);
}

function replaysDoVideo(videoId) {
  return db.prepare('SELECT * FROM replays WHERE video_id = ? ORDER BY momento').all(videoId);
}

module.exports = {
  registrarReplay, replaysPendentesEntre, listarReplaysPendentes, marcarReplay, expirarReplays,
  registrarVideo, getVideo, marcarVideo, listarVideos, replaysDoVideo,
};
