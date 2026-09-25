// Elenco do grupo: jogadores, votos de habilidade por fundamento, nota do dia,
// apelidos e o casamento entre o nome na lista e o jogador do elenco.
// Substitui a planilha de times.
const { db, migrarColunas } = require('../../nucleo/banco');
const { normalizarTexto } = require('../../nucleo/texto');
const { numeroSintetico } = require('../../nucleo/numeros');
const pelada = require('../pelada/repositorio');

db.exec(`
  CREATE TABLE IF NOT EXISTS jogadores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,          -- elenco é por grupo
    nome TEXT NOT NULL,
    numero TEXT,                    -- vincula com as entradas das listas quando conhecido
    criado_em TEXT NOT NULL,
    altura TEXT,                    -- alto | medio | baixo (opcional; null = não considera)
    UNIQUE(chat_id, nome)
  );

  CREATE TABLE IF NOT EXISTS votos_habilidade (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jogador_id INTEGER NOT NULL,
    votante TEXT NOT NULL,          -- quem votou (ex: "Fabrício")
    fundamento TEXT NOT NULL,       -- ataque | defesa | levantamento | saque
    nota INTEGER NOT NULL,          -- 1-5
    atualizado_em TEXT NOT NULL,
    UNIQUE(jogador_id, votante, fundamento),
    FOREIGN KEY (jogador_id) REFERENCES jogadores(id)
  );

  CREATE TABLE IF NOT EXISTS notas_do_dia (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jogador_id INTEGER NOT NULL,
    lista_id INTEGER NOT NULL,      -- a pelada em que a atuação aconteceu
    nota REAL NOT NULL,             -- 1-5
    observacao TEXT,
    atualizado_em TEXT NOT NULL,
    UNIQUE(jogador_id, lista_id),
    FOREIGN KEY (jogador_id) REFERENCES jogadores(id),
    FOREIGN KEY (lista_id) REFERENCES listas(id)
  );
`);

// Apelidos: o nome no WhatsApp muda e nem sempre o casamento automático dá
// conta ("A6" = Aces, "David" = Dvd). Aqui os admins ensinam o vínculo.
db.exec(`
  CREATE TABLE IF NOT EXISTS apelidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jogador_id INTEGER NOT NULL,
    apelido TEXT NOT NULL,
    criado_em TEXT NOT NULL,
    UNIQUE(jogador_id, apelido),
    FOREIGN KEY (jogador_id) REFERENCES jogadores(id)
  );
`);

// Cada mudança de avaliação vira um ponto na linha do tempo do jogador —
// o voto em si é "o atual", mas a subida (ou queda) de nível fica registrada
db.exec(`
  CREATE TABLE IF NOT EXISTS historico_habilidade (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jogador_id INTEGER NOT NULL,
    habilidade REAL NOT NULL,
    em TEXT NOT NULL,
    FOREIGN KEY (jogador_id) REFERENCES jogadores(id)
  );
`);

migrarColunas('jogadores', { altura: 'TEXT' });

const FUNDAMENTOS = ['ataque', 'defesa', 'levantamento', 'saque'];
const ALTURAS = ['alto', 'medio', 'baixo'];

// Lista apagada leva junto as notas do dia que eram dela
pelada.quandoApagarLista((listaId) => {
  db.prepare('DELETE FROM notas_do_dia WHERE lista_id = ?').run(listaId);
});

function upsertJogador(chatId, nome, numero = null) {
  const existente = db.prepare(
    'SELECT * FROM jogadores WHERE chat_id = ? AND nome = ?'
  ).get(chatId, nome.trim());
  if (existente) {
    if (numero && !existente.numero) {
      db.prepare('UPDATE jogadores SET numero = ? WHERE id = ?').run(numero, existente.id);
      existente.numero = numero;
    }
    return existente;
  }
  const info = db.prepare(
    'INSERT INTO jogadores (chat_id, nome, numero, criado_em) VALUES (?, ?, ?, ?)'
  ).run(chatId, nome.trim(), numero, new Date().toISOString());
  return db.prepare('SELECT * FROM jogadores WHERE id = ?').get(info.lastInsertRowid);
}

// Ensina que um nome do WhatsApp é fulano do elenco — vale pra presença,
// nota do dia e montagem de times, de hoje em diante e retroativo
function adicionarApelido(jogadorId, apelido) {
  const limpo = String(apelido || '').trim();
  if (!limpo) return { erro: 'apelido_vazio' };
  db.prepare(
    'INSERT OR IGNORE INTO apelidos (jogador_id, apelido, criado_em) VALUES (?, ?, ?)'
  ).run(jogadorId, limpo, new Date().toISOString());
  return {};
}

