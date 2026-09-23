// De onde vem o vídeo. Cada fonte só diz ao ffmpeg como LER a imagem e como
// GRAVAR ela — gravador, cortador e o resto do bot são os mesmos pra todas.
// Trocar de câmera é trocar VIDEO_FONTE no .env.

// Força um quadro-chave a cada 2s quando a gente mesmo comprime: é a
// precisão do corte, que (pra não recomprimir) só começa em quadro-chave
const QUADRO_CHAVE = ['-force_key_frames', 'expr:gte(t,n_forced*2)'];
const COMPRIMIR = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', ...QUADRO_CHAVE];

const fontes = {
  // Câmera IP (a da quadra): o vídeo já chega comprimido, então só copia —
  // quase sem CPU, dá pra rodar num thin client
  rtsp: (cfg) => {
    if (!cfg.url) throw new Error('VIDEO_URL faltando (ex: rtsp://usuario:senha@192.168.0.50:554/stream1)');
    return {
      entrada: ['-rtsp_transport', 'tcp', '-i', cfg.url],
      codec: ['-c', 'copy'],
    };
  },

  // Webcam do computador: a imagem chega crua e precisa ser comprimida aqui
  webcam: (cfg) => {
    const entrada = process.platform === 'win32'
      ? ['-f', 'dshow', '-rtbufsize', '100M', '-i', `video=${cfg.dispositivo || 'Integrated Webcam'}`]
      : ['-f', 'v4l2', '-i', cfg.dispositivo || '/dev/video0'];
    return { entrada, codec: [...COMPRIMIR, '-an'] };
  },

  // Imagem sintética com contador — pra testar tudo sem câmera nenhuma.
  // -re faz o ffmpeg gerar em tempo real, senão "grava" uma hora em segundos.
  teste: () => ({
    entrada: ['-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15'],
    codec: [...COMPRIMIR, '-an'],
  }),
};

function montarFonte(cfg) {
  const fabricar = fontes[cfg.fonte];
  if (!fabricar) {
    throw new Error(`VIDEO_FONTE "${cfg.fonte}" não existe — use uma destas: ${Object.keys(fontes).join(', ')}`);
  }
  return fabricar(cfg);
}

module.exports = { montarFonte, FONTES: Object.keys(fontes) };
