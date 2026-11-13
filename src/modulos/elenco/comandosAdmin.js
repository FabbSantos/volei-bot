// Times equilibrados a partir da lista (draft zigue-zague pelas notas do
// elenco) e importação única do elenco da planilha antiga.
const { comando } = require('../../nucleo/comandos');
const grupos = require('../grupos/repositorio');
const pelada = require('../pelada/repositorio');
const { resolverGrupo } = require('../grupos/remoto');
const elenco = require('./repositorio');
const times = require('./times');
const perfis = require('./perfis');
const seed = require('./seed');

// Prévia por padrão (times só na resposta do admin); "enviar" no fim é o que
// posta no grupo da pelada — a montagem é determinística, então a prévia e o
// envio produzem exatamente os mesmos times
// Dois montadores (13/11/2026): "notas" (o de sempre) e "perfil" (funções,
// saque e meninas — a planilha do Diego). Dizer o método monta de novo com
// ele; "comparar" mostra os dois lado a lado sem salvar nada.
const REGEX_TIMES_DE = /^#timesde\s+(.+?)(?:\s+([2-6]))?(?:\s+(notas|perfil))?(?:\s+(enviar|refazer|comparar))?$/i;
const REGEX_IMPORTAR_ELENCO_DE = /^#importarelencode\s+(.+)$/i;
// Quem conta nas médias: #votos riachuelo (situação), "-nome" tira os
// votos da pessoa, "+nome" devolve. Só no privado do dono do bot — fora dele o
// bot fica mudo, e o comando não aparece em ajuda nenhuma.
const REGEX_VOTOS = /^#votos\s+(.+?)(?:\s+([+-])\s*(.+))?$/i;

const ROTULO_METODO = { notas: '⭐ *pelas notas*', perfil: '🧩 *pelo perfil*' };
const EMOJI_CATEGORIA = { 4: '🔥', 3: '👍', 2: '🙂', 1: '😬' };
const LEGENDA_RESUMO = '💥 batedor · 🧱 bloqueador · 🎯 levantador · 🛡️ defensor · 🙌 receptor · 🎀 meninas · 📏 altos · 🏐 saque médio (0 ruim – 4 muito bom)';