function removerApelido(jogadorId, apelido) {
  db.prepare('DELETE FROM apelidos WHERE jogador_id = ? AND apelido = ?').run(jogadorId, apelido);
}

// Quem já votou neste grupo — alimenta o seletor "Você é" do painel
function listarVotantes(chatId) {
  return db.prepare(`
    SELECT DISTINCT v.votante FROM votos_habilidade v
    JOIN jogadores j ON j.id = v.jogador_id
    WHERE j.chat_id = ?
    ORDER BY v.votante COLLATE NOCASE ASC
  `).all(chatId).map((r) => r.votante);
}

function apelidosDe(jogadorId) {
  return db.prepare('SELECT apelido FROM apelidos WHERE jogador_id = ?').all(jogadorId).map((a) => a.apelido);
}

// Altura é opcional: sem ela, o jogador é neutro na hora de espalhar os
// bloqueadores pelos times
function definirAltura(jogadorId, altura) {
  const valor = altura && ALTURAS.includes(altura) ? altura : null;
  db.prepare('UPDATE jogadores SET altura = ? WHERE id = ?').run(valor, jogadorId);
  return { altura: valor };
}

// Troca o nome no elenco sem perder nada: votos, notas, presença e vínculo
// continuam, e o nome antigo vira apelido — assim as listas passadas (e o
// WhatsApp de quem ainda aparece com ele) seguem casando
function renomearJogador(jogadorId, novoNome) {
  const nome = String(novoNome || '').trim();
  if (!nome) return { erro: 'nome_vazio' };
  const jogador = db.prepare('SELECT * FROM jogadores WHERE id = ?').get(jogadorId);
  if (!jogador) return { erro: 'nao_achei' };
  if (normalizarTexto(jogador.nome) === normalizarTexto(nome)) return { antes: jogador.nome, depois: nome };
  const conflito = db.prepare('SELECT 1 FROM jogadores WHERE chat_id = ? AND nome = ? AND id <> ?')
    .get(jogador.chat_id, nome, jogadorId);
  if (conflito) return { erro: 'nome_ocupado' };
  db.prepare('UPDATE jogadores SET nome = ? WHERE id = ?').run(nome, jogadorId);
  adicionarApelido(jogadorId, jogador.nome);
  return { antes: jogador.nome, depois: nome };
}

function removerJogador(jogadorId) {
  db.prepare('DELETE FROM apelidos WHERE jogador_id = ?').run(jogadorId);
  db.prepare('DELETE FROM historico_habilidade WHERE jogador_id = ?').run(jogadorId);
  db.prepare('DELETE FROM votos_habilidade WHERE jogador_id = ?').run(jogadorId);
  db.prepare('DELETE FROM notas_do_dia WHERE jogador_id = ?').run(jogadorId);
  const info = db.prepare('DELETE FROM jogadores WHERE id = ?').run(jogadorId);
  return info.changes > 0;
}

function mediaHabilidade(jogadorId) {
  const r = db.prepare('SELECT AVG(nota) AS m FROM votos_habilidade WHERE jogador_id = ?').get(jogadorId);
  return r?.m ?? null;
}

// Guarda um ponto só quando a média MUDA — a linha do tempo fica com as
// viradas de nível, não com um ponto por clique
function registrarSnapshotHabilidade(jogadorId) {
  const media = mediaHabilidade(jogadorId);
  if (media == null) return;
  const ultimo = db.prepare(
    'SELECT habilidade FROM historico_habilidade WHERE jogador_id = ? ORDER BY em DESC, id DESC LIMIT 1'
  ).get(jogadorId);
  if (ultimo && Math.abs(ultimo.habilidade - media) < 1e-9) return;
  db.prepare('INSERT INTO historico_habilidade (jogador_id, habilidade, em) VALUES (?, ?, ?)')
    .run(jogadorId, media, new Date().toISOString());
}

function votarHabilidade(jogadorId, votante, fundamento, nota) {
  if (!FUNDAMENTOS.includes(fundamento)) return { erro: 'fundamento_invalido' };
  if (!(nota >= 1 && nota <= 5)) return { erro: 'nota_invalida' };
  db.prepare(`
    INSERT INTO votos_habilidade (jogador_id, votante, fundamento, nota, atualizado_em)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(jogador_id, votante, fundamento) DO UPDATE SET nota = excluded.nota, atualizado_em = excluded.atualizado_em
  `).run(jogadorId, votante.trim(), fundamento, nota, new Date().toISOString());
  registrarSnapshotHabilidade(jogadorId);
  return {};
}

