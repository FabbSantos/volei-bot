// Rotas do painel sobre o elenco: jogadores, votação por fundamento, nota do
// dia, evolução e o montador de times.
const mensalistas = require('../mensalistas/repositorio');
const pelada = require('../pelada/repositorio');
const elenco = require('./repositorio');
const times = require('./times');
const { VOTANTES } = require('./seed');

function rotasPainel(api, deps = {}) {
  api.get('/elenco', (req, res) => {
    const grupo = req.query.grupo;
    const semana = elenco.elencoDaSemana(grupo);
    // Votantes: os da planilha + quem já votou por aqui (sem repetir)
    const votantes = [...new Set([...VOTANTES, ...elenco.listarVotantes(grupo)])]
      .sort((a, b) => a.localeCompare(b, 'pt-BR'));
    res.json({
      fundamentos: elenco.FUNDAMENTOS,
      alturas: elenco.ALTURAS,
      votantes,
      jogadores: elenco.listarJogadores(grupo),
      // A mesma lista que o #timesde usa — o painel espelha o bot
      listaAtual: semana.lista
        ? { id: semana.lista.id, data_jogo: semana.lista.data_jogo, nome: semana.lista.nome, status: semana.lista.status }
        : null,
      preListaAberta: mensalistas.resumoMensalistas(grupo).preListaAberta,
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
    res.json(elenco.upsertJogador(grupo, nome, numero?.trim() || null));
  });

  api.post('/jogador/renomear', (req, res) => {
    const { jogador_id, nome } = req.body || {};
    if (!jogador_id || !nome) return res.status(400).json({ erro: 'jogador_id e nome são obrigatórios' });
    const resultado = elenco.renomearJogador(jogador_id, nome);
    if (resultado.erro === 'nome_ocupado') return res.status(400).json({ erro: 'Já existe alguém com esse nome no elenco.' });
    if (resultado.erro) return res.status(400).json(resultado);
    res.json(resultado);
  });

  api.delete('/jogador/:id', (req, res) => {
    res.json({ ok: elenco.removerJogador(parseInt(req.params.id, 10)) });
  });

  // "Esse nome da lista é o fulano do elenco" — vale retroativo (presença,
  // notas) e daqui pra frente
  api.post('/apelido', (req, res) => {
    const { jogador_id, apelido } = req.body || {};
    if (!jogador_id || !apelido?.trim()) {
      return res.status(400).json({ erro: 'jogador_id e apelido são obrigatórios' });
    }
    const resultado = elenco.adicionarApelido(jogador_id, apelido);
    if (resultado.erro) return res.status(400).json(resultado);
    res.json({ ok: true });
  });

  api.delete('/apelido', (req, res) => {
    const { jogador_id, apelido } = req.query;
    elenco.removerApelido(parseInt(jogador_id, 10), apelido);
    res.json({ ok: true });
  });

  api.post('/altura', (req, res) => {
    const { jogador_id, altura } = req.body || {};
    if (!jogador_id) return res.status(400).json({ erro: 'jogador_id é obrigatório' });
    res.json(elenco.definirAltura(jogador_id, altura || null));
  });

  api.post('/voto', (req, res) => {
    const { jogador_id, votante, fundamento, nota } = req.body || {};
    if (!jogador_id || !votante?.trim()) {
      return res.status(400).json({ erro: 'jogador_id e votante são obrigatórios' });
    }
    const resultado = elenco.votarHabilidade(jogador_id, votante, fundamento, parseInt(nota, 10));
    if (resultado.erro) return res.status(400).json(resultado);
    res.json({ ok: true });
  });

  api.get('/listas', (req, res) => {
    res.json(elenco.listasRecentesComEntradas(req.query.grupo));
  });

  api.post('/notadia', (req, res) => {
    const { jogador_id, lista_id, nota, observacao } = req.body || {};
    if (!jogador_id || !lista_id) {
      return res.status(400).json({ erro: 'jogador_id e lista_id são obrigatórios' });
    }
    const resultado = elenco.darNotaDoDia(jogador_id, lista_id, parseFloat(nota), observacao?.trim() || null);
    if (resultado.erro) return res.status(400).json(resultado);
    res.json({ ok: true });
  });

  api.get('/evolucao', (req, res) => {
    res.json(elenco.evolucaoJogadores(req.query.grupo));
  });

  // Monta E salva na lista atual — a montagem tem que sobreviver a F5
  api.post('/times', (req, res) => {
    const { grupo, quantidade, nomes } = req.body || {};
    if (!grupo || !Array.isArray(nomes) || nomes.length === 0) {
      return res.status(400).json({ erro: 'grupo e nomes são obrigatórios' });
    }
    const n = Math.min(6, Math.max(2, parseInt(quantidade, 10) || 3));
    const participantes = nomes.map((nome) => ({ nome, numero: null }));
    const montados = times.montarTimes(grupo, n, participantes);
    const lista = pelada.getListaMaisRecente(grupo);
    if (lista) times.salvarTimes(lista.id, montados);
    res.json(montados);
  });

  api.get('/times/salvos', (req, res) => {
    const lista = pelada.getListaMaisRecente(req.query.grupo);
    if (!lista) return res.json({ lista: null, times: [], atualizadoEm: null });
    const salvos = times.getTimesSalvos(lista.id);
    res.json({
      lista: { id: lista.id, data_jogo: lista.data_jogo, nome: lista.nome },
      times: salvos?.times || [],
      atualizadoEm: salvos?.atualizadoEm || null,
    });
  });

  // Salva a edição manual (troca de time, substituição de última hora)
  api.post('/times/salvar', (req, res) => {
    const { grupo, times: editados } = req.body || {};
    if (!grupo || !Array.isArray(editados)) {
      return res.status(400).json({ erro: 'grupo e times são obrigatórios' });
    }
    const lista = pelada.getListaMaisRecente(grupo);
    if (!lista) return res.status(400).json({ erro: 'grupo sem lista' });
    res.json(times.salvarTimes(lista.id, editados));
  });

  api.delete('/times/salvos', (req, res) => {
    const lista = pelada.getListaMaisRecente(req.query.grupo);
    if (lista) times.apagarTimesSalvos(lista.id);
    res.json({ ok: true });
  });

  // Publica no grupo EXATAMENTE os times montados/ajustados na página —
  // mesmo texto do #timesde enviar: tecnologia da NASA, zero pistas do método
  api.post('/times/anunciar', async (req, res) => {
    const { grupo, dataJogo, times: montados } = req.body || {};
    if (!deps.enviarPara) {
      return res.status(503).json({ erro: 'Envio pro grupo indisponível (bot desconectado?).' });
    }
    if (!grupo || !Array.isArray(montados) || montados.length === 0) {
      return res.status(400).json({ erro: 'grupo e times são obrigatórios' });
    }
    const anuncio = times.anuncioDosTimes(dataJogo, montados.map((t) => t.jogadores || []));
    try {
      await deps.enviarPara(grupo, anuncio);
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ erro: `Falha ao mandar no grupo: ${err.message}` });
    }
  });
}

module.exports = { rotasPainel };
