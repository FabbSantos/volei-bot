// Vigia da pasta do Drive contra um "Google de mentira" local: confere a
// assinatura do JWT da conta de serviço, lista a pasta, serve o arquivo com
// Range e derruba a conexão no meio do primeiro download (a retomada tem que
// continuar de onde parou). O processamento do vídeo em si é do test/replay.js.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'volei-drive-'));
process.env.DB_PATH = path.join(pasta, 'teste.db');
process.env.VIDEO_PASTA = path.join(pasta, 'videos', 'gravacoes');

const express = require('express');
const repo = require('../src/modulos/video/repositorio');
const { criarDrive, idDaPasta } = require('../src/modulos/video/drive');
const { criarVigia } = require('../src/modulos/video/vigiaDrive');
const { lerConfig } = require('../src/modulos/video/config');
const { fecharBanco } = require('../src/nucleo/banco');

let falhas = 0;
function caso(nome, fn) {
  try {
    fn();
    console.log(`  ok  ${nome}`);
  } catch (err) {
    falhas++;
    console.log(`  FALHOU  ${nome}\n          ${err.message}`);
  }
}

const PASTA_ID = '1AbCdEfGhIjKlMnOpQrStUv';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const conteudo = crypto.randomBytes(3 * 1024 * 1024 + 123);
const ARQUIVO = { id: 'arq1', name: 'VID20260925211316.mp4', size: String(conteudo.length), mimeType: 'video/mp4', createdTime: '2026-09-26T15:00:00Z' };

function googleDeMentira() {
  const app = express();
  const registro = { tokens: 0, jwtValido: null, consultas: [], ranges: [], downloads: 0, derrubar: true, listarFalha: null };
  const TOKEN = 'token-do-google';

  app.post('/token', express.urlencoded({ extended: false }), (req, res) => {
    const [cab, corpo, assinatura] = String(req.body.assertion || '').split('.');
    const valido = crypto.verify('RSA-SHA256', Buffer.from(`${cab}.${corpo}`), publicKey, Buffer.from(assinatura, 'base64url'));
    const claims = JSON.parse(Buffer.from(corpo, 'base64url').toString());
    registro.jwtValido = valido && claims.iss === 'bot@teste.iam.gserviceaccount.com'
      && claims.scope === 'https://www.googleapis.com/auth/drive.readonly' && claims.exp > claims.iat;
    registro.tokens++;
    if (!registro.jwtValido) return res.status(400).json({ error: 'invalid_grant' });
    res.json({ access_token: TOKEN, expires_in: 3600 });
  });

  const autorizado = (req, res, next) => (req.get('authorization') === `Bearer ${TOKEN}`
    ? next() : res.status(401).json({ error: { message: 'sem token' } }));

  app.get('/drive/v3/files', autorizado, (req, res) => {
    registro.consultas.push(req.query.q);
    if (registro.listarFalha) return res.status(403).json({ error: { message: registro.listarFalha } });
    const naPasta = req.query.q.includes(`'${PASTA_ID}' in parents`);
    res.json({ files: naPasta ? [ARQUIVO] : [] });
  });

  app.get('/drive/v3/files/:id', autorizado, (req, res) => {
    registro.downloads++;
    const range = req.get('range');
    registro.ranges.push(range || null);
    const inicio = range ? Number(range.match(/bytes=(\d+)-/)[1]) : 0;
    res.status(range ? 206 : 200);
    res.setHeader('content-length', conteudo.length - inicio);
    if (registro.derrubar) {
      // Manda um terço e derruba: o wi-fi da VPS não cai, mas o Google cai
      registro.derrubar = false;
      res.write(conteudo.subarray(inicio, inicio + 1024 * 1024), () => res.socket.destroy());
      return;
    }
    res.end(conteudo.subarray(inicio));
  });

  return { app, registro };
}