function darNotaDoDia(jogadorId, listaId, nota, observacao = null) {
  if (!(nota >= 1 && nota <= 5)) return { erro: 'nota_invalida' };
  db.prepare(`
    INSERT INTO notas_do_dia (jogador_id, lista_id, nota, observacao, atualizado_em)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(jogador_id, lista_id) DO UPDATE SET nota = excluded.nota, observacao = excluded.observacao, atualizado_em = excluded.atualizado_em
  `).run(jogadorId, listaId, nota, observacao, new Date().toISOString());
  return {};
}

// Elenco completo com as médias calculadas:
// - habilidade: média de TODOS os votos (fundamento × votante), escala 1-5
// - notaTime: o que o montador de times usa — 70% habilidade + 30% média das
//   últimas 3 notas do dia (quem joga bem/mal em quadra mexe no peso, sem
//   atropelar a avaliação de base); sem nota do dia, vale a habilidade pura
function enriquecerJogadores(chatId) {
  const jogadores = db.prepare(
    'SELECT * FROM jogadores WHERE chat_id = ? ORDER BY nome COLLATE NOCASE ASC'
  ).all(chatId);

  return jogadores.map((j) => {
    const votos = db.prepare(
      'SELECT votante, fundamento, nota FROM votos_habilidade WHERE jogador_id = ?'
    ).all(j.id);
    const porFundamento = {};
    for (const f of FUNDAMENTOS) {
      const doFundamento = votos.filter((v) => v.fundamento === f);
      porFundamento[f] = doFundamento.length
        ? doFundamento.reduce((s, v) => s + v.nota, 0) / doFundamento.length
        : null;
    }
    const habilidade = votos.length
      ? votos.reduce((s, v) => s + v.nota, 0) / votos.length
      : null;

    const ultimasNotas = db.prepare(`
      SELECT nd.nota FROM notas_do_dia nd
      JOIN listas l ON l.id = nd.lista_id
      WHERE nd.jogador_id = ?
      ORDER BY l.id DESC LIMIT 3
    `).all(j.id).map((r) => r.nota);
    const mediaDia = ultimasNotas.length
      ? ultimasNotas.reduce((s, n) => s + n, 0) / ultimasNotas.length
      : null;

    const notaTime = habilidade == null
      ? null
      : (mediaDia == null ? habilidade : 0.7 * habilidade + 0.3 * mediaDia);

    return { ...j, apelidos: apelidosDe(j.id), votos, porFundamento, habilidade, mediaDia, notaTime, presencas: 0 };
  });
}

// listarJogadores em duas fases: enriquece as notas e depois conta presença
// pelo mapeamento inteligente de nomes (o mesmo do #timesde e da evolução)
function listarJogadores(chatId) {
  const enriquecidos = enriquecerJogadores(chatId);
  const { entradas, mapa } = mapearEntradasDoGrupo(chatId, enriquecidos);
  const listasPorJogador = new Map();
  for (const e of entradas) {
    const jogadorId = mapa.get(e.id);
    if (!jogadorId) continue;
    if (!listasPorJogador.has(jogadorId)) listasPorJogador.set(jogadorId, new Set());
    listasPorJogador.get(jogadorId).add(e.lista_id);
  }
  for (const j of enriquecidos) {
    j.presencas = listasPorJogador.get(j.id)?.size ?? 0;
  }
  return enriquecidos;
}

