// Configuração do vídeo, toda por variável de ambiente (ver .env.exemplo).
// Roda na máquina que tem a câmera: hoje o PC, depois o computador da quadra.
const path = require('path');

function lerConfig(env = process.env) {
  return {
    fonte: env.VIDEO_FONTE || 'teste',
    dispositivo: env.VIDEO_DISPOSITIVO || null,
    url: env.VIDEO_URL || null,
    pasta: path.resolve(env.VIDEO_PASTA || 'gravacoes'),
    // Tamanho de cada pedaço gravado. 5min é o equilíbrio: pedaço grande
    // demora pra sair do forno; pedaço pequeno vira milhares de arquivos
    segundosPorPedaco: parseInt(env.VIDEO_SEGUNDOS || '300', 10),
    retencaoDias: parseFloat(env.VIDEO_RETENCAO_DIAS || '7'),
    // Corte maior que isso é engano de digitação, não pedido de verdade
    maxMinutosPorCorte: parseInt(env.VIDEO_MAX_MINUTOS || '180', 10),
    ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
  };
}

module.exports = { lerConfig };
