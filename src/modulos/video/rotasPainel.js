// Rotas do painel pro vídeo: subir o vídeo do jogo (do celular mesmo, em
// casa), acompanhar e baixar os cortes.
//
// O upload vai em pedaços de alguns MB, cada um dizendo em que byte começa.
// Um vídeo de jogo tem 5 GB: se o wi-fi cair no meio, o navegador pergunta
// "quanto já chegou?" e continua dali, em vez de recomeçar do zero.
const fs = require('fs');
const path = require('path');
const express = require('express');
const repo = require('./repositorio');
const grupos = require('../grupos/repositorio');
const { lerConfig } = require('./config');
const { processarVideo } = require('./processador');

const ID_VALIDO = /^[A-Za-z0-9._-]{1,160}$/;
const MAX_PEDACO_MB = 32;

// Pasta dos uploads em andamento: do lado da pasta de gravações, no mesmo
// disco — mover pro lugar final é instantâneo
const pastaDeEntrada = (cfg) => path.join(path.dirname(cfg.pasta), 'entrada');

// Nome seguro, mas sem perder a hora que o celular pôs no nome do arquivo
const nomeSeguro = (nome) => path.basename(String(nome || 'video.mp4')).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);

function espacoLivre(pasta) {
  try {
    const s = fs.statfsSync(pasta);
    return s.bavail * s.bsize;
  } catch {
    return Infinity; // sem como medir: deixa tentar
  }
}

function rotasPainel(api, deps = {}, { cfg = lerConfig(), processar = processarVideo } = {}) {
  const entrada = pastaDeEntrada(cfg);
  const parcial = (id) => path.join(entrada, `${id}.parcial`);
  const recebido = (id) => { try { return fs.statSync(parcial(id)).size; } catch { return 0; } };

  const canal = {
    enviarTexto: (chatId, texto) => deps.enviarPara(chatId, texto),
    enviarArquivo: (chatId, caminho, legenda) => deps.enviarArquivoPara(chatId, caminho, legenda),
    gruposAdmin: () => grupos.listarGruposAdmin(),
  };

  const validarId = (req, res, next) => (ID_VALIDO.test(req.params.id)
    ? next()
    : res.status(400).json({ erro: 'identificador de envio inválido' }));

  // Quanto já chegou. No começo, confere se cabe: o vídeo fica no disco duas
  // vezes durante a importação (o original e os pedaços)
  api.get('/video/envio/:id', validarId, (req, res) => {
    fs.mkdirSync(entrada, { recursive: true });
    const jaTem = recebido(req.params.id);
    const tamanho = Number(req.query.tamanho) || 0;
    const precisa = (tamanho - jaTem) + tamanho + 2 * 1024 ** 3; // + 2 GB de folga pro bot
    if (tamanho && espacoLivre(entrada) < precisa) {
      return res.status(507).json({ erro: 'Sem espaço no servidor pra esse vídeo agora.' });
    }
    res.json({ recebido: jaTem });
  });

  api.put('/video/envio/:id', validarId,
    express.raw({ type: () => true, limit: `${MAX_PEDACO_MB}mb` }),
    async (req, res) => {
      const deOnde = Number(req.get('x-offset'));
      const jaTem = recebido(req.params.id);
      // Pedaço fora de ordem (repetido depois de uma queda, por exemplo):
      // não grava, só diz onde parou
      if (deOnde !== jaTem) return res.status(409).json({ recebido: jaTem });
      try {
        fs.mkdirSync(entrada, { recursive: true });
        await fs.promises.appendFile(parcial(req.params.id), req.body);
      } catch (err) {
        return res.status(500).json({ erro: `não consegui gravar: ${err.message}`, recebido: recebido(req.params.id) });
      }
      res.json({ recebido: recebido(req.params.id) });
    });

  api.post('/video/envio/:id/concluir', validarId, (req, res) => {
    const tamanho = Number(req.body?.tamanho);
    const jaTem = recebido(req.params.id);
    if (!tamanho || jaTem !== tamanho) {
      return res.status(409).json({ erro: `chegaram ${jaTem} de ${tamanho} bytes`, recebido: jaTem });
    }
    const nome = nomeSeguro(req.body?.nome);
    // Pasta por envio: dois vídeos com o mesmo nome não se atropelam, e o
    // nome original (que tem a hora do celular) fica intacto
    const destino = path.join(entrada, `${req.params.id}.pronto`, nome);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.renameSync(parcial(req.params.id), destino);

    const video = repo.registrarVideo({ nome, tamanho });
    processar(video.id, destino, canal).finally(() => {
      fs.rmSync(path.dirname(destino), { recursive: true, force: true });
    });
    res.json({ video });
  });

  api.get('/video/estado', (req, res) => {
    const videos = repo.listarVideos(10).map((v) => ({ ...v, replays: repo.replaysDoVideo(v.id) }));
    res.json({ videos, pendentes: repo.listarReplaysPendentes() });
  });

  // Download de um corte (o link que o bot manda quando o arquivo é grande
  // demais pro WhatsApp)
  api.get('/video/corte/:nome', (req, res) => {
    const nome = path.basename(req.params.nome);
    const caminho = path.join(cfg.pasta, 'cortes', nome);
    if (!/\.mp4$/i.test(nome) || !fs.existsSync(caminho)) return res.status(404).json({ erro: 'corte não encontrado' });
    res.download(caminho, nome);
  });
}

module.exports = { rotasPainel, nomeSeguro };