// Série temporal pros gráficos: notas do dia por pelada + presença acumulada,
// com a presença resolvida pelo mesmo casamento inteligente de nomes
function evolucaoJogadores(chatId) {
  const listas = pelada.listasDoGrupo(chatId);
  const jogadores = db.prepare(
    'SELECT * FROM jogadores WHERE chat_id = ? ORDER BY nome COLLATE NOCASE ASC'
  ).all(chatId).map((j) => ({ ...j, apelidos: apelidosDe(j.id) }));
  const { entradas, mapa } = mapearEntradasDoGrupo(chatId, jogadores);
  const presencaChaves = new Set();
  for (const e of entradas) {
    const jogadorId = mapa.get(e.id);
    if (jogadorId) presencaChaves.add(`${e.lista_id}:${jogadorId}`);
  }

  const series = jogadores.map((j) => {
    const notas = db.prepare(
      'SELECT lista_id, nota, observacao FROM notas_do_dia WHERE jogador_id = ?'
    ).all(j.id);
    const porLista = new Map(notas.map((n) => [n.lista_id, n]));

    // Nível na época de cada pelada: o último snapshot até aquela data
    const snapshots = db.prepare(
      'SELECT habilidade, em FROM historico_habilidade WHERE jogador_id = ? ORDER BY em ASC, id ASC'
    ).all(j.id);
    const nivelEm = (quando) => {
      let valor = null;
      for (const s of snapshots) {
        if (s.em <= quando) valor = s.habilidade; else break;
      }
      return valor;
    };

    let acumulado = 0;
    const pontos = listas.map((l) => {
      const presente = presencaChaves.has(`${l.id}:${j.id}`);
      if (presente) acumulado++;
      return {
        lista_id: l.id,
        data_jogo: l.data_jogo,
        nota: porLista.get(l.id)?.nota ?? null,
        observacao: porLista.get(l.id)?.observacao ?? null,
        presente,
        presencaAcumulada: acumulado,
        nivel: nivelEm(l.criada_em),
      };
    });
    // "Hoje" fecha a linha do nível — mostra a avaliação vigente
    const nivelAtual = snapshots.length ? snapshots[snapshots.length - 1].habilidade : null;
    return { jogador: j.nome, jogador_id: j.id, pontos, nivelAtual, mudancasDeNivel: snapshots };
  });

  return { listas, series };
}

// ---- casamento de nomes -----------------------------------------------------
// O nome no WhatsApp raramente é igual ao do elenco ("Marcel" vs "Marcel
// Garcia", "Prata" vs "Thiago Prata", "Camila Wad" vs "Camila W."). O rank
// mede o quão forte é o casamento; só vale se houver UM candidato no melhor
// rank — ambiguidade (ex: "Marcel" vs "Marcelle" por prefixo) não casa.
function tokensDeNome(nome) {
  // O que vem entre parênteses é anotação da lista, não parte do nome: com
  // "(cvd Marcel)" contando, o convidado "Paulo Ribeiro (cvd Marcel)" casou
  // com a Marcelle pelo prefixo "marcel" em 25/09/2026 — o Marcel Garcia não
  // casava porque "garcia" não aparece no nome do convidado, e a Marcelle
  // sobrou como candidata única. Foi parar nos times no lugar dele.
  const semAnotacao = String(nome || '').replace(/\([^)]*\)/g, ' ');
  return normalizarTexto(semAnotacao).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
}

// 0 = nome inteiro igual · 1 = todos os tokens do menor batem exatos no maior,
// em ordem · 2 = batem por prefixo ("vini"→"vinicius", "w"→"wad") · null = não casa.
// O rank 2 exige âncora (um token exato, ex: "camila" em "Camila V.") OU
// prefixo comum de 3+ letras — senão "Camila V." casaria com "Vini" pelo "v".
function rankCasamento(a, b) {
  const ta = tokensDeNome(a);
  const tb = tokensDeNome(b);
  if (!ta.length || !tb.length) return null;
  if (ta.join(' ') === tb.join(' ')) return 0;

  const [curto, longo] = ta.length <= tb.length ? [ta, tb] : [tb, ta];

  const casaExato = () => {
    let i = 0;
    for (const t of curto) {
      let achou = false;
      while (i < longo.length) {
        if (t === longo[i++]) { achou = true; break; }
      }
      if (!achou) return false;
    }
    return true;
  };
  if (casaExato()) return 1;

  let i = 0;
  let temAncora = false;
  let maiorPrefixo = 0;
  for (const t of curto) {
    let achou = false;
    while (i < longo.length) {
      const l = longo[i++];
      if (t === l) { achou = true; temAncora = true; break; }
      if (l.startsWith(t) || t.startsWith(l)) {
        achou = true;
        maiorPrefixo = Math.max(maiorPrefixo, Math.min(t.length, l.length));
        break;
      }
    }
    if (!achou) return null;
  }
  return (temAncora || maiorPrefixo >= 3) ? 2 : null;
}

