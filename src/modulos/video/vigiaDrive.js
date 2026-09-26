// Vigia da pasta do Drive: a cada poucos minutos olha se chegou vídeo novo,
// baixa e entrega pro processador (importar → cortar os #replay → mandar).
// Desligada enquanto VIDEO_DRIVE_PASTA não estiver no .env.
//
//   VIDEO_DRIVE_PASTA    link (ou id) da pasta compartilhada com a conta de serviço
//   VIDEO_DRIVE_CHAVE    chave JSON da conta de serviço (padrão: no volume de dados)
//   VIDEO_DRIVE_MINUTOS  de quanto em quanto tempo olhar (padrão: 5)
const fs = require('fs');
const path = require('path');
const repo = require('./repositorio');
const { lerConfig, pastaDeEntrada, nomeSeguro } = require('./config');
const { criarDrive, idDaPasta, lerCredenciais } = require('./drive');
const { processarVideo: processarDeVerdade } = require('./processador');
const { espacoLivre } = require('./rotasPainel');

const GB = 1024 ** 3;
const tamanhoLegivel = (b) => (b >= GB ? `${(b / GB).toFixed(1).replace('.', ',')} GB` : `${Math.round(b / 1024 ** 2)} MB`);

// canal: o mesmo do processador ({ enviarTexto, enviarArquivo, gruposAdmin })
function criarVigia({ drive, pastaId, canal, cfg = lerConfig(), processar = processarDeVerdade }) {
  let ocupado = false;
  // Aviso de erro uma vez só por problema — a vigia roda a cada 5min e não
  // pode encher o grupo de admins com a mesma mensagem
  const jaAvisado = new Set();

  const avisarAdmins = async (texto, chave = texto) => {
    if (jaAvisado.has(chave)) return;
    jaAvisado.add(chave);
    for (const chatId of canal.gruposAdmin()) {
      try { await canal.enviarTexto(chatId, texto); } catch (err) { console.warn(`[drive] aviso não saiu: ${err.message}`); }
    }
  };

  async function verificar() {
    if (ocupado) return;
    ocupado = true;
    try {
      let arquivos;
      try {
        arquivos = await drive.listarVideos(pastaId);
      } catch (err) {
        console.warn(`[drive] não consegui olhar a pasta: ${err.message}`);
        await avisarAdmins(`⚠️ Não consegui olhar a pasta de vídeos do Drive: ${err.message}`, `listar:${err.message}`);
        return;
      }
      for (const arquivo of arquivos) {
        if (repo.videoDoDrive(arquivo.id)) continue; // já foi (ou está indo)
        await trazer(arquivo);
      }
    } finally {
      ocupado = false;
    }
  }

  async function trazer(arquivo) {
    const entrada = pastaDeEntrada(cfg);
    fs.mkdirSync(entrada, { recursive: true });
    const pastaDoArquivo = path.join(entrada, `drive-${arquivo.id}`);
    // O vídeo fica no disco duas vezes durante a importação (original + pedaços)
    const jaBaixado = (() => { try { return fs.statSync(path.join(pastaDoArquivo, `${nomeSeguro(arquivo.name)}.parcial`)).size; } catch { return 0; } })();
    const precisa = (arquivo.size - jaBaixado) + arquivo.size + 2 * GB;
    if (espacoLivre(entrada) < precisa) {
      await avisarAdmins(`⚠️ Chegou ${arquivo.name} (${tamanhoLegivel(arquivo.size)}) no Drive, mas o servidor está sem espaço pra ele agora.`, `espaco:${arquivo.id}`);
      return;
    }

    const video = repo.registrarVideo({ nome: arquivo.name, tamanho: arquivo.size, driveId: arquivo.id, status: 'baixando' });
    await avisarAdmins(`📥 Chegou ${arquivo.name} (${tamanhoLegivel(arquivo.size)}) no Drive. Baixando e cortando os replays…`, `chegou:${arquivo.id}`);
    const destino = path.join(pastaDoArquivo, nomeSeguro(arquivo.name));
    const comecou = Date.now();
    try {
      await drive.baixar(arquivo, destino);
    } catch (err) {
      // Sai da tabela pra vigia tentar de novo na próxima volta — o download
      // continua de onde parou
      repo.apagarVideo(video.id);
      console.warn(`[drive] download de ${arquivo.name} falhou: ${err.message}`);
      await avisarAdmins(`⚠️ O download de ${arquivo.name} do Drive falhou (${err.message}). Tento de novo sozinho.`, `baixar:${arquivo.id}`);
      return;
    }
    console.log(`[drive] ${arquivo.name} baixado em ${Math.round((Date.now() - comecou) / 1000)}s`);
    repo.marcarVideo(video.id, { status: 'processando' });
    try {
      await processar(video.id, destino, canal, { rodape: 'Já pode apagar o vídeo do Drive.' });
    } finally {
      fs.rmSync(pastaDoArquivo, { recursive: true, force: true });
    }
  }

  return { verificar };
}

function iniciarVigiaDoDrive(canal, env = process.env) {
  const interrompidos = repo.limparInterrompidos();
  if (interrompidos) console.log(`[video] ${interrompidos} vídeo(s) interrompido(s) pelo reinício`);

  const pastaId = idDaPasta(env.VIDEO_DRIVE_PASTA);
  if (!pastaId) {
    console.log('[drive] vigia desligada (sem VIDEO_DRIVE_PASTA)');
    return null;
  }
  const chave = env.VIDEO_DRIVE_CHAVE || path.join(path.dirname(env.DB_PATH || 'volei.db'), 'google-drive.json');
  let credenciais;
  try {
    credenciais = lerCredenciais(chave);
  } catch (err) {
    console.warn(`[drive] vigia desligada: não li a chave em ${chave} (${err.message})`);
    return null;
  }

  const vigia = criarVigia({ drive: criarDrive({ credenciais }), pastaId, canal });
  const minutos = parseFloat(env.VIDEO_DRIVE_MINUTOS || '5');
  const rodar = () => vigia.verificar().catch((err) => console.warn(`[drive] erro na vigia: ${err.message}`));
  // Primeira olhada logo depois do boot, com folga pro WhatsApp conectar
  setTimeout(rodar, 60_000).unref?.();
  setInterval(rodar, minutos * 60_000).unref?.();
  console.log(`[drive] vigiando a pasta ${pastaId} a cada ${minutos} min (conta ${credenciais.client_email})`);
  return vigia;
}

module.exports = { criarVigia, iniciarVigiaDoDrive };
