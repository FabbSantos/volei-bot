// Importar e cortar vídeo, num processo à parte. Dois motivos:
//   1. Fuso: os pedaços têm no nome a hora LOCAL (o celular grava "21h13" no
//      nome do arquivo), e o container do bot roda em UTC. Aqui dentro o TZ é
//      o de Brasília, e todo o código de vídeo — o mesmo do PC — funciona sem
//      saber que existe fuso.
//   2. Um ffmpeg ou um arquivo esquisito que derrube isto aqui não derruba o
//      bot do WhatsApp.
//
// Conversa por IPC: recebe { acao, ... } e responde { ok, resultado | erro }.
// Horários sempre em milissegundos (número), nunca Date.
const path = require('path');
const { fork } = require('child_process');

const FUSO = process.env.VIDEO_FUSO || 'America/Sao_Paulo';

// ---- lado do bot: roda um pedido num processo novo e espera a resposta
function trabalhar(pedido) {
  return new Promise((resolve, reject) => {
    const filho = fork(__filename, [], { env: { ...process.env, TZ: FUSO }, stdio: 'inherit' });
    let respondeu = false;
    filho.on('message', (r) => {
      respondeu = true;
      if (r.ok) resolve(r.resultado);
      else reject(new Error(r.erro));
      filho.disconnect();
    });
    filho.on('error', reject);
    filho.on('exit', (codigo) => {
      if (!respondeu) reject(new Error(`o processo de vídeo morreu (código ${codigo})`));
    });
    filho.send(pedido);
  });
}

// ---- lado do processo filho
async function executar(pedido) {
  const { lerConfig } = require('./config');
  const cfg = lerConfig();

  if (pedido.acao === 'importar') {
    const { importar } = require('./importador');
    const r = await importar(cfg, pedido.arquivo);
    return {
      pedacos: r.pedacos, inicio: r.inicio.getTime(), fim: r.fim.getTime(),
      fonte: r.fonte, aviso: r.aviso, rotacao: r.rotacao,
    };
  }

  if (pedido.acao === 'cortar') {
    const { cortar } = require('./cortador');
    const r = await cortar(cfg, new Date(pedido.inicio), new Date(pedido.fim));
    if (r.erro) return { erro: r.erro };
    // Nome com a hora do replay: dois replays no mesmo minuto não se sobrescrevem
    const destino = path.join(path.dirname(r.arquivo), pedido.nome);
    require('fs').renameSync(r.arquivo, destino);
    return { arquivo: destino, segundos: r.segundos, inicio: r.inicio.getTime(), fim: r.fim.getTime() };
  }

  throw new Error(`ação desconhecida: ${pedido.acao}`);
}

if (require.main === module) {
  process.on('message', async (pedido) => {
    try {
      process.send({ ok: true, resultado: await executar(pedido) });
    } catch (err) {
      process.send({ ok: false, erro: err.message });
    }
  });
}

module.exports = { trabalhar };
