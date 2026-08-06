const path = require('path');
const express = require('express');
const db = require('./db');

// Painel web dos admins: elenco, votação de habilidade por fundamento, nota
// do dia, montador de times e gráficos de evolução. Protegido por token
// secreto (PAINEL_TOKEN no host) — sem token configurado, fica desligado.
function registrarPainel(app) {
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
    res.json({ fundamentos: db.FUNDAMENTOS, jogadores: db.listarJogadores(req.query.grupo) });
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

  api.post('/times', (req, res) => {
    const { grupo, quantidade, nomes } = req.body || {};
    if (!grupo || !Array.isArray(nomes) || nomes.length === 0) {
      return res.status(400).json({ erro: 'grupo e nomes são obrigatórios' });
    }
    const n = Math.min(6, Math.max(2, parseInt(quantidade, 10) || 3));
    const participantes = nomes.map((nome) => ({ nome, numero: null }));
    res.json(db.montarTimes(grupo, n, participantes));
  });

  app.use('/api', api);
}

module.exports = { registrarPainel };