// Casa uma entrada da lista com o elenco: número do WhatsApp primeiro, senão
// pelo nome (rank + candidato único). Quando casa por nome e a entrada tem
// número real, o vínculo é gravado — daí em diante o casamento é exato.
function acharJogadorDaEntrada(chatId, entrada, jogadores) {
  const usuario = numeroSintetico(entrada.numero) ? '' : String(entrada.numero).split('@')[0];
  if (usuario) {
    const porNumero = jogadores.find((j) => j.numero && String(j.numero).split('@')[0] === usuario);
    if (porNumero) return porNumero;
  }

  // Apelido ensinado pelos admins vence qualquer heurística
  const alvoNormalizado = normalizarTexto(entrada.nome);
  const porApelido = jogadores.find((j) =>
    (j.apelidos || []).some((a) => normalizarTexto(a) === alvoNormalizado));
  if (porApelido) return porApelido;

  let melhorRank = Infinity;
  let candidatos = [];
  for (const j of jogadores) {
    // Melhor casamento entre o nome do elenco e os apelidos ensinados
    const rank = [j.nome, ...(j.apelidos || [])]
      .map((candidato) => rankCasamento(entrada.nome, candidato))
      .filter((x) => x != null)
      .reduce((melhor, x) => (melhor == null || x < melhor ? x : melhor), null);
    if (rank == null) continue;
    if (rank < melhorRank) { melhorRank = rank; candidatos = [j]; }
    else if (rank === melhorRank) candidatos.push(j);
  }
  if (candidatos.length !== 1) return null;

  const jogador = candidatos[0];
  if (usuario && !jogador.numero) {
    db.prepare('UPDATE jogadores SET numero = ? WHERE id = ?').run(entrada.numero, jogador.id);
    jogador.numero = entrada.numero;
  }
  return jogador;
}

// Resolve TODAS as entradas do grupo pro elenco de uma vez — presença e
// evolução nascem daqui, com a mesma regra de casamento do resto do sistema
function mapearEntradasDoGrupo(chatId, jogadores) {
  const entradas = pelada.entradasDoGrupo(chatId);
  const mapa = new Map(); // entrada.id -> jogador.id
  for (const e of entradas) {
    const j = acharJogadorDaEntrada(chatId, e, jogadores);
    if (j) mapa.set(e.id, j.id);
  }
  return { entradas, mapa };
}

// Últimas listas com participantes e a nota do dia já dada — alimenta a
// tela de avaliação pós-jogo do painel
function listasRecentesComEntradas(chatId) {
  const listas = pelada.listasRecentes(chatId);
  const jogadores = listarJogadores(chatId);
  return listas.map((l) => ({
    ...l,
    naEspera: pelada.contarPorTipo(l.id, 'espera'),
    // Só quem entrou em quadra leva nota — a espera fica de fora
    entradas: pelada.entradasPrincipais(l.id).map((e) => {
      const jogador = acharJogadorDaEntrada(chatId, e, jogadores);
      const notaAtual = jogador
        ? db.prepare('SELECT nota, observacao FROM notas_do_dia WHERE jogador_id = ? AND lista_id = ?').get(jogador.id, l.id)
        : null;
      return {
        nome: e.nome,
        tipo: e.tipo,
        mensalista: Boolean(e.mensalista),
        jogador_id: jogador?.id ?? null,
        nota: notaAtual?.nota ?? null,
        observacao: notaAtual?.observacao ?? null,
      };
    }),
  }));
}

// A pelada da semana: a lista mais recente do grupo, já casada com o elenco.
// É a mesma fonte que o #timesde usa — o painel mostra exatamente isso, então
// bot e site nunca divergem.
function elencoDaSemana(chatId) {
  const lista = pelada.getListaMaisRecente(chatId);
  if (!lista) return { lista: null, naLista: [], novos: [], naEspera: 0 };

  const jogadores = listarJogadores(chatId);
  const naLista = [];
  const novos = [];
  // Só a PRINCIPAL: quem está na espera ainda não joga — entra no elenco da
  // semana (e nos times) apenas quando subir
  for (const e of pelada.entradasPrincipais(lista.id)) {
    const jogador = acharJogadorDaEntrada(chatId, e, jogadores);
    if (jogador) naLista.push({ ...jogador, nomeNaLista: e.nome, tipo: e.tipo, mensalista: Boolean(e.mensalista) });
    else novos.push({ nome: e.nome, tipo: e.tipo, mensalista: Boolean(e.mensalista) });
  }
  const naEspera = pelada.contarPorTipo(lista.id, 'espera');
  return { lista, naLista, novos, naEspera };
}

module.exports = {
  FUNDAMENTOS,
  ALTURAS,
  upsertJogador,
  renomearJogador,
  removerJogador,
  adicionarApelido,
  removerApelido,
  listarVotantes,
  definirAltura,
  votarHabilidade,
  darNotaDoDia,
  listarJogadores,
  acharJogadorDaEntrada,
  evolucaoJogadores,
  listasRecentesComEntradas,
  elencoDaSemana,
};
