// Linha de comando do vídeo — roda na máquina que tem a câmera, separado do
// bot do WhatsApp (que mora na VPS).
//
//   npm run gravar                         liga o gravador (Ctrl+C para)
//   npm run importar -- video.mp4          traz um vídeo gravado no celular
//   npm run cortar -- "hoje 20h-20h05"     gera o MP4 desse intervalo
//   npm run pedacos                        mostra o que está gravado
//
// Fonte, pasta, retenção etc. vêm do .env (VIDEO_*, ver .env.exemplo).
require('dotenv').config();
const { lerConfig } = require('./modulos/video/config');
const { iniciarGravador } = require('./modulos/video/gravador');
const { cortar } = require('./modulos/video/cortador');
const { listarPedacos } = require('./modulos/video/pedacos');
const { lerPeriodo } = require('./modulos/video/periodo');
const { importar, lerInicioInformado } = require('./modulos/video/importador');

const hora = (d) => d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });

async function main() {
  const [comando, ...resto] = process.argv.slice(2);
  const cfg = lerConfig();

  if (comando === 'gravar') {
    const gravador = iniciarGravador(cfg);
    const sair = async () => {
      console.log('\n[gravador] parando — fechando o pedaço atual...');
      await gravador.parar();
      process.exit(0);
    };
    process.on('SIGINT', sair);
    process.on('SIGTERM', sair);
    return;
  }

  if (comando === 'cortar') {
    const periodo = lerPeriodo(resto.join(' '));
    if (periodo.erro) throw new Error(periodo.erro.replace(/\*/g, ''));
    const minutos = (periodo.fim - periodo.inicio) / 60_000;
    if (minutos > cfg.maxMinutosPorCorte) {
      throw new Error(`${Math.round(minutos)} minutos é demais pra um corte (máximo: ${cfg.maxMinutosPorCorte}).`);
    }
    console.log(`Cortando de ${hora(periodo.inicio)} até ${hora(periodo.fim)}...`);
    const r = await cortar(cfg, periodo.inicio, periodo.fim);
    if (r.erro) throw new Error('A câmera não gravou nada nesse horário.');
    console.log(`Pronto: ${r.arquivo}`);
    console.log(`Duração: ${Math.round(r.segundos)}s (${hora(r.inicio)} → ${hora(r.fim)})`);
    if (r.cortadoNoInicio || r.cortadoNoFim) {
      console.log('Atenção: a gravação não cobre o horário inteiro — saiu só o que foi gravado.');
    }
    return;
  }

  if (comando === 'importar') {
    // npm run importar -- VID_20260925.mp4 [--inicio "25/09 20h03"]
    const posInicio = resto.indexOf('--inicio');
    const textoInicio = posInicio >= 0 ? resto.slice(posInicio + 1).join(' ') : null;
    const arquivo = (posInicio >= 0 ? resto.slice(0, posInicio) : resto).join(' ');
    if (!arquivo) throw new Error('faltou o arquivo. Ex: npm run importar -- VID_20260925.mp4');

    let inicio;
    if (textoInicio) {
      inicio = lerInicioInformado(textoInicio);
      if (!inicio) throw new Error(`não entendi o início "${textoInicio}". Ex: --inicio "25/09 20h03"`);
    }

    console.log(`Importando ${arquivo}...`);
    const r = await importar(cfg, arquivo, { inicio });
    const minutos = Math.round((r.fim - r.inicio) / 60_000);
    console.log(`Pronto: ${r.pedacos} pedaço(s), ${minutos} min de jogo`);
    console.log(`Início: ${hora(r.inicio)}${inicio ? ' (informado)' : ' (lido do arquivo)'}`);
    console.log(`Fim:    ${hora(r.fim)}`);
    if (!inicio) {
      console.log('\nConfere se o início bate com a hora em que você apertou gravar.');
      console.log('Se não bater (alguns celulares erram o fuso), importa de novo com');
      console.log('  --inicio "25/09 20h03"   — reimportar substitui o anterior.');
    }
    if (r.inicio > new Date()) {
      console.log('\nAtenção: o início ficou no FUTURO. É quase certo que o fuso está errado — use --inicio.');
    }
    return;
  }

  if (comando === 'pedacos') {
    const pedacos = listarPedacos(cfg.pasta);
    if (pedacos.length === 0) return console.log(`Nada gravado em ${cfg.pasta}.`);
    for (const p of pedacos) console.log(`${hora(p.inicio)} → ${hora(p.fim)}  ${p.nome}`);
    return;
  }

  console.log('Uso: npm run gravar | npm run importar -- video.mp4 | npm run cortar -- "hoje 20h-21h" | npm run pedacos');
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`Erro: ${err.message}`);
  process.exit(1);
});
