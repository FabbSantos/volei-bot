const path = require('path');
const express = require('express');
const db = require('./db');

// Painel web dos admins: elenco, votação de habilidade por fundamento, nota
// do dia, montador de times e gráficos de evolução. Protegido por token
// secreto (PAINEL_TOKEN no host) — sem token configurado, fica desligado.
function registrarPainel(app, deps = {}) {
  const TOKEN = process.env.PAINEL_TOKEN;

  const exigirToken = (req, res, next) => {
    if (!TOKEN) {
      return res.status(503).json({ erro: 'Painel desligado — configure PAINEL_TOKEN no host.' });
    }
    const recebido = req.query.token || req.get('x-painel-token');
    if (recebido !== TOKEN) {
      return res.status(401).json({ erro: 'Token inválido.' });
    }
    next();
  };

  app.get('/painel', exigirToken, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'painel.html'));
  });

  // Chart.js servido localmente — nada de CDN
  app.get('/painel/chart.js', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.js'));
  });

  const api = express.Router();
  api.use(exigirToken);
  api.use(express.json());

  api.get('/grupos', (req, res) => {
    res.json(db.listarGrupos().filter((g) => g.ativo && !g.eh_admin));
  });

  api.get('/elenco', (req, res) => {
    const grupo = req.query.grupo;
    const semana = db.elencoDaSemana(grupo);
    // Votantes: os da planilha + quem já votou por aqui (sem repetir)
    const { VOTANTES } = require('./elencoSeed');
    const votantes = [...new Set([...VOTANTES, ...db.listarVotantes(grupo)])]
      .sort((a, b) => a.localeCompare(b, 'pt-BR'));
    res.json({
      fundamentos: db.FUNDAMENTOS,
      alturas: db.ALTURAS,
      votantes,
      jogadores: db.listarJogadores(grupo),
      // A mesma lista que o #timesde usa — o painel espelha o bot
      listaAtual: semana.lista
        ? { id: semana.lista.id, data_jogo: semana.lista.data_jogo, nome: semana.lista.nome, status: semana.lista.status }
        : null,
      preListaAberta: db.resumoMensalistas(grupo).preListaAberta,
      idsNaSemana: semana.naLista.map((j) => j.id),
      novosNaSemana: semana.novos,
      naEspera: semana.naEspera,
      // O que a aba Times pré-seleciona (a semana já é só principal)
      nomesPrincipal: semana.naLista.map((j) => j.nome),
    });
  });

  api.post('/jogador', (req, res) => {
    const { grupo, nome, numero } = req.body || {};
    if (!grupo || !nome?.trim()) {
      return res.status(400).json({ erro: 'grupo e nome são obrigatórios' });
    }
    res.json(db.upsertJogador(grupo, nome, numero?.trim() || null));
  });

  api.delete('/jogador/:id', (req, res) => {
    res.json({ ok: db.removerJogador(parseInt(req.params.id, 10)) });
  });

  // "Esse nome da lista é o fulano do elenco" — vale retroativo (presença,
  // notas) e daqui pra frente
  api.post('/apelido', (req, res) => {
    const { jogador_id, apelido } = req.body || {};
    if (!jogador_id || !apelido?.trim()) {
      return res.status(400).json({ erro: 'jogador_id e apelido são obrigatórios' });
    }
    const resultado = db.adicionarApelido(jogador_id, apelido);
    if (resultado.erro) return res.status(400).json(resultado);
    res.json({ ok: true });
  });

  api.delete('/apelido', (req, res) => {
    const { jogador_id, apelido } = req.query;
    db.removerApelido(parseInt(jogador_id, 10), apelido);
    res.json({ ok: true });
  });

  // Abre/fecha as inscrições de mensalista SEM anunciar no grupo — o painel é
  // a superfície silenciosa (o comando do bot avisa a galera de propósito)
  api.post('/prelista', (req, res) => {
    const { grupo, aberta } = req.body || {};
    if (!grupo) return res.status(400).json({ erro: 'grupo é obrigatório' });
    const ok = db.abrirPreLista(grupo, Boolean(aberta));
    if (!ok) return res.status(400).json({ erro: 'grupo não encontrado' });
    res.json({ aberta: Boolean(aberta) });
  });

  // Encerrar/reabrir a lista sem mandar nada no grupo
  api.post('/lista/status', (req, res) => {
    const { grupo, aberta } = req.body || {};
    if (!grupo) return res.status(400).json({ erro: 'grupo é obrigatório' });
    const lista = db.getListaMaisRecente(grupo);
    if (!lista) return res.status(400).json({ erro: 'grupo sem lista' });
    if (aberta) db.reabrirLista(lista.id); else db.encerrarLista(lista.id);
    res.json({ data_jogo: lista.data_jogo, status: aberta ? 'aberta' : 'encerrada' });
  });

  api.post('/altura', (req, res) => {
    const { jogador_id, altura } = req.body || {};
    if (!jogador_id) return res.status(400).json({ erro: 'jogador_id é obrigatório' });
    res.json(db.definirAltura(jogador_id, altura || null));
  });

  api.post('/voto', (req, res) => {
    const { jogador_id, votante, fundamento, nota } = req.body || {};
    if (!jogador_id || !votante?.trim()) {
      return res.status(400).json({ erro: 'jogador_id e votante são obrigatórios' });
    }
    const resultado = db.votarHabilidade(jogador_id, votante, fundamento, parseInt(nota, 10));
    if (resultado.erro) return res.status(400).json(resultado);
    res.json({ ok: true });
  });

  api.get('/listas', (req, res) => {
    res.json(db.listasRecentesComEntradas(req.query.grupo));
  });

  api.post('/notadia', (req, res) => {
    const { jogador_id, lista_id, nota, observacao } = req.body || {};
    if (!jogador_id || !lista_id) {
      return res.status(400).json({ erro: 'jogador_id e lista_id são obrigatórios' });
    }
    const resultado = db.darNotaDoDia(jogador_id, lista_id, parseFloat(nota), observacao?.trim() || null);
    if (resultado.erro) return res.status(400).json(resultado);
    res.json({ ok: true });
  });

  api.get('/evolucao', (req, res) => {
    res.json(db.evolucaoJogadores(req.query.grupo));
  });

  // Monta E salva na lista atual — a montagem tem que sobreviver a F5
  api.post('/times', (req, res) => {
    const { grupo, quantidade, nomes } = req.body || {};
    if (!grupo || !Array.isArray(nomes) || nomes.length === 0) {
      return res.status(400).json({ erro: 'grupo e nomes são obrigatórios' });
    }
    const n = Math.min(6, Math.max(2, parseInt(quantidade, 10) || 3));
    const participantes = nomes.map((nome) => ({ nome, numero: null }));
    const times = db.montarTimes(grupo, n, participantes);
    const lista = db.getListaMaisRecente(grupo);
    if (lista) db.salvarTimes(lista.id, times);
    res.json(times);
  });

  api.get('/times/salvos', (req, res) => {
    const lista = db.getListaMaisRecente(req.query.grupo);
    if (!lista) return res.json({ lista: null, times: [], atualizadoEm: null });
    const salvos = db.getTimesSalvos(lista.id);
    res.json({
      lista: { id: lista.id, data_jogo: lista.data_jogo, nome: lista.nome },
      times: salvos?.times || [],
      atualizadoEm: salvos?.atualizadoEm || null,
    });
  });

  // Salva a edição manual (troca de time, substituição de última hora)
  api.post('/times/salvar', (req, res) => {
    const { grupo, times } = req.body || {};
    if (!grupo || !Array.isArray(times)) {
      return res.status(400).json({ erro: 'grupo e times são obrigatórios' });
    }
    const lista = db.getListaMaisRecente(grupo);
    if (!lista) return res.status(400).json({ erro: 'grupo sem lista' });
    res.json(db.salvarTimes(lista.id, times));
  });

  api.delete('/times/salvos', (req, res) => {
    const lista = db.getListaMaisRecente(req.query.grupo);
    if (lista) db.apagarTimesSalvos(lista.id);
    res.json({ ok: true });
  });

  // Publica no grupo EXATAMENTE os times montados/ajustados na página —
  // mesmo texto do #timesde enviar: tecnologia da NASA, zero pistas do método
  api.post('/times/anunciar', async (req, res) => {
    const { grupo, dataJogo, times } = req.body || {};
    if (!deps.enviarPara) {
      return res.status(503).json({ erro: 'Envio pro grupo indisponível (bot desconectado?).' });
    }
    if (!grupo || !Array.isArray(times) || times.length === 0) {
      return res.status(400).json({ erro: 'grupo e times são obrigatórios' });
    }
    const linhas = times.map((t, i) =>
      `⚔️ *Time ${i + 1}*\n${(t.jogadores || []).map((nome) => `• ${nome}`).join('\n')}`
    );
    const anuncio = `🏐 *Times da pelada${dataJogo ? ` — ${dataJogo}` : ''}*\nMontados com tecnologia da NASA 🚀\n\n${linhas.join('\n\n')}\n\nBom jogo! 🔥`;
    try {
      await deps.enviarPara(grupo, anuncio);
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ erro: `Falha ao mandar no grupo: ${err.message}` });
    }
  });

  app.use('/api', api);
}

module.exports = { registrarPainel };
