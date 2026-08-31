const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const db = require('./db');

// Tela de entrada do painel: senha única, sem usuário — os admins sabem qual é.
function paginaDeEntrada(aviso = '') {
  return `<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Painel do vôlei</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#12181c; color:#e8edec;
         font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  form { background:#1a2429; border:1px solid #26363d; border-radius:10px;
         padding:2rem 1.75rem; width:min(20rem, 90vw);
         display:flex; flex-direction:column; gap:1rem; }
  h1 { margin:0; font-size:1.15rem; font-weight:600; }
  p { margin:0; color:#93a7ae; font-size:.9rem; }
  input { padding:.7rem .8rem; font-size:1rem; border-radius:6px;
          border:1px solid #2f434b; background:#111a1e; color:inherit; }
  input:focus { outline:2px solid #e5a249; outline-offset:1px; }
  button { padding:.7rem; font-size:1rem; font-weight:600; border:0;
           border-radius:6px; background:#e5a249; color:#12181c; cursor:pointer; }
  .aviso { color:#e8785e; font-size:.9rem; }
</style></head>
<body>
  <form method="post" action="/painel/entrar">
    <h1>🏐 Painel do vôlei</h1>
    <p>Senha dos admins.</p>
    ${aviso ? `<p class="aviso">${aviso}</p>` : ''}
    <input type="password" name="senha" placeholder="senha" autofocus
           autocomplete="current-password" required>
    <button type="submit">Entrar</button>
  </form>
</body></html>`;
}

// Painel web dos admins: elenco, votação de habilidade por fundamento, nota
// do dia, montador de times e gráficos de evolução. Protegido por token
// secreto (PAINEL_TOKEN no host) — sem token configurado, fica desligado.
function registrarPainel(app, deps = {}) {
  const TOKEN = process.env.PAINEL_TOKEN;
  const SENHA = process.env.PAINEL_SENHA || '';
  const COOKIE = 'painel';

  // Valor do cookie: assinatura derivada do PAINEL_TOKEN. Não dá pra forjar
  // sem conhecer o token, e trocar o token invalida todos os logins de uma vez.
  const assinatura = () => crypto.createHmac('sha256', String(TOKEN || '')).update('painel-v1').digest('hex');

  const iguais = (a, b) => {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    // Comparação de tempo constante não aceita tamanhos diferentes
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };

  const lerCookie = (req, nome) => {
    const bruto = req.headers.cookie || '';
    for (const parte of bruto.split(';')) {
      const [chave, ...resto] = parte.trim().split('=');
      if (chave === nome) return resto.join('=');
    }
    return null;
  };

  // Duas portas: o cookie (navegador, depois de entrar com a senha) e o token
  // (scripts, curl do backup, links antigos que já estão salvos por aí).
  const autenticado = (req) => {
    if (!TOKEN) return false;
    if (iguais(lerCookie(req, COOKIE), assinatura())) return true;
    return iguais(req.query.token || req.get('x-painel-token'), TOKEN);
  };

  // Trava simples de força bruta: senha curta e compartilhada em endereço
  // público pede pelo menos isso. Reinicia com o processo, e tudo bem.
  const tentativas = new Map(); // ip -> { erros, ate }
  const JANELA_MS = 15 * 60_000;
  const MAX_ERROS = 8;

  const bloqueado = (ip) => {
    const reg = tentativas.get(ip);
    if (!reg) return false;
    if (Date.now() > reg.ate) { tentativas.delete(ip); return false; }
    return reg.erros >= MAX_ERROS;
  };

  const registrarErro = (ip) => {
    const reg = tentativas.get(ip) || { erros: 0, ate: Date.now() + JANELA_MS };
    reg.erros++;
    tentativas.set(ip, reg);
  };

  const exigirToken = (req, res, next) => {
    if (!TOKEN) {
      return res.status(503).json({ erro: 'Painel desligado — configure PAINEL_TOKEN no host.' });
    }
    if (!autenticado(req)) {
      return res.status(401).json({ erro: 'Não autenticado. Abre /painel e entra com a senha.' });
    }
    next();
  };

  app.get('/painel', (req, res) => {
    if (!TOKEN) {
      return res.status(503).send('Painel desligado — configure PAINEL_TOKEN no host.');
    }
    if (!autenticado(req)) {
      return res.status(401).send(paginaDeEntrada());
    }
    // Entrou por link com token? Grava o cookie e limpa a URL, pra o endereço
    // parar de carregar o segredo e poder ser salvo nos favoritos.
    if (!lerCookie(req, COOKIE) && req.query.token) {
      gravarCookie(res);
      return res.redirect('/painel');
    }
    res.sendFile(path.join(__dirname, '..', 'public', 'painel.html'));
  });

  function gravarCookie(res) {
    res.cookie(COOKIE, assinatura(), {
      httpOnly: true,
      sameSite: 'lax',
      secure: true, // o painel só existe atrás do HTTPS do nginx
      maxAge: 180 * 24 * 60 * 60 * 1000,
    });
  }

  app.post('/painel/entrar', express.urlencoded({ extended: false }), (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'desconhecido';
    if (!SENHA) {
      return res.status(503).send(paginaDeEntrada('Nenhuma senha configurada no host (PAINEL_SENHA).'));
    }
    if (bloqueado(ip)) {
      return res.status(429).send(paginaDeEntrada('Muita tentativa errada. Espera uns minutos.'));
    }
    if (!iguais((req.body?.senha || '').trim(), SENHA)) {
      registrarErro(ip);
      return res.status(401).send(paginaDeEntrada('Senha errada.'));
    }
    tentativas.delete(ip);
    gravarCookie(res);
    res.redirect('/painel');
  });

  app.post('/painel/sair', (req, res) => {
    res.clearCookie(COOKIE);
    res.redirect('/painel');
  });

  // Chart.js servido localmente — nada de CDN
  app.get('/painel/chart.js', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.js'));
  });

  // Download do banco inteiro, pra backup e pra migrar de host. Fica fora do
  // router /api porque devolve arquivo, não JSON — mas exige o mesmo token.
  app.get('/backup', exigirToken, (req, res) => {
    const destino = path.join(os.tmpdir(), `volei-backup-${process.pid}.db`);
    try {
      db.snapshotBanco(destino);
    } catch (err) {
      return res.status(500).json({ erro: `Não consegui gerar o backup: ${err.message}` });
    }
    res.download(destino, 'volei.db', () => {
      try { fs.rmSync(destino, { force: true }); } catch {}
    });
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

  api.post('/jogador/renomear', (req, res) => {
    const { jogador_id, nome } = req.body || {};
    if (!jogador_id || !nome) return res.status(400).json({ erro: 'jogador_id e nome são obrigatórios' });
    const resultado = db.renomearJogador(jogador_id, nome);
    if (resultado.erro === 'nome_ocupado') return res.status(400).json({ erro: 'Já existe alguém com esse nome no elenco.' });
    if (resultado.erro) return res.status(400).json(resultado);
    res.json(resultado);
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