async function principal() {
  console.log('\nvigia da pasta do Drive (Google de mentira)');

  caso('link da pasta vira id', () => {
    assert.strictEqual(idDaPasta(`https://drive.google.com/drive/folders/${PASTA_ID}?usp=sharing`), PASTA_ID);
    assert.strictEqual(idDaPasta(`https://drive.google.com/drive/u/0/folders/${PASTA_ID}`), PASTA_ID);
    assert.strictEqual(idDaPasta(PASTA_ID), PASTA_ID);
    assert.strictEqual(idDaPasta(''), null);
    assert.strictEqual(idDaPasta('qualquer coisa'), null);
  });

  const { app, registro } = googleDeMentira();
  const servidor = app.listen(0);
  const base = `http://127.0.0.1:${servidor.address().port}`;

  try {
    const drive = criarDrive({
      credenciais: {
        client_email: 'bot@teste.iam.gserviceaccount.com',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        token_uri: `${base}/token`,
      },
      api: base,
    });

    const textos = [];
    const processados = [];
    const canal = {
      enviarTexto: async (chatId, texto) => { textos.push(texto); },
      enviarArquivo: async () => {},
      gruposAdmin: () => ['adm@g.us'],
    };
    const vigia = criarVigia({
      drive, pastaId: PASTA_ID, canal, cfg: lerConfig(),
      processar: async (videoId, arquivo, _canal, opcoes) => {
        processados.push({ videoId, arquivo, bytes: fs.readFileSync(arquivo), opcoes, status: repo.getVideo(videoId).status });
        repo.marcarVideo(videoId, { status: 'pronto' });
      },
    });

    // 1ª volta: o Google derruba no meio do download
    await vigia.verificar();
    caso('a chave assina um JWT que o Google aceita (só leitura)', () => assert.strictEqual(registro.jwtValido, true));
    caso('olha só vídeos da pasta certa, fora da lixeira', () =>
      assert.match(registro.consultas[0], new RegExp(`'${PASTA_ID}' in parents and trashed = false and mimeType contains 'video/'`)));
    caso('avisa o grupo de admins que o vídeo chegou', () => assert.match(textos[0] || '', /Chegou VID20260925211316\.mp4 \(3 MB\)/));
    caso('com o download interrompido, não processa nada', () => assert.strictEqual(processados.length, 0));
    caso('e avisa da falha uma vez', () => assert.ok(textos.some((t) => /download .* falhou/.test(t)), JSON.stringify(textos)));
    caso('e não deixa o vídeo marcado como "já visto"', () => assert.strictEqual(repo.videoDoDrive('arq1'), undefined));

    // 2ª volta: continua de onde parou
    await vigia.verificar();
    // A partir do que ficou no disco — até 1 MB, que é o que o Google mandou
    // antes de cair (parte pode ter se perdido no caminho)
    caso(`a 2ª tentativa pede só o que faltou (${registro.ranges[1]})`, () => {
      const deOnde = Number((registro.ranges[1] || '').match(/^bytes=(\d+)-$/)?.[1]);
      assert.ok(deOnde > 0 && deOnde <= 1024 * 1024);
    });
    caso('o arquivo chega inteiro e igual ao do Drive', () => {
      assert.strictEqual(processados.length, 1);
      assert.ok(processados[0].bytes.equals(conteudo));
    });
    caso('com o nome original, que tem a hora do celular', () =>
      assert.strictEqual(path.basename(processados[0].arquivo), 'VID20260925211316.mp4'));
    caso('o vídeo passa de "baixando" pra "processando" antes de cortar', () => assert.strictEqual(processados[0].status, 'processando'));
    caso('e o resumo lembra de apagar do Drive', () => assert.match(processados[0].opcoes.rodape, /apagar o vídeo do Drive/));
    caso('não avisa de novo que o vídeo chegou', () => assert.strictEqual(textos.filter((t) => /Chegou/.test(t)).length, 1));
    caso('a pasta do download é limpa depois', () =>
      assert.deepStrictEqual(fs.readdirSync(path.join(pasta, 'videos', 'entrada')), []));

    // 3ª volta: o mesmo arquivo continua na pasta do Drive
    await vigia.verificar();
    caso('o mesmo arquivo não é baixado nem cortado de novo', () => {
      assert.strictEqual(processados.length, 1);
      assert.strictEqual(registro.downloads, 2);
    });
    caso('o token é reaproveitado entre as voltas', () => assert.strictEqual(registro.tokens, 1));

    // Pasta que parou de ser compartilhada: avisa uma vez, não a cada 5 min
    registro.listarFalha = 'The user does not have sufficient permissions';
    const antes = textos.length;
    await vigia.verificar();
    await vigia.verificar();
    caso('pasta inacessível avisa os admins uma vez só', () => {
      const novos = textos.slice(antes);
      assert.strictEqual(novos.length, 1, JSON.stringify(novos));
      assert.match(novos[0], /Não consegui olhar a pasta/);
    });

    // Bot reiniciou no meio: o que estava baixando volta pra fila
    const preso = repo.registrarVideo({ nome: 'x.mp4', tamanho: 1, driveId: 'arq2', status: 'baixando' });
    const doPainel = repo.registrarVideo({ nome: 'y.mp4', tamanho: 1 });
    repo.limparInterrompidos();
    caso('no boot, vídeo do Drive interrompido volta pra vigia pegar', () => assert.strictEqual(repo.getVideo(preso.id), undefined));
    caso('e o do painel vira erro (o original pode já ter sumido)', () => assert.strictEqual(repo.getVideo(doPainel.id).status, 'erro'));
  } finally {
    servidor.close();
  }
}

principal()
  .catch((err) => {
    falhas++;
    console.log(`  FALHOU  ${err.stack}`);
  })
  .finally(() => {
    fecharBanco();
    fs.rmSync(pasta, { recursive: true, force: true });
    console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo ok');
    process.exit(falhas ? 1 : 0);
  });
