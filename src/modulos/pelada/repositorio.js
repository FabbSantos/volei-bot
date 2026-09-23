// A pelada da semana: listas por grupo, quem entrou (principal e espera) e o
// pagamento de cada um.
const { db, migrarColunas } = require('../../nucleo/banco');
const { formatarReais } = require('../../nucleo/dinheiro');
const { normalizarTexto } = require('../../nucleo/texto');
const { numeroSintetico } = require('../../nucleo/numeros');
const grupos = require('../grupos/repositorio');
const mensalistas = require('../mensalistas/repositorio');
const inadimplentes = require('../inadimplentes/repositorio');

db.exec(`
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
`);
migrarColunas('listas', {
  valor_centavos: 'INTEGER NOT NULL DEFAULT 0',
  nome: 'TEXT',
  lembrete_em: 'TEXT', // dia (YYYY-MM-DD) do último lembrete de pagamento enviado
});
migrarColunas('entradas', {
  pago: 'INTEGER NOT NULL DEFAULT 0',
  promovido: 'INTEGER NOT NULL DEFAULT 0', // subiu da espera pra principal (prazo de pagamento diferente)
  valor_pago_centavos: 'INTEGER NOT NULL DEFAULT 0',
  mensalista: 'INTEGER NOT NULL DEFAULT 0',
});

// Outros módulos guardam coisas penduradas numa lista (times, notas do dia).
// Quando a lista é apagada, cada um limpa o que é seu — a pelada não precisa
// conhecer as tabelas deles.
const aoApagarLista = [];
function quandoApagarLista(fn) {
  aoApagarLista.push(fn);
}

// Limites do grupo dono da lista — cai nos padrões se o grupo sumir do cadastro
function getLimitesDaLista(listaId) {
  const lista = getLista(listaId);
  const grupo = lista && grupos.getGrupo(lista.chat_id);
  return {
    principal: grupo?.limite_principal ?? grupos.LIMITE_PRINCIPAL,
    espera: grupo?.limite_espera ?? grupos.LIMITE_ESPERA,
  };
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
    // promovido = 1 marca quem veio da espera — o prazo de pagamento deles
    // é outro (#cobrarsubiude usa isso pra achar quem cobrar)
    db.prepare("UPDATE entradas SET tipo = 'principal', promovido = 1 WHERE id = ?").run(proximo.id);
    promovidos.push(proximo.nome);
  }
  return promovidos;
}

// Grupo redimensionado (#ativargrupo): se a lista aberta cresceu, quem
// estava na espera sobe na hora, em ordem de chegada
function promoverEsperaDaListaAtiva(chatId) {
  const lista = getListaAtiva(chatId);
  return lista ? promoverEsperaEnquantoCouber(lista.id) : [];
}

