const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'volei.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

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

  CREATE TABLE IF NOT EXISTS listas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,          -- isola a lista por grupo
    data_jogo TEXT NOT NULL,        -- ex: "05/07"
    status TEXT NOT NULL DEFAULT 'aberta', -- aberta | encerrada
    criada_em TEXT NOT NULL,
    valor_centavos INTEGER NOT NULL DEFAULT 0, -- por pessoa; copiado do padrão do grupo ao criar
    UNIQUE(chat_id, data_jogo)
  );

  CREATE TABLE IF NOT EXISTS entradas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lista_id INTEGER NOT NULL,
    nome TEXT NOT NULL,
    numero TEXT NOT NULL,           -- número/JID individual de quem entrou (não o do grupo)
    tipo TEXT NOT NULL,             -- principal | espera
    timestamp TEXT NOT NULL,
    pago INTEGER NOT NULL DEFAULT 0,
    valor_pago_centavos INTEGER NOT NULL DEFAULT 0, -- snapshot na hora do #pago: mudar o valor da lista depois não reescreve o caixa
    FOREIGN KEY (lista_id) REFERENCES listas(id)
  );
`);

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
migrarColunas('grupos', {
  limite_principal: `INTEGER NOT NULL DEFAULT ${LIMITE_PRINCIPAL}`,
  limite_espera: `INTEGER NOT NULL DEFAULT ${LIMITE_ESPERA}`,
  eh_admin: 'INTEGER NOT NULL DEFAULT 0',
  valor_padrao_centavos: 'INTEGER NOT NULL DEFAULT 0',
});
migrarColunas('listas', { valor_centavos: 'INTEGER NOT NULL DEFAULT 0' });
migrarColunas('entradas', {
  pago: 'INTEGER NOT NULL DEFAULT 0',
  valor_pago_centavos: 'INTEGER NOT NULL DEFAULT 0',
});

// ---- dinheiro: tudo em centavos (INTEGER) pra não sofrer com float
function paraCentavos(texto) {
  // aceita "25", "25,50", "25.50"
  return Math.round(parseFloat(String(texto).replace(',', '.')) * 100);
}

function formatarReais(centavos) {
  return `R$ ${(centavos / 100).toFixed(2).replace('.', ',')}`;
}

// Limites do grupo dono da lista — cai nos padrões se o grupo sumir do cadastro
function getLimitesDaLista(listaId) {
  const row = db.prepare(`
    SELECT g.limite_principal, g.limite_espera
    FROM listas l JOIN grupos g ON g.chat_id = l.chat_id
    WHERE l.id = ?
  `).get(listaId);
  return {
    principal: row?.limite_principal ?? LIMITE_PRINCIPAL,
    espera: row?.limite_espera ?? LIMITE_ESPERA,
  };
}

// Cadastra o grupo na primeira vez que ele manda qualquer mensagem.
// Fica INATIVO por padrão — precisa ser liberado manualmente via comando
// de admin no privado (ver adminCommands.js) antes de aceitar comandos de lista.
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

// Promove os mais antigos da espera enquanto houver vaga na principal.
// É o que garante a ordem de chegada quando a lista cresce ou abre vaga —
// sem isso, um novato entraria na principal furando a fila de quem esperava.
function promoverEsperaEnquantoCouber(listaId) {
  const limites = getLimitesDaLista(listaId);
  const promovidos = [];
  while (contarPorTipo(listaId, 'principal') < limites.principal) {
    const proximo = db.prepare(
      "SELECT * FROM entradas WHERE lista_id = ? AND tipo = 'espera' ORDER BY timestamp ASC LIMIT 1"
    ).get(listaId);
    if (!proximo) break;
    db.prepare("UPDATE entradas SET tipo = 'principal' WHERE id = ?").run(proximo.id);
    promovidos.push(proximo.nome);
  }
  return promovidos;
}

// limites é opcional: { principal, espera } — só atualiza o que vier como número,
// então dá pra reativar/redimensionar sem perder o tamanho já configurado.
// Retorna { sucesso, promovidos }: se a lista ativa cresceu, quem estava na
// espera sobe na hora (em ordem de chegada) e os nomes voltam pro admin avisar.
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
  if (info.changes === 0) return { sucesso: false, promovidos: [] };

  const lista = getListaAtiva(chatId);
  const promovidos = lista ? promoverEsperaEnquantoCouber(lista.id) : [];
  return { sucesso: true, promovidos };
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

  // Copia o valor padrão do grupo — mudar o padrão depois não mexe em lista
  // já aberta (pra isso existe o #valor, que altera só a lista atual)
  const grupo = getGrupo(chatId);
  const valorCentavos = grupo?.valor_padrao_centavos || 0;

  const info = db.prepare(
    'INSERT INTO listas (chat_id, data_jogo, status, criada_em, valor_centavos) VALUES (?, ?, ?, ?, ?)'
  ).run(chatId, dataJogo, 'aberta', new Date().toISOString(), valorCentavos);

  return { ja_existia: false, lista: { id: info.lastInsertRowid, chat_id: chatId, data_jogo: dataJogo, status: 'aberta', valor_centavos: valorCentavos } };
}

function getLista(listaId) {
  return db.prepare('SELECT * FROM listas WHERE id = ?').get(listaId);
}

function getListaAtiva(chatId) {
  // A "ativa" é a lista aberta mais recente DESSE grupo
  return db.prepare(
    "SELECT * FROM listas WHERE chat_id = ? AND status = 'aberta' ORDER BY id DESC LIMIT 1"
  ).get(chatId);
}

// Última lista do grupo, aberta OU encerrada — os comandos de pagamento usam
// esta: a cobrança costuma acontecer depois do #encerrarlista, e travar nomes
// não pode travar o dinheiro
function getListaMaisRecente(chatId) {
  return db.prepare(
    'SELECT * FROM listas WHERE chat_id = ? ORDER BY id DESC LIMIT 1'
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

// Acha a entrada de alguém pelo número, com fallback na parte antes do @ —
// o WhatsApp às vezes endereça a MESMA pessoa ora como @c.us, ora como @lid,
// e o match exato quebraria o #pago via comprovante e o dedup de entrada
function acharEntradaPorNumero(listaId, numero) {
  const exato = db.prepare(
    'SELECT * FROM entradas WHERE lista_id = ? AND numero = ?'
  ).get(listaId, numero);
  if (exato) return exato;

  const usuario = String(numero || '').split('@')[0];
  if (!usuario) return undefined;
  return db.prepare('SELECT * FROM entradas WHERE lista_id = ?').all(listaId)
    .find((e) => String(e.numero).split('@')[0] === usuario);
}

function jaEstaNaLista(listaId, numero) {
  return acharEntradaPorNumero(listaId, numero);
}

// Apaga todas as entradas de uma lista, mantendo a lista em si (não recria
// data/status) — útil pra retestar o fluxo de lotação sem abrir lista nova
// toda vez. Só é exposta via comando se TEST_MODE estiver ligado.
function limparEntradas(listaId) {
  const info = db.prepare('DELETE FROM entradas WHERE lista_id = ?').run(listaId);
  return info.changes;
}

// Retorna: { tipo: 'principal'|'espera', posicao, evento: null|'lista_cheia'|'tudo_lotado' }
function adicionarEntrada(listaId, nome, numero) {
  if (jaEstaNaLista(listaId, numero)) {
    return { erro: 'ja_esta_na_lista' };
  }

  const timestamp = new Date().toISOString();
  const limites = getLimitesDaLista(listaId);

  // Se sobrou vaga na principal com gente na espera (ex: lista redimensionada
  // por fora), os antigos sobem ANTES do recém-chegado ser posicionado
  const promovidos = promoverEsperaEnquantoCouber(listaId);

  const totalPrincipal = contarPorTipo(listaId, 'principal');
  if (totalPrincipal < limites.principal) {
    db.prepare(
      'INSERT INTO entradas (lista_id, nome, numero, tipo, timestamp) VALUES (?, ?, ?, ?, ?)'
    ).run(listaId, nome, numero, 'principal', timestamp);

    const novoTotal = totalPrincipal + 1;
    // Se o grupo não tem lista de espera (--0), encher a principal já lota tudo
    const evento = novoTotal === limites.principal
      ? (limites.espera === 0 ? 'tudo_lotado' : 'lista_cheia')
      : null;
    return { tipo: 'principal', posicao: novoTotal, evento, promovidos };
  }

  const totalEspera = contarPorTipo(listaId, 'espera');
  if (totalEspera < limites.espera) {
    db.prepare(
      'INSERT INTO entradas (lista_id, nome, numero, tipo, timestamp) VALUES (?, ?, ?, ?, ?)'
    ).run(listaId, nome, numero, 'espera', timestamp);

    const novoTotal = totalEspera + 1;
    const evento = novoTotal === limites.espera ? 'tudo_lotado' : null;
    return { tipo: 'espera', posicao: novoTotal, evento, promovidos };
  }

  return { erro: 'tudo_lotado' };
}

function montarListaFormatada(listaId, dataJogo) {
  const limites = getLimitesDaLista(listaId);
  const marcaPago = (p) => (p.pago ? ' ✅' : '');
  const principal = db.prepare(
    "SELECT nome, pago FROM entradas WHERE lista_id = ? AND tipo = 'principal' ORDER BY timestamp ASC"
  ).all(listaId);

  let texto = `📋 *Lista do vôlei — ${dataJogo}*\n`;
  texto += `━━━━━━━━━━━━━━━\n`;
  texto += `🟢 *PRINCIPAL* (${principal.length}/${limites.principal})\n`;
  texto += principal.length
    ? principal.map((p, i) => `${i + 1}. ${p.nome}${marcaPago(p)}`).join('\n')
    : '_(vazia)_';

  const espera = db.prepare(
    "SELECT nome, pago FROM entradas WHERE lista_id = ? AND tipo = 'espera' ORDER BY timestamp ASC"
  ).all(listaId);
  // Grupo sem espera (--0) não mostra a seção, a não ser que alguém tenha
  // sobrado nela (ex: lista foi encolhida depois de cheia)
  if (limites.espera > 0 || espera.length > 0) {
    texto += `\n━━━━━━━━━━━━━━━\n`;
    texto += `🟡 *ESPERA* (${espera.length}/${limites.espera})\n`;
    texto += espera.length
      ? espera.map((p, idx) => `${principal.length + idx + 1}. ${p.nome}${marcaPago(p)}`).join('\n')
      : '_(vazia)_';
  }

  // Total arrecadado fica só na visão dos admins (#pagosde) — no grupo
  // mostra apenas o valor por pessoa e quantos já pagaram
  const resumo = resumoPagamentos(listaId);
  if (resumo.valorCentavos > 0) {
    texto += `\n━━━━━━━━━━━━━━━\n`;
    texto += `💰 ${formatarReais(resumo.valorCentavos)} por pessoa — ${resumo.pagos}/${resumo.totalPessoas} pagos ✅`;
  }

  return texto;
}

// ---- pagamentos

// Grava o pago com snapshot do valor vigente: se o #valor mudar depois,
// o que já entrou em caixa não é reescrito
function aplicarPago(entrada, listaId, pago) {
  const valorPago = pago ? (getLista(listaId)?.valor_centavos || 0) : 0;
  db.prepare('UPDATE entradas SET pago = ?, valor_pago_centavos = ? WHERE id = ?')
    .run(pago ? 1 : 0, valorPago, entrada.id);
  return { nome: entrada.nome };
}

function marcarPagoPorPosicao(listaId, posicao, pago) {
  const combinada = listarCombinada(listaId);
  const alvo = combinada[posicao - 1]; // mesma numeração exibida no #mostralista
  if (!alvo) return { erro: 'posicao_invalida' };
  return aplicarPago(alvo, listaId, pago);
}

// Usado quando o admin responde a mensagem do comprovante com #pago:
// marca quem ENVIOU a mensagem citada, pelo número
function marcarPagoPorNumero(listaId, numero, pago) {
  const alvo = acharEntradaPorNumero(listaId, numero);
  if (!alvo) return { erro: 'nao_esta_na_lista' };
  return aplicarPago(alvo, listaId, pago);
}

function resumoPagamentos(listaId) {
  const lista = getLista(listaId);
  const entradas = listarCombinada(listaId);
  const pagos = entradas.filter((e) => e.pago);
  const valorCentavos = lista?.valor_centavos || 0;
  return {
    totalPessoas: entradas.length,
    pagos: pagos.length,
    nomesPagos: pagos.map((e) => e.nome),
    pendentes: entradas.filter((e) => !e.pago).map((e) => e.nome),
    valorCentavos,
    // Soma dos snapshots — o fallback pro valor atual cobre marcas antigas
    // de antes da coluna valor_pago_centavos existir
    arrecadadoCentavos: pagos.reduce((soma, e) => soma + (e.valor_pago_centavos || valorCentavos), 0),
  };
}

function setarValorLista(listaId, centavos) {
  db.prepare('UPDATE listas SET valor_centavos = ? WHERE id = ?').run(centavos, listaId);
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

// Compara ignorando acento e caixa — "volei" tem que achar "Vôlei de Quinta"
function normalizarTexto(texto) {
  // NFD separa a letra do acento; \p{M} apaga as marcas combinantes
  return String(texto || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
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

  // Sobe da espera enquanto couber na principal — normalmente 1, mas pode ser
  // mais se a lista tiver sido redimensionada; e nada se ela foi encolhida e a
  // principal ainda está acima do limite novo
  const promovidos = promoverEsperaEnquantoCouber(listaId);

  // Sinaliza se apagamos um ✅ junto — o grupo precisa saber que a pessoa
  // removida já tinha pago, senão o rastro do dinheiro some em silêncio
  return { removido: alvo.nome, removidoTinhaPago: Boolean(alvo.pago), promovidos };
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
  getLista,
  getListaAtiva,
  getListaMaisRecente,
  encerrarLista,
  adicionarEntrada,
  limparEntradas,
  montarListaFormatada,
  removerPorPosicao,
  historico,
  marcarPagoPorPosicao,
  marcarPagoPorNumero,
  resumoPagamentos,
  setarValorLista,
  setarValorPadraoGrupo,
  marcarGrupoAdmin,
  buscarGrupos,
  paraCentavos,
  formatarReais,
  LIMITE_PRINCIPAL,
  LIMITE_ESPERA,
};
