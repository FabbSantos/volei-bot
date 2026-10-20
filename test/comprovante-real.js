// O leitor com o Claude DE VERDADE: gera a imagem de um comprovante de Pix
// (e uma imagem que não é comprovante) e confere o que volta. Custa uma
// fração de centavo; só roda com ANTHROPIC_API_KEY e ffmpeg — sem eles, pula.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { lerComprovante, MODELO } = require('../src/modulos/comprovantes/leitor');
const { recebedorConfere } = require('../src/modulos/comprovantes/decisor');

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const FONTES = ['/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', 'C:/Windows/Fonts/arial.ttf'];

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

const RECIBO = `Comprovante de transferencia
Pix enviado

Valor
R$ 24,00

Data e hora
09/10/2026 - 20:31:12

Origem
Nome: Thiago Rodrigues Souza
Instituicao: Nubank

Destino
Nome: Marcel Garcia Von Rondon
Chave Pix: (21) 9****-1234
Instituicao: Banco Inter

ID da transacao
E18236120202610092331s0123abc45`;

async function principal() {
  const fonte = FONTES.find((f) => fs.existsSync(f));
  if (!process.env.ANTHROPIC_API_KEY || !fonte || spawnSync(ffmpeg, ['-version']).status !== 0) {
    console.log('\n⚠️  sem ANTHROPIC_API_KEY, fonte ou ffmpeg — teste do leitor de verdade pulado');
    return;
  }
  console.log(`\nleitor de comprovante com o Claude de verdade (${MODELO})`);
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'volei-recibo-'));
  try {
    // textfile/fontfile relativos à pasta: caminho com "C:" quebraria o filtro
    fs.writeFileSync(path.join(pasta, 'recibo.txt'), RECIBO);
    fs.copyFileSync(fonte, path.join(pasta, 'fonte.ttf'));
    const gerar = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=white:s=720x1000', '-frames:v', '1',
      '-vf', 'drawtext=textfile=recibo.txt:fontfile=fonte.ttf:fontsize=30:fontcolor=black:x=40:y=40:line_spacing=10',
      'recibo.png'], { cwd: pasta, encoding: 'utf8' });
    if (gerar.status !== 0) throw new Error(`não gerou a imagem: ${gerar.stderr}`);
    spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=640x480',
      '-frames:v', '1', 'outra.png'], { cwd: pasta });

    const lido = await lerComprovante({
      arquivo: fs.readFileSync(path.join(pasta, 'recibo.png')), mimetype: 'image/png',
      legenda: 'eu e a Duda', nomesDaLista: ['Thiago Rodrigues', 'Duda', 'Ryan'],
    });
    caso('é comprovante de Pix concluído', () => {
      assert.strictEqual(lido.eh_comprovante_pix, true);
      assert.strictEqual(lido.situacao, 'concluido');
    });
    caso(`valor R$ 24,00 (${lido.valor_centavos})`, () => assert.strictEqual(lido.valor_centavos, 2400));
    caso(`data e hora (${lido.data_hora})`, () => assert.match(lido.data_hora || '', /^2026-10-09T20:31/));
    caso(`recebedor confere (${lido.recebedor_nome})`, () => assert.ok(recebedorConfere(lido.recebedor_nome, 'Marcel Garcia Von Rondon')));
    caso(`id da transação (${lido.id_transacao})`, () => assert.match(lido.id_transacao || '', /E18236120202610092331s0123abc45/i));
    caso(`legenda "eu e a Duda" (${JSON.stringify(lido.legenda_para)}, inclui remetente: ${lido.legenda_inclui_remetente})`, () => {
      assert.deepStrictEqual(lido.legenda_para, ['Duda']);
      assert.strictEqual(lido.legenda_inclui_remetente, true);
    });

    const outra = await lerComprovante({
      arquivo: fs.readFileSync(path.join(pasta, 'outra.png')), mimetype: 'image/png', legenda: 'kkkk', nomesDaLista: ['Ryan'],
    });
    caso('imagem que não é comprovante: eh_comprovante_pix false', () => assert.strictEqual(outra.eh_comprovante_pix, false));
  } finally {
    fs.rmSync(pasta, { recursive: true, force: true });
  }
}

principal()
  .catch((err) => {
    falhas++;
    console.log(`  FALHOU  ${err.stack}`);
  })
  .finally(() => {
    console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo ok');
    process.exit(falhas ? 1 : 0);
  });