function criarLista(chatId, dataJogo, nome = null, valorCriacao = null, opts = {}) {
  const existente = db.prepare(
    'SELECT * FROM listas WHERE chat_id = ? AND data_jogo = ?'
  ).get(chatId, dataJogo);
  if (existente) return { ja_existia: true, lista: existente };

  // Valor explícito na criação (ex: sexta de 3h mais cara) vence o padrão do
  // grupo; sem ele, copia o padrão — e mudar o padrão depois não mexe em
  // lista já aberta (pra isso existe o #valor, que altera só a lista atual)
  const grupo = grupos.getGrupo(chatId);
  const valorCentavos = valorCriacao != null ? valorCriacao : (grupo?.valor_padrao_centavos || 0);

  // criadaEm/status vêm preenchidos só no import histórico da planilha — a
  // ordem das listas é por criada_em, então a pelada antiga não vira "a atual"
  const info = db.prepare(
    'INSERT INTO listas (chat_id, data_jogo, status, criada_em, valor_centavos, nome) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(chatId, dataJogo, opts.status || 'aberta', opts.criadaEm || new Date().toISOString(), valorCentavos, nome);
  const listaId = info.lastInsertRowid;

  // Mensalistas EFETIVOS entram automaticamente no topo de toda lista nova:
  // fixos sempre; não-fixo só depois de pagar o mês (inscrito na pré-lista é
  // candidato, não mensalista). Espera e inadimplente não são semeados.
  //
  // Pelada extra (opts.soFixos): a mensalidade cobre as sextas, não ela. Só os
  // fixos entram sozinhos, e como participantes COMUNS — sem a marca de
  // mensalista, cada um precisa do próprio ✅ da pelada, igual aos avulsos.
  const soFixos = Boolean(opts.soFixos);
  const semeados = mensalistas.listarMensalistas(chatId).filter((m) =>
    !m.espera && (soFixos ? m.fixo : (m.fixo || m.pago_mes))
  );
  for (const m of semeados) {
    const resultado = adicionarEntrada(listaId, m.nome, m.numero);
    if (!resultado.erro && !soFixos) {
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
    "SELECT * FROM listas WHERE chat_id = ? AND status = 'aberta' ORDER BY criada_em DESC, id DESC LIMIT 1"
  ).get(chatId);
}

// Última lista do grupo, aberta OU encerrada — os comandos de pagamento usam
// esta: a cobrança costuma acontecer depois do #encerrarlista, e travar nomes
// não pode travar o dinheiro
// Ordena por criada_em (id como desempate) — assim uma pelada importada com
// data antiga não se passa pela lista da semana
function getListaMaisRecente(chatId) {
  return db.prepare(
    'SELECT * FROM listas WHERE chat_id = ? ORDER BY criada_em DESC, id DESC LIMIT 1'
  ).get(chatId);
}

// Todas as listas do grupo, da mais antiga pra mais nova — linha do tempo da evolução
function listasDoGrupo(chatId) {
  return db.prepare(
    'SELECT id, data_jogo, nome, criada_em FROM listas WHERE chat_id = ? ORDER BY criada_em ASC, id ASC'
  ).all(chatId);
}

// As últimas 15, da mais nova pra mais antiga — tela de avaliação pós-jogo
function listasRecentes(chatId) {
  return db.prepare(
    'SELECT * FROM listas WHERE chat_id = ? ORDER BY criada_em DESC, id DESC LIMIT 15'
  ).all(chatId);
}

// Corrige data e/ou nome de uma lista sem mexer em quem já está nela
function editarLista(listaId, { dataJogo = null, nome = null } = {}) {
  const lista = getLista(listaId);
  if (!lista) return { erro: 'sem_lista' };
  if (dataJogo && dataJogo !== lista.data_jogo) {
    const conflito = db.prepare(
      'SELECT 1 FROM listas WHERE chat_id = ? AND data_jogo = ? AND id <> ?'
    ).get(lista.chat_id, dataJogo, listaId);
    if (conflito) return { erro: 'data_ocupada' };
  }
  db.prepare('UPDATE listas SET data_jogo = COALESCE(?, data_jogo), nome = COALESCE(?, nome) WHERE id = ?')
    .run(dataJogo, nome, listaId);
  return { antes: lista, lista: getLista(listaId) };
}

function reabrirLista(listaId) {
  db.prepare("UPDATE listas SET status = 'aberta' WHERE id = ?").run(listaId);
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
  for (const fn of aoApagarLista) fn(lista.id);
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
  if (listaDona && inadimplentes.ehInadimplente(listaDona.chat_id, numero, nome)) {
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

// Registro de quem JÁ jogou (import da planilha): entra direto na principal,
// sem passar pelo limite de vagas — é história, não inscrição
function registrarPresencaHistorica(listaId, nome, numero) {
  if (jaEstaNaLista(listaId, numero)) return { erro: 'ja_esta' };
  db.prepare(
    'INSERT INTO entradas (lista_id, nome, numero, tipo, timestamp) VALUES (?, ?, ?, ?, ?)'
  ).run(listaId, nome, numero, 'principal', new Date().toISOString());
  return {};
}

function montarListaFormatada(listaId, dataJogo) {
  const lista = getLista(listaId);
  const limites = getLimitesDaLista(listaId);

  // Mensalista mostra o ✅ do MÊS ao lado do rótulo "Mensal"; a marca semanal
  // dele (#pago — ex: diferença da sexta de 3h) aparece como ➕.
  // Avulso mostra o ✅ da semana, como sempre.
  const numerosMesPago = new Set(
    mensalistas.listarMensalistas(lista?.chat_id).filter((m) => m.pago_mes).map((m) => m.numero)
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
  const devendo = inadimplentes.listarInadimplentes(lista?.chat_id);
  if (devendo.length > 0) {
    texto += `\n━━━━━━━━━━━━━━━\n`;
    texto += `⛔ *INADIMPLENTES*\n`;
    texto += devendo
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
    mensalistas.listarMensalistas(lista?.chat_id).filter((m) => m.pago_mes).map((m) => m.numero)
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
    // Mesma lista com o WhatsApp de cada um (quando dá pra marcar): o
    // convidado cadastrado na mão não tem número de verdade
    pendentesComZap: principal
      .filter((e) => !estaEmDia(e))
      .map((e) => ({
        nome: e.mensalista ? `${e.nome} (mês)` : e.nome,
        numero: numeroSintetico(e.numero) ? null : e.numero,
      })),
    // Quem subiu da espera e ainda não pagou — prazo próprio (sexta 17h)
    promovidosPendentes: principal
      .filter((e) => e.promovido && !estaEmDia(e))
      .map((e) => e.nome),
    promovidosPendentesComZap: principal
      .filter((e) => e.promovido && !estaEmDia(e))
      .map((e) => ({ nome: e.nome, numero: numeroSintetico(e.numero) ? null : e.numero })),
    valorCentavos,
    // Dinheiro da LISTA (avulsos + extras ➕ de mensalista), pelos snapshots —
    // mensalidade é caixa separado, aparece no #mensalistasde
    arrecadadoCentavos: pagos.reduce((soma, e) => soma + (e.valor_pago_centavos || valorCentavos), 0),
  };
}

function setarValorLista(listaId, centavos) {
  db.prepare('UPDATE listas SET valor_centavos = ? WHERE id = ?').run(centavos, listaId);
}

// A cobrança automática só existe com lista ABERTA: depois do jogo o assunto
// vira inadimplência (manual), não recado diário. Vale só pra lista mais
// recente do grupo, e o carimbo garante um lembrete por dia.
function listasParaLembrete(hoje) {
  return db.prepare(`
    SELECT l.* FROM listas l
    JOIN grupos g ON g.chat_id = l.chat_id
    WHERE l.status = 'aberta' AND g.ativo = 1 AND g.eh_admin = 0
      AND l.id = (SELECT l2.id FROM listas l2 WHERE l2.chat_id = l.chat_id ORDER BY l2.criada_em DESC, l2.id DESC LIMIT 1)
      AND (l.lembrete_em IS NULL OR l.lembrete_em <> ?)
  `).all(hoje);
}

function marcarLembreteEnviado(listaId, hoje) {
  db.prepare('UPDATE listas SET lembrete_em = ? WHERE id = ?').run(hoje, listaId);
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

// Só a lista principal, na ordem de exibição — é quem entra na montagem de times
function entradasPrincipais(listaId) {
  return db.prepare(
    "SELECT * FROM entradas WHERE lista_id = ? AND tipo = 'principal' ORDER BY timestamp ASC, id ASC"
  ).all(listaId);
}

// Todas as entradas de todas as listas do grupo — presença e evolução do elenco
function entradasDoGrupo(chatId) {
  return db.prepare(`
    SELECT e.*, l.id AS lid FROM entradas e
    JOIN listas l ON l.id = e.lista_id
    WHERE l.chat_id = ?
  `).all(chatId);
}

function getEntradaPorPosicao(listaId, posicao) {
  return listarCombinada(listaId)[posicao - 1];
}

// Corrige o nome de quem já está na lista sem mexer em posição, pagamento
// ou vínculo — pra quando o convidado foi cadastrado com o nome errado
function renomearEntradaPorPosicao(listaId, posicao, novoNome) {
  const alvo = listarCombinada(listaId)[posicao - 1];
  if (!alvo) return { erro: 'posicao_invalida' };
  const nome = String(novoNome || '').trim();
  if (!nome) return { erro: 'nome_vazio' };
  db.prepare('UPDATE entradas SET nome = ? WHERE id = ?').run(nome, alvo.id);
  return { antes: alvo.nome, depois: nome, tipo: alvo.tipo };
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
  quandoApagarLista,
  promoverEsperaDaListaAtiva,
  criarLista,
  cancelarLista,
  editarLista,
  getLista,
  getListaAtiva,
  getListaMaisRecente,
  listasDoGrupo,
  listasRecentes,
  encerrarLista,
  reabrirLista,
  contarPorTipo,
  adicionarEntrada,
  registrarPresencaHistorica,
  limparEntradas,
  montarListaFormatada,
  removerPorPosicao,
  removerPorNumero,
  renomearEntradaPorPosicao,
  removerEntrada,
  acharEntradasPorNome,
  getEntradaPorPosicao,
  entradasPrincipais,
  entradasDoGrupo,
  historico,
  marcarPagoPorPosicao,
  marcarPagoPorNumero,
  resumoPagamentos,
  setarValorLista,
  listasParaLembrete,
  marcarLembreteEnviado,
};
