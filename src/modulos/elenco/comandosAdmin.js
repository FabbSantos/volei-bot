// Times equilibrados a partir da lista (draft zigue-zague pelas notas do
// elenco) e importação única do elenco da planilha antiga.
const { comando } = require('../../nucleo/comandos');
const grupos = require('../grupos/repositorio');
const pelada = require('../pelada/repositorio');
const { resolverGrupo } = require('../grupos/remoto');
const elenco = require('./repositorio');
const times = require('./times');
const seed = require('./seed');

// Prévia por padrão (times só na resposta do admin); "enviar" no fim é o que
// posta no grupo da pelada — a montagem é determinística, então a prévia e o
// envio produzem exatamente os mesmos times
const REGEX_TIMES_DE = /^#timesde\s+(.+?)(?:\s+([2-6]))?(?:\s+(enviar|refazer))?$/i;
const REGEX_IMPORTAR_ELENCO_DE = /^#importarelencode\s+(.+)$/i;

const timesDe = comando(REGEX_TIMES_DE, async (msg, m) => {
  // Nome de grupo terminando em número (ex: "Quadra 7") engoliria a
  // quantidade — se o termo inteiro é um grupo, usa ele e o padrão de times
  let termo = m[1];
  let quantidade = m[2] ? parseInt(m[2], 10) : 3;
  const inteiro = `${m[1]}${m[2] ? ` ${m[2]}` : ''}`;
  if (m[2] && grupos.buscarGrupos(inteiro).length > 0) {
    termo = inteiro;
    quantidade = 3;
  }
  const r = resolverGrupo(termo);
  if (r.mensagem) return msg.reply(r.mensagem);
  const lista = pelada.getListaMaisRecente(r.grupo.chat_id);
  if (!lista) {
    return msg.reply(`*${r.grupo.nome || r.grupo.chat_id}* ainda não tem lista.`);
  }

  const modo = (m[3] || '').toLowerCase();
  const enviar = modo === 'enviar';
  const refazer = modo === 'refazer';

  // Times salvos (montados/editados no painel ou aqui) mandam: só refaz
  // quando pedido explicitamente — senão a edição manual seria perdida
  const salvos = refazer ? null : times.getTimesSalvos(lista.id);
  let montados;
  let origem = 'novos';
  if (salvos?.times?.length) {
    montados = salvos.times;
    origem = 'salvos';
  } else {
    const principal = pelada.entradasPrincipais(lista.id);
    if (principal.length < quantidade) {
      return msg.reply(`Só ${principal.length} pessoa(s) na principal da lista ${lista.data_jogo} — não dá pra montar ${quantidade} times.`);
    }
    montados = times.montarTimes(r.grupo.chat_id, quantidade, principal);
    times.salvarTimes(lista.id, montados);
  }

  const anuncioGrupo = times.anuncioDosTimes(lista.data_jogo, montados.map((t) => t.jogadores.map((j) => j.nome)));

  // O que só o ADMIN vê: médias e quem entrou sem nota
  let mediasTexto = `📊 Médias (só pra vocês): ${montados.map((t) => t.media.toFixed(2)).join(' / ')}`;
  if (montados.some((t) => t.altos > 0)) {
    mediasTexto += `\n📏 Altos por time: ${montados.map((t) => t.altos).join(' / ')}`;
  }
  const desconhecidos = montados.flatMap((t) => t.jogadores).filter((j) => !j.conhecido).map((j) => j.nome);
  const avisoDesconhecidos = desconhecidos.length > 0
    ? `\n⚠️ ${desconhecidos.length} sem nota no elenco (entraram como medianos): ${desconhecidos.slice(0, 6).join(', ')}${desconhecidos.length > 6 ? ` e mais ${desconhecidos.length - 6}` : ''}. Cadastra/vota no painel.`
    : '';

  if (!enviar) {
    const notaOrigem = origem === 'salvos'
      ? `\n💾 São os times *salvos* (montados/editados no painel). Pra jogar tudo fora e montar de novo: *#timesde ${m[1]} ${quantidade} refazer*.`
      : `\n💾 Salvos — pode editar no painel que o bot passa a mostrar a versão editada.`;
    return msg.reply(
      `${anuncioGrupo}\n\n👆 *Prévia — o grupo NÃO recebeu nada.*\n${mediasTexto}${avisoDesconhecidos}${notaOrigem}\nGostou? Manda *#timesde ${m[1]} ${quantidade} enviar* que sai igualzinho (sem essa parte de baixo).`
    );
  }

  try {
    await msg.enviarPara(r.grupo.chat_id, anuncioGrupo);
  } catch (err) {
    return msg.reply(`⚠️ Não consegui mandar no grupo (${err.message}).`);
  }
  return msg.reply(
    `⚔️ ${quantidade} times anunciados na lista ${lista.data_jogo}.\n${mediasTexto}${avisoDesconhecidos}`
  );
});

const importarElenco = comando(REGEX_IMPORTAR_ELENCO_DE, async (msg, m) => {
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  const { NIVEL_PARA_NOTA, VOTANTES, ELENCO, PELADA_PLANILHA, APELIDOS } = seed;
  const porNome = new Map();
  let importados = 0;
  for (const [nome, niveis] of ELENCO) {
    const jogador = elenco.upsertJogador(r.grupo.chat_id, nome);
    porNome.set(nome, jogador);
    VOTANTES.forEach((votante, i) => {
      const nota = NIVEL_PARA_NOTA[niveis[i]];
      for (const fundamento of elenco.FUNDAMENTOS) {
        elenco.votarHabilidade(jogador.id, votante, fundamento, nota);
      }
    });
    importados++;
  }
  for (const [nome, apelidos] of APELIDOS) {
    const jogador = porNome.get(nome);
    if (jogador) for (const apelido of apelidos) elenco.adicionarApelido(jogador.id, apelido);
  }

  // Quem estava na planilha jogou aquela pelada: cria a lista histórica
  // (encerrada, com a data original) pra todos começarem com presença 1
  const { ja_existia, lista } = pelada.criarLista(
    r.grupo.chat_id,
    PELADA_PLANILHA.dataJogo,
    PELADA_PLANILHA.nome,
    0,
    { status: 'encerrada', criadaEm: PELADA_PLANILHA.criadaEm }
  );
  let presencas = 0;
  if (!ja_existia) {
    for (const [nome] of ELENCO) {
      const numero = `planilha-${nome.toLowerCase().replace(/[^a-z0-9]+/g, '-')}@import`;
      if (!pelada.registrarPresencaHistorica(lista.id, nome, numero).erro) presencas++;
    }
  }

  return msg.reply(
    `📥 Elenco da planilha importado pra *${r.grupo.nome || r.grupo.chat_id}*: ${importados} jogador(es) com os votos dos 4 votantes (I=2, M=3, A=4 na escala 1-5).` +
    (presencas > 0
      ? `\n📅 Pelada de ${PELADA_PLANILHA.dataJogo} registrada — ${presencas} jogador(es) já começam com presença 1.`
      : `\n📅 A pelada de ${PELADA_PLANILHA.dataJogo} já estava registrada.`) +
    `\nRefina as notas no painel!`
  );
});

module.exports = { comandos: [timesDe, importarElenco] };
