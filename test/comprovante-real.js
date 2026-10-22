// O leitor com o Claude DE VERDADE: gera a imagem de um comprovante de Pix
// (e uma imagem que não é comprovante) e confere o que volta. Custa uma
// fração de centavo; só roda com ANTHROPIC_API_KEY e ffmpeg — sem eles, pula.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { lerComprovante, entenderResposta, escreverFrase, MODELO } = require('../src/modulos/comprovantes/leitor');
const { fraseValida } = require('../src/modulos/comprovantes/frases');
const { recebedorConfere, falaDoRemetente } = require('../src/modulos/comprovantes/decisor');

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const FONTES = ['/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', 'C:/Windows/Fonts/arial.ttf'];

let falhas = 0;
// Interpretação do modelo: registra, mas não falha a suíte
function observa(nome, ok) {
  console.log(`  ${ok ? 'ok' : 'AVISO'}  ${nome}`);
}

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

// Um agendamento de hoje mesmo (a data não denuncia: só a situação)
const AGENDADO = `Pix agendado
Agendamento realizado com sucesso

Valor
R$ 12,00

Data agendada
21/10/2026

Destino
Nome: Marcel Garcia Von Rondon
Chave Pix: mgarciavr@gmail.com
Instituicao: Mercado Pago

Origem
Nome: Thiago Rodrigues Souza
Instituicao: Nubank

Codigo do agendamento
AGD8812736450091`;

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
    fs.writeFileSync(path.join(pasta, 'agendado.txt'), AGENDADO);
    spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=white:s=720x1000', '-frames:v', '1',
      '-vf', 'drawtext=textfile=agendado.txt:fontfile=fonte.ttf:fontsize=30:fontcolor=black:x=40:y=40:line_spacing=10',
      'agendado.png'], { cwd: pasta });
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
    caso(`e o título não fala em agendamento (${lido.titulo})`, () => assert.ok(!/agend|program|recorr/i.test(lido.titulo || '')));
    caso(`valor R$ 24,00 (${lido.valor_centavos})`, () => assert.strictEqual(lido.valor_centavos, 2400));

    // Agendamento NÃO vale: tem que ser transferência que já saiu
    const agendado = await lerComprovante({
      arquivo: fs.readFileSync(path.join(pasta, 'agendado.png')), mimetype: 'image/png',
      legenda: '', nomesDaLista: ['Thiago Rodrigues', 'Duda'],
    });
    caso(`Pix agendado é reconhecido (situação: ${agendado.situacao}, título: ${agendado.titulo})`, () =>
      assert.ok(agendado.situacao === 'agendado' || /agend|program|recorr/i.test(agendado.titulo || '')));
    caso(`data e hora (${lido.data_hora})`, () => assert.match(lido.data_hora || '', /^2026-10-09T20:31/));
    caso(`recebedor confere (${lido.recebedor_nome})`, () => assert.ok(recebedorConfere(lido.recebedor_nome, 'Marcel Garcia Von Rondon')));
    caso(`id da transação (${lido.id_transacao})`, () => assert.match(lido.id_transacao || '', /E18236120202610092331s0123abc45/i));
    caso(`legenda "eu e a Duda" (${JSON.stringify(lido.legenda_para)}, inclui remetente: ${lido.legenda_inclui_remetente})`, () => {
      assert.deepStrictEqual(lido.legenda_para, ['Duda']);
      assert.strictEqual(lido.legenda_inclui_remetente, true);
    });

    // Thiago pagando separado: "é meu" num, "da Duda" no outro
    const meu = await lerComprovante({
      arquivo: fs.readFileSync(path.join(pasta, 'recibo.png')), mimetype: 'image/png',
      legenda: 'é meu', nomesDaLista: ['Thiago Rodrigues', 'Duda', 'Ryan'],
    });
    // O Claude oscila nesse campo (20/10/2026: certo numa rodada, errado na
    // seguinte) — o bot completa com a regra fixa. O que importa é a soma
    const peloBot = falaDoRemetente('é meu', meu.legenda_para.length > 0);
    caso(`legenda "é meu" = quem enviou, sem mais ninguém (nomes ${JSON.stringify(meu.legenda_para)}, Claude: ${meu.legenda_inclui_remetente}, regra fixa: ${peloBot})`, () => {
      // O Claude às vezes também põe o próprio Thiago (o pagador) nos citados:
      // dá no mesmo. O que não pode é aparecer outra pessoa (a Duda)
      assert.ok(meu.legenda_para.every((n) => n === 'Thiago Rodrigues'), `citou ${meu.legenda_para}`);
      assert.strictEqual(meu.legenda_inclui_remetente || peloBot, true);
    });
    const daDuda = await lerComprovante({
      arquivo: fs.readFileSync(path.join(pasta, 'recibo.png')), mimetype: 'image/png',
      legenda: 'esse é o da duda', nomesDaLista: ['Thiago Rodrigues', 'Duda', 'Ryan'],
    });
    caso(`legenda "esse é o da duda" = só a Duda (${JSON.stringify(daDuda.legenda_para)}, inclui remetente: ${daDuda.legenda_inclui_remetente})`, () => {
      assert.deepStrictEqual(daDuda.legenda_para, ['Duda']);
      assert.strictEqual(daDuda.legenda_inclui_remetente, false);
    });

    // Interpretação (oscila de rodada pra rodada): aviso, não trava o deploy —
    // o bot tem rede de segurança (pergunta de novo / admin)
    const daLeticia = await lerComprovante({
      arquivo: fs.readFileSync(path.join(pasta, 'recibo.png')), mimetype: 'image/png',
      legenda: 'esse é da Letícia', nomesDaLista: ['Thiago Rodrigues', 'Fontella ✠ (também chamado: Letícia Fontella)', 'Ryan'],
    });
    observa(`legenda "esse é da Letícia" com a lista mostrando "Fontella ✠ (também chamado: Letícia Fontella)" (${JSON.stringify(daLeticia.legenda_para)})`,
      daLeticia.legenda_para.length === 1 && /fontella/i.test(daLeticia.legenda_para[0]));
    const doVini = await lerComprovante({
      arquivo: fs.readFileSync(path.join(pasta, 'recibo.png')), mimetype: 'image/png', legenda: 'thiago',
      nomesDaLista: ['Thiago Rodrigues', 'Thiago Prata (cvd Vini)', 'Vinicius Pavani (também chamado: Vini)'],
      remetente: 'Vinicius Pavani / Vini',
    });
    observa(`legenda "thiago" enviada pelo Vini, com dois Thiagos (${JSON.stringify(doVini.legenda_para)})`,
      // "Thiago Prata" sem o parêntese é a mesma pessoa (o bot compara sem ele)
      JSON.stringify(doVini.legenda_para.map((n) => n.replace(/\s*\(.*\)\s*$/, ''))) === '["Thiago Prata"]' || doVini.legenda_para.length === 0);
    const filha = await entenderResposta({
      texto: 'minha filha', remetente: 'Thiago Rodrigues',
      nomesDaLista: ['Thiago Rodrigues', 'Duda', 'Ryan'], sugeridos: ['Thiago Rodrigues', 'Duda'],
    });
    observa(`resposta "minha filha" do Thiago (que paga a Duda) → ${JSON.stringify(filha)}`,
      JSON.stringify(filha.nomes) === '["Duda"]' && !filha.inclui_quem_enviou);
    const conversa = await entenderResposta({
      texto: 'bora jogar hoje', remetente: 'Thiago Rodrigues',
      nomesDaLista: ['Thiago Rodrigues', 'Duda', 'Ryan'], sugeridos: ['Thiago Rodrigues', 'Duda'],
    });
    observa(`conversa "bora jogar hoje" não aponta ninguém → ${JSON.stringify(conversa)}`,
      conversa.nomes.length === 0 && !conversa.inclui_quem_enviou);

    // A frase do anúncio: aviso (é texto criativo), e mostra o que saiu
    for (const [quem, tema] of [['Kamila', 'novela das nove'], ['Thiago e Duda', 'narração de jogo de vôlei'], ['Ryan', 'previsão do tempo'], ['DiegoB', 'agiota aliviado']]) {
      const frase = await escreverFrase({ quem, tema });
      observa(`frase pra ${quem} (${tema}): ${frase}`, Boolean(fraseValida(frase)));
    }

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