// Uma linha por time com os dois olhares — categorias (o que o montador das
// notas equilibra) e funções/meninas/saque (o que o do perfil equilibra)
function resumoDoTime(t) {
  const contar = (pares) => pares.filter(([, n]) => n).map(([e, n]) => `${e}${n}`).join(' ');
  const categorias = contar([4, 3, 2, 1].map((c) => [EMOJI_CATEGORIA[c], t.jogadores.filter((j) => j.categoria === c).length]));
  const funcoes = contar(Object.entries(perfis.EMOJI_ROLE).map(([role, e]) => [e, t.funcoes?.[role] || 0]));
  const extras = contar([['🎀', t.meninas], ['📏', t.altos]]);
  const saque = `🏐${(t.saque ?? 2).toFixed(1).replace('.', ',')}`;
  return [categorias || '—', funcoes, extras, saque].filter(Boolean).join(' · ');
}

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

  const metodoPedido = (m[3] || '').toLowerCase() || null;
  const modo = (m[4] || '').toLowerCase();
  const enviar = modo === 'enviar';
  const refazer = modo === 'refazer' || Boolean(metodoPedido);
  const principal = () => pelada.entradasPrincipais(lista.id);
  const poucos = (n) => `Só ${n} pessoa(s) na principal da lista ${lista.data_jogo} — não dá pra montar ${quantidade} times.`;

  if (modo === 'comparar') {
    const gente = principal();
    if (gente.length < quantidade) return msg.reply(poucos(gente.length));
    const bloco = (metodo) => {
      const ts = times.montarPorMetodo(metodo, r.grupo.chat_id, quantidade, gente);
      return `${ROTULO_METODO[metodo]}\n${ts.map((t) => `*Time ${t.numero}:* ${t.jogadores.map((j) => j.nome).join(', ')}\n   ${resumoDoTime(t)}`).join('\n')}`;
    };
    return msg.reply(
      `⚖️ *Os dois montadores na lista ${lista.data_jogo}* (nada foi salvo nem enviado)\n\n${bloco('notas')}\n\n${bloco('perfil')}\n\n` +
      `_${LEGENDA_RESUMO}_\nPra ficar com um: *#timesde ${m[1]} ${quantidade} notas* ou *#timesde ${m[1]} ${quantidade} perfil*`
    );
  }

  // Times salvos (montados/editados no painel ou aqui) mandam: só refaz
  // quando pedido explicitamente — senão a edição manual seria perdida
  const salvos = refazer ? null : times.getTimesSalvos(lista.id);
  let montados;
  let metodo = metodoPedido || 'notas';
  let origem = 'novos';
  if (salvos?.times?.length) {
    montados = salvos.times;
    metodo = salvos.metodo;
    origem = 'salvos';
  } else {
    const gente = principal();
    if (gente.length < quantidade) return msg.reply(poucos(gente.length));
    montados = times.montarPorMetodo(metodo, r.grupo.chat_id, quantidade, gente);
    times.salvarTimes(lista.id, montados, metodo);
  }

  const anuncioGrupo = times.anuncioDosTimes(lista.data_jogo, montados.map((t) => t.jogadores.map((j) => j.nome)));

  // O que só o ADMIN vê: categorias e funções por time (sem número de nota —
  // 28/10/2026) e quem entrou sem avaliação. Um time por linha: tudo numa
  // linha ficava ilegível no celular
  const mediasTexto = `📊 *Por time (só pra vocês)* — ${ROTULO_METODO[metodo]}\n${montados.map((t, i) =>
    `Time ${i + 1}: ${resumoDoTime(t)}`).join('\n')}\n_${LEGENDA_RESUMO}_`;
  const desconhecidos = montados.flatMap((t) => t.jogadores).filter((j) => !j.conhecido).map((j) => j.nome);
  const semPerfil = metodo === 'perfil' ? montados.flatMap((t) => t.jogadores).filter((j) => !j.temPerfil).map((j) => j.nome) : [];
  const listarAlguns = (nomes) => `${nomes.slice(0, 6).join(', ')}${nomes.length > 6 ? ` e mais ${nomes.length - 6}` : ''}`;
  const avisoDesconhecidos = (desconhecidos.length > 0
    ? `\n⚠️ ${desconhecidos.length} sem avaliação no elenco (entraram como 🙂 de boa): ${listarAlguns(desconhecidos)}. Cadastra/vota no painel.`
    : '') + (semPerfil.length > 0
    ? `\n⚠️ ${semPerfil.length} sem perfil (entraram como Normal): ${listarAlguns(semPerfil)}. Preenche na aba Perfis do painel.`
    : '');

  if (!enviar) {
    const notaOrigem = origem === 'salvos'
      ? `\n💾 São os times *salvos* (montados/editados no painel). Pra jogar tudo fora e montar de novo: *#timesde ${m[1]} ${quantidade} refazer* (ou com *notas*/*perfil* pra escolher o montador).`
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

const votos = comando(REGEX_VOTOS, (msg, m) => {
  if (msg.origem !== 'privado') return;
  const r = resolverGrupo(m[1]);
  if (r.mensagem) return msg.reply(r.mensagem);
  const chatId = r.grupo.chat_id;
  const conhecidos = [...new Set([...seed.VOTANTES, ...elenco.listarVotantes(chatId)])];

  if (m[2]) {
    const pedido = m[3].trim().toLowerCase();
    const votante = conhecidos.find((v) => v.toLowerCase() === pedido);
    if (!votante) return msg.reply(`Não conheço o votante "${m[3].trim()}". Votantes: ${conhecidos.join(', ')}`);
    elenco.ignorarVotante(chatId, votante, m[2] === '-');
  }

  const fora = new Set(elenco.votantesIgnorados(chatId).map((v) => v.toLowerCase()));
  const linhas = elenco.resumoDosVotantes(chatId).map((v) =>
    `${fora.has(v.votante.toLowerCase()) ? '🚫' : '✅'} *${v.votante}* — ${v.votos} votos, média ${v.media.toFixed(2).replace('.', ',')}`);
  return msg.reply(
    `🗳️ *Votos que contam nas notas* (só você vê isto)\n\n${linhas.join('\n') || 'Ninguém votou ainda.'}\n\n` +
    `_#votos ${m[1]} -nome tira · #votos ${m[1]} +nome devolve_`
  );
});

module.exports = { comandos: [timesDe, importarElenco, votos] };
