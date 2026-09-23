// Linha de comando do vídeo — roda na máquina que tem a câmera, separado do
// bot do WhatsApp (que mora na VPS).
//
//   npm run gravar                         liga o gravador (Ctrl+C para)
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

  if (comando === 'pedacos') {
    const pedacos = listarPedacos(cfg.pasta);
    if (pedacos.length === 0) return console.log(`Nada gravado em ${cfg.pasta}.`);
    for (const p of pedacos) console.log(`${hora(p.inicio)} → ${hora(p.fim)}  ${p.nome}`);
    return;
  }

  console.log('Uso: npm run gravar | npm run cortar -- "hoje 20h-21h" | npm run pedacos');
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`Erro: ${err.message}`);
  process.exit(1);
});
