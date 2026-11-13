// Perfil de jogo de cada jogador — a planilha do Diego (13/11/2026) dentro do
// bot: o que a pessoa faz que se destaca (Role1 e Role2), o nível do saque e
// se é menina. Quem não se destaca em nada é "Normal" — é a maioria, e é o
// esperado. Alimenta o segundo montador de times (montarTimesPorPerfil, em
// times.js), que convive com o das notas pra dar pra comparar os dois.
const { db } = require('../../nucleo/banco');

db.exec(`
  CREATE TABLE IF NOT EXISTS perfis_jogo (
    jogador_id INTEGER PRIMARY KEY,
    role1 TEXT NOT NULL DEFAULT 'Normal',
    role2 TEXT NOT NULL DEFAULT 'Normal',
    saque TEXT NOT NULL DEFAULT 'Normal',
    menina INTEGER NOT NULL DEFAULT 0,
    atualizado_em TEXT NOT NULL,
    FOREIGN KEY (jogador_id) REFERENCES jogadores(id)
  );
`);

const ROLES = ['Normal', 'Batedor', 'Bloqueador', 'Levantador', 'Defensor', 'Receptor'];
// Do melhor pro pior; o número é o peso no equilíbrio do saque
const SAQUES = ['Muito bom', 'Bom', 'Normal', 'Regular', 'Ruim'];
const PESO_SAQUE = { 'Muito bom': 4, Bom: 3, Normal: 2, Regular: 1, Ruim: 0 };
const EMOJI_ROLE = { Batedor: '💥', Bloqueador: '🧱', Levantador: '🎯', Defensor: '🛡️', Receptor: '🙌' };

const PADRAO = { role1: 'Normal', role2: 'Normal', saque: 'Normal', menina: false };

// Aceita "bloqueador", "MUITO BOM"... e devolve a grafia oficial (ou null)
const oficial = (valor, opcoes) => opcoes.find((o) => o.toLowerCase() === String(valor || '').trim().toLowerCase()) || null;

function perfisDoGrupo(chatId) {
  const linhas = db.prepare(`
    SELECT p.* FROM perfis_jogo p JOIN jogadores j ON j.id = p.jogador_id WHERE j.chat_id = ?
  `).all(chatId);
  return new Map(linhas.map((p) => [p.jogador_id, { role1: p.role1, role2: p.role2, saque: p.saque, menina: Boolean(p.menina) }]));
}

function perfilDe(jogadorId) {
  const p = db.prepare('SELECT * FROM perfis_jogo WHERE jogador_id = ?').get(jogadorId);
  return p ? { role1: p.role1, role2: p.role2, saque: p.saque, menina: Boolean(p.menina) } : { ...PADRAO };
}

// Muda só os campos enviados — o painel salva uma célula por vez
function salvarPerfil(jogadorId, campos = {}) {
  const atual = perfilDe(jogadorId);
  const novo = { ...atual };
  if (campos.role1 !== undefined) novo.role1 = oficial(campos.role1, ROLES);
  if (campos.role2 !== undefined) novo.role2 = oficial(campos.role2, ROLES);
  if (campos.saque !== undefined) novo.saque = oficial(campos.saque, SAQUES);
  if (campos.menina !== undefined) novo.menina = Boolean(campos.menina);
  if (!novo.role1 || !novo.role2 || !novo.saque) return { erro: 'valor_invalido' };
  db.prepare(`
    INSERT INTO perfis_jogo (jogador_id, role1, role2, saque, menina, atualizado_em) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(jogador_id) DO UPDATE SET role1 = excluded.role1, role2 = excluded.role2,
      saque = excluded.saque, menina = excluded.menina, atualizado_em = excluded.atualizado_em
  `).run(jogadorId, novo.role1, novo.role2, novo.saque, novo.menina ? 1 : 0, new Date().toISOString());
  return novo;
}

// A regra do Diego: "considerar Role1; se o time já tiver Role1, considerar
// Role2". Devolve, por time, quantos de cada função ele tem de fato. Quem
// repete uma função que o time já tem e não tem Role2 conta repetido — é força
// a mais naquela função, e o montador quer isso espalhado também.
function funcoesDoTime(jogadores) {
  const contagem = {};
  const ordem = [...jogadores].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  const repetidos = [];
  for (const j of ordem) {
    if (!j.role1 || j.role1 === 'Normal') continue;
    if (contagem[j.role1]) repetidos.push(j);
    else contagem[j.role1] = 1;
  }
  for (const j of repetidos) {
    const funcao = j.role2 && j.role2 !== 'Normal' && !contagem[j.role2] ? j.role2 : j.role1;
    contagem[funcao] = (contagem[funcao] || 0) + 1;
  }
  return contagem;
}

module.exports = { ROLES, SAQUES, PESO_SAQUE, EMOJI_ROLE, PADRAO, perfisDoGrupo, perfilDe, salvarPerfil, funcoesDoTime };
