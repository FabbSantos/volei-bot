// Mensalistas: vaga garantida no topo de toda lista, paga por mês. Fixo tem
// vaga cativa; não-fixo disputa as vagas a cada mês, com fila de espera.
const { db, migrarColunas } = require('../../nucleo/banco');
const { formatarReais } = require('../../nucleo/dinheiro');
const { mesAtual } = require('../../nucleo/tempo');
const grupos = require('../grupos/repositorio');

const LIMITE_MENSALISTAS = 12; // vagas de mensalista por grupo (fixos inclusos)

db.exec(`
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
`);
// A configuração de mensalista mora na linha do grupo
migrarColunas('grupos', {
  limite_mensalistas: `INTEGER NOT NULL DEFAULT ${LIMITE_MENSALISTAS}`,
  valor_mes_centavos: 'INTEGER NOT NULL DEFAULT 0', // mensalidade padrão do grupo
  mes_processado: 'TEXT', // último mês em que a virada de mensalistas rodou
  pre_lista_aberta: 'INTEGER NOT NULL DEFAULT 0', // inscrições de mensalista abertas?
});
migrarColunas('mensalistas', {
  espera: 'INTEGER NOT NULL DEFAULT 0', // candidato além das vagas: fila de espera
});

// Virada do mês (preguiçosa — roda na primeira operação de mensalistas do
// mês): os NÃO-fixos saem do quadro e as vagas mensais reabrem pra disputa.
// Fixo tem vaga cativa: fica no quadro, só volta a "pendente" até pagar.
function processarViradaDoMes(chatId) {
  const grupo = grupos.getGrupo(chatId);
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
  const grupo = grupos.getGrupo(chatId);
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
  const grupo = grupos.getGrupo(chatId);
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

module.exports = {
  LIMITE_MENSALISTAS,
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
};
