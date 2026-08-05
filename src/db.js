const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'volei.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Padrões — cada grupo pode ter o seu, ajustado via #ativargrupo no privado do admin
const LIMITE_PRINCIPAL = 18;
const LIMITE_ESPERA = 6;
const LIMITE_MENSALISTAS = 12; // vagas de mensalista por grupo (fixos inclusos)

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
    nome TEXT,                      -- opcional: "Volei Riachuelo" (#lista30/07 Volei Riachuelo)
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
    mensalista INTEGER NOT NULL DEFAULT 0, -- entrada semeada automaticamente pro mensalista no topo da lista
    FOREIGN KEY (lista_id) REFERENCES listas(id)
  );

  CREATE TABLE IF NOT EXISTS mensalistas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    nome TEXT NOT NULL,
    numero TEXT NOT NULL,
    fixo INTEGER NOT NULL DEFAULT 0, -- vaga cativa: não disputa as vagas de mensalista
    criado_em TEXT NOT NULL,
    UNIQUE(chat_id, numero)
  );

  CREATE TABLE IF NOT EXISTS mensalidades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mensalista_id INTEGER NOT NULL,
    mes TEXT NOT NULL,              -- 'AAAA-MM' no fuso de Brasília — vira sozinho todo dia 1º
    valor_centavos INTEGER NOT NULL DEFAULT 0,
    pago_em TEXT NOT NULL,
    UNIQUE(mensalista_id, mes),
    FOREIGN KEY (mensalista_id) REFERENCES mensalistas(id)
  );

  CREATE TABLE IF NOT EXISTS inadimplentes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    nome TEXT NOT NULL,
    numero TEXT,                    -- quando conhecido, bloqueia a entrada em listas novas
    valor_centavos INTEGER NOT NULL DEFAULT 0, -- quanto deve (0 = não informado)
    criado_em TEXT NOT NULL
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
  limite_mensalistas: `INTEGER NOT NULL DEFAULT ${LIMITE_MENSALISTAS}`,
  valor_mes_centavos: 'INTEGER NOT NULL DEFAULT 0', // mensalidade padrão do grupo
  mes_processado: 'TEXT', // último mês em que a virada de mensalistas rodou
  pre_lista_aberta: 'INTEGER NOT NULL DEFAULT 0', // inscrições de mensalista abertas?
});
migrarColunas('listas', {
  valor_centavos: 'INTEGER NOT NULL DEFAULT 0',
  nome: 'TEXT',
  lembrete_em: 'TEXT', // dia (YYYY-MM-DD) do último lembrete de pagamento enviado
});
migrarColunas('mensalistas', {
  espera: 'INTEGER NOT NULL DEFAULT 0', // candidato além das vagas: fila de espera
});
migrarColunas('entradas', {
  pago: 'INTEGER NOT NULL DEFAULT 0',
  valor_pago_centavos: 'INTEGER NOT NULL DEFAULT 0',
  mensalista: 'INTEGER NOT NULL DEFAULT 0',
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
      "SELECT * FROM entradas WHERE lista_id = ? AND tipo = 'espera' ORDER BY timestamp ASC, id ASC LIMIT 1"
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

function criarLista(chatId, dataJogo, nome = null, valorCriacao = null) {
  const existente = db.prepare(
    'SELECT * FROM listas WHERE chat_id = ? AND data_jogo = ?'
  ).get(chatId, dataJogo);
  if (existente) return { ja_existia: true, lista: existente };

  // Valor explícito na criação (ex: sexta de 3h mais cara) vence o padrão do
  // grupo; sem ele, copia o padrão — e mudar o padrão depois não mexe em
  // lista já aberta (pra isso existe o #valor, que altera só a lista atual)
  const grupo = getGrupo(chatId);
  const valorCentavos = valorCriacao != null ? valorCriacao : (grupo?.valor_padrao_centavos || 0);

  const info = db.prepare(
    'INSERT INTO listas (chat_id, data_jogo, status, criada_em, valor_centavos, nome) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(chatId, dataJogo, 'aberta', new Date().toISOString(), valorCentavos, nome);
  const listaId = info.lastInsertRowid;

  // Mensalistas EFETIVOS entram automaticamente no topo de toda lista nova:
  // fixos sempre; não-fixo só depois de pagar o mês (inscrito na pré-lista é
  // candidato, não mensalista). Espera e inadimplente não são semeados.
  for (const m of listarMensalistas(chatId).filter((m) => !m.espera && (m.fixo || m.pago_mes))) {
    const resultado = adicionarEntrada(listaId, m.nome, m.numero);
    if (!resultado.erro) {
      db.prepare('UPDATE entradas SET mensalista = 1 WHERE lista_id = ? AND numero = ?')
        .run(listaId, m.numero);
    }
  }

  return { ja_existia: false, lista: { id: listaId, chat_id: chatId, data_jogo: dataJogo, status: 'aberta', valor_centavos: valorCentavos } };
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

// Cancela (APAGA) a lista mais recente do grupo, com as entradas e os ✅
// dela — pra lista criada errada ou teste. Apagar de verdade libera
// recriar a mesma data (UNIQUE chat_id+data_jogo).
function cancelarLista(chatId) {
  const lista = getListaMaisRecente(chatId);
  if (!lista) return { erro: 'sem_lista' };
  const entradas = db.prepare('DELETE FROM entradas WHERE lista_id = ?').run(lista.id).changes;
  db.prepare('DELETE FROM listas WHERE id = ?').run(lista.id);
  return { data_jogo: lista.data_jogo, nome: lista.nome, entradas };
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

  // Inadimplente não entra em lista nova até um admin dar #quitado
  const listaDona = getLista(listaId);
  if (listaDona && ehInadimplente(listaDona.chat_id, numero, nome)) {
    return { erro: 'inadimplente' };
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
  const lista = getLista(listaId);
  const limites = getLimitesDaLista(listaId);

  // Mensalista mostra o ✅ do MÊS ao lado do rótulo "Mensal"; a marca semanal
  // dele (#pago — ex: diferença da sexta de 3h) aparece como ➕.
  // Avulso mostra o ✅ da semana, como sempre.
  const numerosMesPago = new Set(
    listarMensalistas(lista?.chat_id).filter((m) => m.pago_mes).map((m) => m.numero)
  );
  const rotulo = (p) => {
    if (p.mensalista) {
      return `${p.nome} — Mensal${numerosMesPago.has(p.numero) ? ' ✅' : ''}${p.pago ? ' ➕' : ''}`;
    }
    return `${p.nome}${p.pago ? ' ✅' : ''}`;
  };

  const principal = db.prepare(
    "SELECT nome, pago, numero, mensalista FROM entradas WHERE lista_id = ? AND tipo = 'principal' ORDER BY timestamp ASC, id ASC"
  ).all(listaId);

  let texto = `📋 *${lista?.nome || 'Lista do vôlei'} — ${dataJogo}*\n`;
  texto += `━━━━━━━━━━━━━━━\n`;
  texto += `🟢 *PRINCIPAL* (${principal.length}/${limites.principal})\n`;
  texto += principal.length
    ? principal.map((p, i) => `${i + 1}. ${rotulo(p)}`).join('\n')
    : '_(vazia)_';

  const espera = db.prepare(
    "SELECT nome, pago, numero, mensalista FROM entradas WHERE lista_id = ? AND tipo = 'espera' ORDER BY timestamp ASC, id ASC"
  ).all(listaId);
  // Grupo sem espera (--0) não mostra a seção, a não ser que alguém tenha
  // sobrado nela (ex: lista foi encolhida depois de cheia)
  if (limites.espera > 0 || espera.length > 0) {
    texto += `\n━━━━━━━━━━━━━━━\n`;
    texto += `🟡 *ESPERA* (${espera.length}/${limites.espera})\n`;
    texto += espera.length
      ? espera.map((p, idx) => `${principal.length + idx + 1}. ${rotulo(p)}`).join('\n')
      : '_(vazia)_';
  }

  // Total arrecadado fica só na visão dos admins (#pagosde) — no grupo
  // mostra o valor por pessoa e quantos estão em dia (mensalista conta pelo mês)
  const resumo = resumoPagamentos(listaId);
  if (resumo.valorCentavos > 0 && resumo.totalCobrados > 0) {
    texto += `\n━━━━━━━━━━━━━━━\n`;
    texto += `💰 ${formatarReais(resumo.valorCentavos)} por pessoa — ${resumo.emDia}/${resumo.totalCobrados} em dia ✅`;
  }

  // Inadimplentes do grupo ficam visíveis em toda lista
  const inadimplentes = listarInadimplentes(lista?.chat_id);
  if (inadimplentes.length > 0) {
    texto += `\n━━━━━━━━━━━━━━━\n`;
    texto += `⛔ *INADIMPLENTES*\n`;
    texto += inadimplentes
      .map((i) => `• ${i.nome}${i.valor_centavos > 0 ? ` (${formatarReais(i.valor_centavos)})` : ''}`)
      .join('\n');
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
  // Cobrança é só de quem tem VAGA: a espera não deve nada até subir,
  // então fica fora do "em dia" e da mira do agiota
  const principal = entradas.filter((e) => e.tipo === 'principal');
  const pagos = entradas.filter((e) => e.pago);
  const valorCentavos = lista?.valor_centavos || 0;

  // "Em dia" é o que importa na cobrança: avulso conta pelo ✅ da semana,
  // mensalista conta pelo MÊS pago (a semana dele já está na mensalidade;
  // o ➕ é só extra). Mensalista devendo o mês aparece como "(mês)".
  const numerosMesPago = new Set(
    listarMensalistas(lista?.chat_id).filter((m) => m.pago_mes).map((m) => m.numero)
  );
  const estaEmDia = (e) => (e.mensalista ? numerosMesPago.has(e.numero) : Boolean(e.pago));

  return {
    totalPessoas: entradas.length,
    totalCobrados: principal.length,
    mensalistasNaLista: entradas.filter((e) => e.mensalista).length,
    emDia: principal.filter(estaEmDia).length,
    pagos: pagos.length,
    nomesPagos: pagos.map((e) => e.nome),
    pendentes: principal
      .filter((e) => !estaEmDia(e))
      .map((e) => (e.mensalista ? `${e.nome} (mês)` : e.nome)),
    valorCentavos,
    // Dinheiro da LISTA (avulsos + extras ➕ de mensalista), pelos snapshots —
    // mensalidade é caixa separado, aparece no #mensalistasde
    arrecadadoCentavos: pagos.reduce((soma, e) => soma + (e.valor_pago_centavos || valorCentavos), 0),
  };
}

function setarValorLista(listaId, centavos) {
  db.prepare('UPDATE listas SET valor_centavos = ? WHERE id = ?').run(centavos, listaId);
}

// Listas abertas de grupos de pelada ativos que ainda não receberam o
// lembrete de pagamento de hoje (o carimbo garante 1 por dia, por lista)
function listasParaLembrete(hoje) {
  return db.prepare(`
    SELECT l.* FROM listas l
    JOIN grupos g ON g.chat_id = l.chat_id
    WHERE l.status = 'aberta' AND g.ativo = 1 AND g.eh_admin = 0
      AND (l.lembrete_em IS NULL OR l.lembrete_em <> ?)
  `).all(hoje);
}

function marcarLembreteEnviado(listaId, hoje) {
  db.prepare('UPDATE listas SET lembrete_em = ? WHERE id = ?').run(hoje, listaId);
}

function setarValorPadraoGrupo(chatId, centavos) {
  const info = db.prepare('UPDATE grupos SET valor_padrao_centavos = ? WHERE chat_id = ?').run(centavos, chatId);
  return info.changes > 0;
}

// ---- mensalistas

// 'AAAA-MM' no fuso de Brasília: o container roda em UTC e a virada do mês
// tem que acontecer à meia-noite local, não às 21h
function mesAtual() {
  const partes = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  const ano = partes.find((p) => p.type === 'year').value;
  const mes = partes.find((p) => p.type === 'month').value;
  return `${ano}-${mes}`;
}

// Virada do mês (preguiçosa — roda na primeira operação de mensalistas do
// mês): os NÃO-fixos saem do quadro e as vagas mensais reabrem pra disputa.
// Fixo tem vaga cativa: fica no quadro, só volta a "pendente" até pagar.
function processarViradaDoMes(chatId) {
  const grupo = getGrupo(chatId);
  if (!grupo) return;
  const mes = mesAtual();
  if (grupo.mes_processado === mes) return;

  db.prepare('UPDATE grupos SET mes_processado = ? WHERE chat_id = ?').run(mes, chatId);
  // Primeiro contato do grupo com o sistema de mês: só registra, sem remover
  if (!grupo.mes_processado) return;

  const removidos = removerMensalistasNaoFixos(chatId);
  if (removidos > 0) {
    console.log(`[mensalistas] virada pra ${mes} em ${chatId}: ${removidos} não-fixo(s) saíram do quadro`);
  }
}

// Tira todos os não-fixos do quadro (com o histórico de mensalidade deles) e
// fecha as inscrições — é o miolo da virada do mês e do #reiniciarmensalistasde
function removerMensalistasNaoFixos(chatId) {
  const naoFixos = db.prepare(
    'SELECT * FROM mensalistas WHERE chat_id = ? AND fixo = 0'
  ).all(chatId);
  for (const m of naoFixos) {
    db.prepare('DELETE FROM mensalidades WHERE mensalista_id = ?').run(m.id);
    db.prepare('DELETE FROM mensalistas WHERE id = ?').run(m.id);
  }
  db.prepare('UPDATE grupos SET pre_lista_aberta = 0 WHERE chat_id = ?').run(chatId);
  return naoFixos.length;
}

function reiniciarMensalistas(chatId) {
  processarViradaDoMes(chatId); // não deixa a virada pendente mascarar o reinício
  return { removidos: removerMensalistasNaoFixos(chatId) };
}

// Abre/fecha as inscrições da pré-lista de mensalistas (as vagas mensais)
function abrirPreLista(chatId, abrir) {
  const info = db.prepare('UPDATE grupos SET pre_lista_aberta = ? WHERE chat_id = ?').run(abrir ? 1 : 0, chatId);
  return info.changes > 0;
}

// Roster do grupo com o status do mês corrente (pago_mes = ✅ do "Mensal").
// Titulares primeiro (fixos no topo), espera no fim — a numeração dos comandos
// (#pagomes N, #fixo N...) segue essa ordem.
function listarMensalistas(chatId) {
  if (!chatId) return [];
  processarViradaDoMes(chatId);
  return db.prepare(`
    SELECT m.*, (mm.id IS NOT NULL) AS pago_mes, mm.valor_centavos AS valor_mes_pago
    FROM mensalistas m
    LEFT JOIN mensalidades mm ON mm.mensalista_id = m.id AND mm.mes = ?
    WHERE m.chat_id = ?
    ORDER BY m.espera ASC, m.fixo DESC, m.criado_em ASC, m.id ASC
  `).all(mesAtual(), chatId);
}

function acharMensalistaPorNumero(chatId, numero) {
  const todos = listarMensalistas(chatId);
  const usuario = String(numero || '').split('@')[0];
  return todos.find((m) => m.numero === numero)
    || todos.find((m) => String(m.numero).split('@')[0] === usuario);
}

// Vagas cheias não recusam mais: o excedente entra na fila de ESPERA dos
// mensalistas (sem limite) e sobe quando um titular sai
function adicionarMensalista(chatId, nome, numero) {
  if (acharMensalistaPorNumero(chatId, numero)) return { erro: 'ja_e_mensalista' };
  const grupo = getGrupo(chatId);
  const limite = grupo?.limite_mensalistas ?? LIMITE_MENSALISTAS;
  const todos = listarMensalistas(chatId);
  const titulares = todos.filter((m) => !m.espera).length;
  const vaiPraEspera = titulares >= limite;
  db.prepare(
    'INSERT INTO mensalistas (chat_id, nome, numero, fixo, espera, criado_em) VALUES (?, ?, ?, 0, ?, ?)'
  ).run(chatId, nome, numero, vaiPraEspera ? 1 : 0, new Date().toISOString());
  return {
    posicao: vaiPraEspera ? todos.length + 1 : titulares + 1,
    limite,
    espera: vaiPraEspera,
  };
}

function removerMensalistaPorPosicao(chatId, posicao) {
  const alvo = listarMensalistas(chatId)[posicao - 1];
  if (!alvo) return { erro: 'posicao_invalida' };
  db.prepare('DELETE FROM mensalidades WHERE mensalista_id = ?').run(alvo.id);
  db.prepare('DELETE FROM mensalistas WHERE id = ?').run(alvo.id);

  // Saiu um titular → o primeiro da espera assume a vaga mensal
  let promovido = null;
  if (!alvo.espera) {
    const proximo = db.prepare(
      'SELECT * FROM mensalistas WHERE chat_id = ? AND espera = 1 ORDER BY criado_em ASC, id ASC LIMIT 1'
    ).get(chatId);
    if (proximo) {
      db.prepare('UPDATE mensalistas SET espera = 0 WHERE id = ?').run(proximo.id);
      promovido = proximo.nome;
    }
  }
  return { nome: alvo.nome, promovido };
}

function alternarFixoPorPosicao(chatId, posicao) {
  const alvo = listarMensalistas(chatId)[posicao - 1];
  if (!alvo) return { erro: 'posicao_invalida' };
  const novoFixo = alvo.fixo ? 0 : 1;
  db.prepare('UPDATE mensalistas SET fixo = ? WHERE id = ?').run(novoFixo, alvo.id);
  return { nome: alvo.nome, fixo: Boolean(novoFixo) };
}

// pago=true grava/atualiza a mensalidade do mês corrente (com snapshot do
// valor); pago=false apaga — a pessoa volta a "pendente" no mês
function marcarMesPagoPorPosicao(chatId, posicao, pago, valorCentavos) {
  const alvo = listarMensalistas(chatId)[posicao - 1];
  if (!alvo) return { erro: 'posicao_invalida' };
  const mes = mesAtual();
  if (pago) {
    db.prepare(`
      INSERT INTO mensalidades (mensalista_id, mes, valor_centavos, pago_em) VALUES (?, ?, ?, ?)
      ON CONFLICT(mensalista_id, mes) DO UPDATE SET valor_centavos = excluded.valor_centavos
    `).run(alvo.id, mes, valorCentavos || 0, new Date().toISOString());
  } else {
    db.prepare('DELETE FROM mensalidades WHERE mensalista_id = ? AND mes = ?').run(alvo.id, mes);
  }
  return { nome: alvo.nome, fixo: Boolean(alvo.fixo) };
}

function setarValorMes(chatId, centavos) {
  const info = db.prepare('UPDATE grupos SET valor_mes_centavos = ? WHERE chat_id = ?').run(centavos, chatId);
  return info.changes > 0;
}

function setarLimiteMensalistas(chatId, limite) {
  const info = db.prepare('UPDATE grupos SET limite_mensalistas = ? WHERE chat_id = ?').run(limite, chatId);
  return info.changes > 0;
}

function resumoMensalistas(chatId) {
  const grupo = getGrupo(chatId);
  const todos = listarMensalistas(chatId);
  const titulares = todos.filter((m) => !m.espera);
  const pagos = titulares.filter((m) => m.pago_mes);
  return {
    mes: mesAtual(),
    total: titulares.length,
    espera: todos.length - titulares.length,
    limite: grupo?.limite_mensalistas ?? LIMITE_MENSALISTAS,
    preListaAberta: Boolean(grupo?.pre_lista_aberta),
    valorMesCentavos: grupo?.valor_mes_centavos || 0,
    pagos: pagos.length,
    pendentes: titulares.filter((m) => !m.pago_mes).map((m) => m.nome),
    arrecadadoMesCentavos: pagos.reduce((soma, m) => soma + (m.valor_mes_pago || 0), 0),
  };
}

function montarMensalistasFormatado(chatId) {
  const resumo = resumoMensalistas(chatId);
  const todos = listarMensalistas(chatId);
  const titulares = todos.filter((m) => !m.espera);
  const naEspera = todos.filter((m) => m.espera);
  const [ano, mes] = resumo.mes.split('-');
  const linha = (m, i) => `${i + 1}. ${m.nome}${m.fixo ? ' 📌' : ''}${m.pago_mes ? ' ✅' : ''}`;

  let texto = `🗓 *Mensalistas — ${mes}/${ano}* (${resumo.total}/${resumo.limite}) · inscrições ${resumo.preListaAberta ? 'abertas' : 'fechadas'}\n`;
  texto += `━━━━━━━━━━━━━━━\n`;
  texto += titulares.length
    ? titulares.map(linha).join('\n')
    : '_(nenhum ainda — manda #mensalista pra entrar)_';
  if (naEspera.length > 0) {
    texto += `\n━━━━━━━━━━━━━━━\n`;
    texto += `⏳ *ESPERA*\n`;
    texto += naEspera.map((m, idx) => linha(m, titulares.length + idx)).join('\n');
  }
  if (resumo.valorMesCentavos > 0) {
    texto += `\n━━━━━━━━━━━━━━━\n`;
    texto += `💰 Mensalidade: ${formatarReais(resumo.valorMesCentavos)} — ${resumo.pagos}/${resumo.total} pagos`;
  }
  // Deixa a conta das vagas explícita: fixos ocupam vaga do total
  const fixos = todos.filter((m) => m.fixo).length;
  const livres = Math.max(0, resumo.limite - resumo.total);
  texto += `\n${fixos} fixa(s) + ${resumo.total - fixos} mensais · ${livres} vaga(s) livre(s)`;
  texto += `\n_📌 fixo · ✅ mês pago_`;
  return texto;
}

// ---- inadimplentes

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

// Lista combinada (principal seguido de espera), na ordem de exibição/numeração.
// id como desempate: entradas semeadas em lote podem cair no mesmo milissegundo
function listarCombinada(listaId) {
  const principal = db.prepare(
    "SELECT * FROM entradas WHERE lista_id = ? AND tipo = 'principal' ORDER BY timestamp ASC, id ASC"
  ).all(listaId);
  const espera = db.prepare(
    "SELECT * FROM entradas WHERE lista_id = ? AND tipo = 'espera' ORDER BY timestamp ASC, id ASC"
  ).all(listaId);
  return [...principal, ...espera];
}

function getEntradaPorPosicao(listaId, posicao) {
  return listarCombinada(listaId)[posicao - 1];
}

function removerEntrada(listaId, alvo) {
  db.prepare('DELETE FROM entradas WHERE id = ?').run(alvo.id);

  // Sobe da espera enquanto couber na principal — normalmente 1, mas pode ser
  // mais se a lista tiver sido redimensionada; e nada se ela foi encolhida e a
  // principal ainda está acima do limite novo
  const promovidos = promoverEsperaEnquantoCouber(listaId);

  // Sinaliza se apagamos um ✅ junto — o grupo precisa saber que a pessoa
  // removida já tinha pago, senão o rastro do dinheiro some em silêncio
  return { removido: alvo.nome, removidoTinhaPago: Boolean(alvo.pago), promovidos };
}

// Remove pela posição exibida em #mostralista (1-18 principal, 19+ espera).
// Se remover da principal, promove automaticamente o primeiro da espera.
function removerPorPosicao(listaId, posicao) {
  const alvo = listarCombinada(listaId)[posicao - 1]; // posicao é 1-indexed
  if (!alvo) return { erro: 'posicao_invalida' };
  return removerEntrada(listaId, alvo);
}

// Auto-remoção (#remover sem argumento): acha a entrada pelo número de quem
// pediu — cobre também quem entrou com "#lista Nome", porque a entrada fica
// pendurada no número de quem digitou
function removerPorNumero(listaId, numero) {
  const alvo = acharEntradaPorNumero(listaId, numero);
  if (!alvo) return { erro: 'nao_esta_na_lista' };
  return removerEntrada(listaId, alvo);
}

// Entradas cujo nome bate (ignorando acento/caixa) — pro "#remover Nome"
function acharEntradasPorNome(listaId, nome) {
  const alvo = normalizarTexto(nome).trim();
  return listarCombinada(listaId).filter((e) => normalizarTexto(e.nome).trim() === alvo);
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
  cancelarLista,
  getLista,
  getListaAtiva,
  getListaMaisRecente,
  encerrarLista,
  adicionarEntrada,
  limparEntradas,
  montarListaFormatada,
  removerPorPosicao,
  removerPorNumero,
  removerEntrada,
  acharEntradasPorNome,
  historico,
  listarGruposAdmin,
  marcarPagoPorPosicao,
  marcarPagoPorNumero,
  resumoPagamentos,
  setarValorLista,
  setarValorPadraoGrupo,
  listasParaLembrete,
  marcarLembreteEnviado,
  marcarGrupoAdmin,
  buscarGrupos,
  paraCentavos,
  formatarReais,
  getEntradaPorPosicao,
  mesAtual,
  listarMensalistas,
  adicionarMensalista,
  removerMensalistaPorPosicao,
  abrirPreLista,
  reiniciarMensalistas,
  alternarFixoPorPosicao,
  marcarMesPagoPorPosicao,
  setarValorMes,
  setarLimiteMensalistas,
  resumoMensalistas,
  montarMensalistasFormatado,
  listarInadimplentes,
  ehInadimplente,
  adicionarInadimplente,
  quitarInadimplente,
  LIMITE_PRINCIPAL,
  LIMITE_ESPERA,
  LIMITE_MENSALISTAS,
};
