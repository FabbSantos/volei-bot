const fs = require('fs');
const db = require('./db');
const {
  TEXTO_AJUDA_COMUM,
  TEXTO_AJUDA_ADMIN_GRUPO,
  acharFigurinha,
  acharFigurinhaQuitado,
  montarLembretePagamento,
  montarLembreteSubiu,
} = require('./commands');

// #ativargrupo <chat_id> [vagas] [--espera] — ex: #ativargrupo 123@g.us 18 --6
// Os números são opcionais: sem eles, ativa mantendo o tamanho já configurado.
const REGEX_ATIVAR = /^#ativargrupo\s+(\S+)(?:\s+(\d{1,3}))?(?:\s+--(\d{1,3}))?$/i;
const REGEX_DESATIVAR = /^#desativargrupo\s+(\S+)$/i;
const CMD_LISTAR = '#listargrupos';
const CMD_AJUDA_ADMIN = '#admin';
// Comandos remotos: <grupo> pode ser um pedaço do nome ou o chat_id exato
const REGEX_LISTA_DE = /^#listade\s+(.+)$/i;
const REGEX_CANCELAR_LISTA_DE = /^#cancelarlistade\s+(.+)$/i;
const REGEX_ENCERRAR_LISTA_DE = /^#encerrarlistade\s+(.+?)(\s+quieto)?$/i;
// Destranca lista encerrada cedo demais (gente ainda querendo entrar)
const REGEX_REABRIR_LISTA_DE = /^#reabrirlistade\s+(.+?)(\s+quieto)?$/i;
// #editarlistade <grupo> 07/08 [Nome novo] — conserta data/nome da lista atual
const REGEX_EDITAR_LISTA_DE = /^#editarlistade\s+(.+?)\s+(\d{1,2}\/\d{1,2})(?:\s+(.+))?$/i;
// Corrige o nome de alguém que já está na lista (posição continua a mesma)
const REGEX_RENOMEAR_DE = /^#renomearde\s+(.+?)\s+(\d{1,3})\s+(.+?)(\s+quieto)?$/i;
// Coloca convidado na lista à distância (o par do #removerde)
const REGEX_ADICIONAR_DE = /^#adicionarde\s+(.+?)(\s+quieto)?$/i;
// Remove da LISTA semanal à distância (fluxo do "não pagou até 12h, sai
// pro da espera entrar") — aceita lote: 14, 13-16 ou 13,15
const REGEX_REMOVER_DE = /^#removerde\s+(.+?)\s+(\d{1,3}(?:\s*[-,]\s*\d{1,3})*)$/i;
// Cobrança manual, na hora, sem mexer no lembrete diário automático:
// #cobrarde = recado geral (mira = principal sem pagar); #cobrarsubiude =
// só quem subiu da espera (prazo de sexta 17h)
const REGEX_COBRAR_DE = /^#cobrarde\s+(.+)$/i;
const REGEX_COBRAR_SUBIU_DE = /^#cobrarsubiude\s+(.+)$/i;
// Times equilibrados a partir da lista (draft zigue-zague pelas notas do
// elenco) e importação única do elenco da planilha antiga
// Prévia por padrão (times só na resposta do admin); "enviar" no fim é o que
// posta no grupo da pelada — a montagem é determinística, então a prévia e o
// envio produzem exatamente os mesmos times
const REGEX_TIMES_DE = /^#timesde\s+(.+?)(?:\s+([2-6]))?(?:\s+(enviar|refazer))?$/i;
const REGEX_IMPORTAR_ELENCO_DE = /^#importarelencode\s+(.+)$/i;
// #abrirlistade <grupo> DD/MM [valor] [nome] — abre a lista da pelada daqui,
// já anunciando no grupo dela (ex: #abrirlistade riachuelo 07/08 17 Sexta 3h)
const REGEX_ABRIR_LISTA_DE = /^#abrirlistade\s+(.+?)\s+(\d{1,2}\/\d{1,2})(?:\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?))?(?:\s+(.+))?$/i;
const REGEX_PAGOS_DE = /^#pagosde\s+(.+)$/i;
const REGEX_ADMINS_DE = /^#adminsde\s+(.+)$/i;
const REGEX_MENSALISTAS_DE = /^#mensalistasde\s+(.+)$/i;
// Pré-lista de mensalistas: abre/fecha as inscrições do mês e reinício manual
// "quieto" no fim = muda sem anunciar no grupo
const REGEX_ABRIR_MENSALISTAS_DE = /^#abrirmensalistasde\s+(.+?)(\s+quieto)?$/i;
const REGEX_FECHAR_MENSALISTAS_DE = /^#fecharmensalistasde\s+(.+?)(\s+quieto)?$/i;
const REGEX_REINICIAR_MENSALISTAS_DE = /^#reiniciarmensalistasde\s+(.+)$/i;
// Gestão remota de mensalistas — mexe no quadro de um grupo sem poluir o
// grupo da pelada com comando; o efeito aparece lá na próxima lista
const REGEX_MENSALISTA_DE = /^#mensalistade\s+(.+?)\s+([^\d\s].*)$/i; // grupo + nome
// Posições aceitam lote: "3", "1-5" ou "1,3,7" — um comando, um anúncio
const REGEX_PAGO_MES_DE = /^#pagomesde\s+(.+?)\s+(\d{1,3}(?:\s*[-,]\s*\d{1,3})*)(?:\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?))?$/i;
const REGEX_NAOPAGO_MES_DE = /^#naopagomesde\s+(.+?)\s+(\d{1,3}(?:\s*[-,]\s*\d{1,3})*)$/i;
// Pagamento da lista SEMANAL marcado daqui (equivalente remoto do #pago N)
const REGEX_PAGO_DE = /^#pagode\s+(.+?)\s+(\d{1,3}(?:\s*[-,]\s*\d{1,3})*)$/i;
const REGEX_NAOPAGO_DE = /^#naopagode\s+(.+?)\s+(\d{1,3}(?:\s*[-,]\s*\d{1,3})*)$/i;

// "1-5", "1,3,7" ou "2" → [1, 2, 3, 4, 5] — máx. 50 posições por comando,
// valendo pra faixa, avulsas e mistura (repetida conta uma vez só)
// Em '<grupo> <nome>' os dois são texto livre: testa o pedaço de grupo mais
// longo que resolve pra exatamente um grupo (assim 'Sem Espera Maria' vira
// grupo 'Sem Espera' + nome 'Maria', e 'riachuelo Joao' vira 'riachuelo' + 'Joao')
function separarGrupoENome(resto) {
  const partes = String(resto || '').trim().split(' ').filter(Boolean);
  for (let i = partes.length - 1; i >= 1; i--) {
    const termo = partes.slice(0, i).join(' ');
    if (db.buscarGrupos(termo).length === 1) {
      return { termo, nome: partes.slice(i).join(' ') };
    }
  }
  return { termo: partes[0] || '', nome: partes.slice(1).join(' ') };
}

function expandirPosicoes(texto) {
  const posicoes = new Set();
  const cheio = () => posicoes.size >= 50;
  for (const parte of String(texto).split(',')) {
    if (cheio()) break;
    const p = parte.trim();
    const faixa = p.match(/^(\d{1,3})\s*-\s*(\d{1,3})$/);
    if (faixa) {
      const inicio = Math.min(parseInt(faixa[1], 10), parseInt(faixa[2], 10));
      const fim = Math.max(parseInt(faixa[1], 10), parseInt(faixa[2], 10));
      for (let i = inicio; i <= fim && !cheio(); i++) posicoes.add(i);
    } else if (/^\d{1,3}$/.test(p)) {
      posicoes.add(parseInt(p, 10));
    }
  }
  return [...posicoes].sort((a, b) => a - b);
}
const REGEX_FIXO_DE = /^#fixode\s+(.+?)\s+(\d{1,3})$/i;
const REGEX_REMOVER_MENSALISTA_DE = /^#removermensalistade\s+(.+?)\s+(\d{1,3}(?:\s*[-,]\s*\d{1,3})*)$/i;
const REGEX_VALOR_MES_DE = /^#valormesde\s+(.+?)\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?)$/i;
const REGEX_VAGAS_MENSALISTAS_DE = /^#vagasmensalistasde\s+(.+?)\s+(\d{1,3})$/i;
const REGEX_VALOR_DE = /^#valorde\s+(.+?)\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?)$/i;
const REGEX_VALOR_LISTA_DE = /^#valorlistade\s+(.+?)\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?)$/i;
const REGEX_GRUPO_ADMIN = /^#grupoadmin\s+(\S+)(?:\s+(off))?$/i;

const TEXTO_AJUDA_ADMIN = `🔧 *Comandos de admin (privado ou grupo de admins)*

*#listargrupos* — todos os grupos, com status, tamanho, valor e chat_id
*#ativargrupo <chat_id>* — libera um grupo pra usar o bot
*#ativargrupo <chat_id> 18 --6* — libera e dimensiona (padrão: 18 + 6)
*#desativargrupo <chat_id>* — bloqueia um grupo (ex: inadimplência)

📡 *Consulta/gestão remota (<grupo> = pedaço do nome ou chat_id):*
*#abrirlistade <grupo> 07/08 17 Sexta 3h* — abre a lista de lá (valor e nome opcionais) e anuncia no grupo
*#editarlistade <grupo> 07/08 Nome* — corrige data/nome da lista atual (nome opcional)
*#encerrarlistade <grupo>* — encerra a lista (trava nomes) e anuncia; com *quieto* no fim, não anuncia
*#reabrirlistade <grupo>* — destranca a lista encerrada (aceita *quieto*)
*#cancelarlistade <grupo>* — APAGA a lista mais recente (criada errada/teste) e anuncia
*#listade <grupo>* — lista atual do grupo
*#pagosde <grupo>* — quem pagou, quem falta e quanto arrecadou
*#mensalistasde <grupo>* — quadro de mensalistas do mês + arrecadação
*#adminsde <grupo>* — admins do grupo no WhatsApp (são eles que marcam #pago lá)

🗓 *Gestão de mensalistas daqui mesmo:*
*#abrirmensalistasde <grupo>* / *#fecharmensalistasde <grupo>* — abre/fecha as inscrições do mês (anuncia no grupo; com *quieto* no fim, não anuncia)
*#reiniciarmensalistasde <grupo>* — zera os não-fixos e fecha as inscrições
*#pagomesde <grupo> 1-5* — marca o mês (aceita 3, 1-5 ou 1,3,7; valor opcional no fim); anuncia no grupo
*#naopagomesde <grupo> 3* — desmarca o mês (aceita faixa também)
*#pagode <grupo> 1-3* — marca o ✅ da LISTA semanal daqui (aceita faixa); anuncia no grupo
*#naopagode <grupo> 3* — desmarca o ✅ da lista
*#adicionarde <grupo> Nome* — coloca convidado na lista (aceita *quieto*)
*#renomearde <grupo> 5 Nome Certo* — corrige o nome de quem está na posição 5 (silencioso)
*#removerde <grupo> 14* — tira da lista semanal (aceita faixa); a espera sobe e o grupo é avisado
*#cobrarde <grupo>* — solta o recado do agiota agora (mira = principal sem pagar)
*#cobrarsubiude <grupo>* — cobra só quem subiu da espera (prazo sexta 17h)
*#timesde <grupo> 3* — PRÉVIA dos times (só você vê); mostra os salvos se já existirem
*#timesde <grupo> 3 enviar* — posta no grupo · *... refazer* — remonta do zero
*#importarelencode <grupo>* — importa o elenco/notas da planilha antiga (uma vez)
*#fixode <grupo> 3* — liga/desliga a vaga cativa (📌)
*#mensalistade <grupo> Nome* — cadastra candidato (melhor a pessoa mandar #mensalista no grupo: aí o WhatsApp dela fica vinculado)
*#removermensalistade <grupo> 3* — tira do quadro (aceita faixa: 6-9 ou 6,8)
*#valormesde <grupo> 53* — mensalidade · *#vagasmensalistasde <grupo> 12* — vagas
*#valorde <grupo> 25* — valor padrão por pessoa (vale pras próximas listas)
*#valorlistade <grupo> 30* — valor só da lista aberta agora (ex: sexta de 3h)

*#grupoadmin <chat_id>* — (só no privado) define o grupo de admins; com "off" no fim, desfaz
*#admin* — mostra essa ajuda

Repetir #ativargrupo num grupo já ativo só atualiza o tamanho.`;

// Acha o grupo alvo de um comando remoto: chat_id exato ou pedaço do nome.
// Retorna { grupo } ou { mensagem } pronta pra responder.
function resolverGrupo(termo) {
  const achados = db.buscarGrupos(termo.trim());
  if (achados.length === 0) {
    return { mensagem: `Não achei nenhum grupo com "${termo}". Vê os nomes e chat_ids com *#listargrupos*.` };
  }
  if (achados.length > 1) {
    const linhas = achados.map((g) => `• ${g.nome || '(sem nome)'} — ${g.chat_id}`).join('\n');
    return { mensagem: `Achei ${achados.length} grupos com "${termo}":\n${linhas}\n\nSê mais específico ou usa o chat_id.` };
  }
  return { grupo: achados[0] };
}

// msg = { body, reply(texto), origem: 'privado' | 'grupoadmin',
//         getAdminsDoGrupo(chatId): Promise<numeros[]> — consulta os admins de um grupo no WhatsApp }
// Já validado antes de chegar aqui: veio do número admin (privado) ou do grupo de admins.
async function processarComandoAdmin(msg) {
  const texto = (msg.body || '').trim();
  // Teclado de celular adora converter "--" em travessão (– ou —);
  // normaliza antes de tentar casar o comando de ativação
  const textoNormalizado = texto.replace(/[–—]/g, '--');

  if (texto.toLowerCase() === CMD_LISTAR) {
    const grupos = db.listarGrupos();
    if (grupos.length === 0) {
      return msg.reply('Nenhum grupo cadastrado ainda — o bot registra sozinho assim que alguém manda a primeira mensagem num grupo que ele participa.');
    }

    const linhas = grupos.map((g) => {
      const status = g.eh_admin ? '🛠 admin' : (g.ativo ? '✅ ativo' : '⛔ inativo');
      const valor = g.valor_padrao_centavos > 0 ? ` — ${db.formatarReais(g.valor_padrao_centavos)}/pessoa` : '';
      return `${status} — ${g.nome || '(sem nome)'} — ${g.limite_principal} vagas + ${g.limite_espera} espera${valor}\n   chat_id: ${g.chat_id}`;
    });

    return msg.reply(`📋 *Grupos cadastrados (${grupos.length}):*\n\n${linhas.join('\n\n')}`);
  }

  const matchAtivar = textoNormalizado.match(REGEX_ATIVAR);
  if (matchAtivar) {
    const chatId = matchAtivar[1];
    const principal = matchAtivar[2] ? parseInt(matchAtivar[2], 10) : null;
    const espera = matchAtivar[3] ? parseInt(matchAtivar[3], 10) : null;

    if (principal !== null && principal < 1) {
      return msg.reply('O tamanho da lista precisa ser pelo menos 1. Ex: *#ativargrupo <chat_id> 18 --6*');
    }

    const { sucesso, promovidos } = db.ativarGrupo(chatId, { principal, espera });
    if (!sucesso) {
      return msg.reply('Não achei nenhum grupo com esse chat_id. Confere com *#listargrupos*.');
    }

    const grupo = db.getGrupo(chatId);
    let resposta = `✅ Grupo ${chatId} ativado! Lista com *${grupo.limite_principal}* vagas + *${grupo.limite_espera}* de espera. Já pode usar #listaDD/MM lá dentro.`;
    if (promovidos.length > 0) {
      resposta += `\n⬆️ Com a lista maior, subiram da espera: ${promovidos.join(', ')}. Bom avisar lá no grupo!`;
    }
    return msg.reply(resposta);
  }

  const matchDesativar = texto.match(REGEX_DESATIVAR);
  if (matchDesativar) {
    const chatId = matchDesativar[1];
    const sucesso = db.desativarGrupo(chatId);
    return msg.reply(sucesso
      ? `⛔ Grupo ${chatId} desativado. Comandos de lista vão parar de responder lá.`
      : `Não achei nenhum grupo com esse chat_id. Confere com *#listargrupos*.`);
  }

  const matchAbrirListaDe = texto.match(REGEX_ABRIR_LISTA_DE);
  if (matchAbrirListaDe) {
    const r = resolverGrupo(matchAbrirListaDe[1]);
    if (r.mensagem) return msg.reply(r.mensagem);
    const dataJogo = matchAbrirListaDe[2];
    const valorCriacao = matchAbrirListaDe[3] ? db.paraCentavos(matchAbrirListaDe[3]) : null;
    const nomeLista = matchAbrirListaDe[4]?.trim() || null;
    const nomeGrupo = r.grupo.nome || r.grupo.chat_id;

    const { ja_existia, lista } = db.criarLista(r.grupo.chat_id, dataJogo, nomeLista, valorCriacao);
    if (ja_existia) {
      return msg.reply(`Já existe lista pro dia ${dataJogo} em *${nomeGrupo}*. Vê com *#listade*.`);
    }

    // Anuncia direto no grupo da pelada — senão ninguém fica sabendo que abriu
    const anuncio = `✅ Lista ${nomeLista ? `*${nomeLista}* ` : ''}aberta pro dia *${dataJogo}*${
      valorCriacao != null ? ` — ${db.formatarReais(valorCriacao)} por pessoa` : ''
    }! Manda *#lista* pra entrar.\n\n${db.montarListaFormatada(lista.id, lista.data_jogo)}`;
    let avisoEntrega = '';
    if (msg.enviarPara) {
      try {
        await msg.enviarPara(r.grupo.chat_id, anuncio);
      } catch (err) {
        avisoEntrega = `\n⚠️ Não consegui anunciar no grupo (${err.message}) — avisa lá manualmente.`;
      }
    }
    return msg.reply(
      `✅ Lista ${nomeLista ? `*${nomeLista}* ` : ''}de *${dataJogo}* aberta em *${nomeGrupo}*${
        valorCriacao != null ? ` — ${db.formatarReais(valorCriacao)}/pessoa` : ''
      }, com os mensalistas no topo. Anunciada lá no grupo.${avisoEntrega}`
    );
  }

  const matchTimesDe = texto.match(REGEX_TIMES_DE);
  if (matchTimesDe) {
    // Nome de grupo terminando em número (ex: "Quadra 7") engoliria a
    // quantidade — se o termo inteiro é um grupo, usa ele e o padrão de times
    let termo = matchTimesDe[1];
    let quantidade = matchTimesDe[2] ? parseInt(matchTimesDe[2], 10) : 3;
    const inteiro = `${matchTimesDe[1]}${matchTimesDe[2] ? ` ${matchTimesDe[2]}` : ''}`;
    if (matchTimesDe[2] && db.buscarGrupos(inteiro).length > 0) {
      termo = inteiro;
      quantidade = 3;
    }
    const r = resolverGrupo(termo);
    if (r.mensagem) return msg.reply(r.mensagem);
    const lista = db.getListaMaisRecente(r.grupo.chat_id);
    if (!lista) {
      return msg.reply(`*${r.grupo.nome || r.grupo.chat_id}* ainda não tem lista.`);
    }

    const modo = (matchTimesDe[3] || '').toLowerCase();
    const enviar = modo === 'enviar';
    const refazer = modo === 'refazer';

    // Times salvos (montados/editados no painel ou aqui) mandam: só refaz
    // quando pedido explicitamente — senão a edição manual seria perdida
    const salvos = refazer ? null : db.getTimesSalvos(lista.id);
    let times;
    let origem = 'novos';
    if (salvos?.times?.length) {
      times = salvos.times;
      origem = 'salvos';
    } else {
      const principal = db.entradasPrincipais(lista.id);
      if (principal.length < quantidade) {
        return msg.reply(`Só ${principal.length} pessoa(s) na principal da lista ${lista.data_jogo} — não dá pra montar ${quantidade} times.`);
      }
      times = db.montarTimes(r.grupo.chat_id, quantidade, principal);
      db.salvarTimes(lista.id, times);
    }

    // O que o GRUPO vê: zero pista de como foi montado — nada de médias,
    // notas ou método. Tecnologia da NASA e ponto. 🚀
    const linhasGrupo = times.map((t) =>
      `⚔️ *Time ${t.numero}*\n${t.jogadores.map((j) => `• ${j.nome}`).join('\n')}`
    );
    const anuncioGrupo = `🏐 *Times da pelada — ${lista.data_jogo}*\nMontados com tecnologia da NASA 🚀\n\n${linhasGrupo.join('\n\n')}\n\nBom jogo! 🔥`;

    // O que só o ADMIN vê: médias e quem entrou sem nota
    let mediasTexto = `📊 Médias (só pra vocês): ${times.map((t) => t.media.toFixed(2)).join(' / ')}`;
    if (times.some((t) => t.altos > 0)) {
      mediasTexto += `\n📏 Altos por time: ${times.map((t) => t.altos).join(' / ')}`;
    }
    const desconhecidos = times.flatMap((t) => t.jogadores).filter((j) => !j.conhecido).map((j) => j.nome);
    const avisoDesconhecidos = desconhecidos.length > 0
      ? `\n⚠️ ${desconhecidos.length} sem nota no elenco (entraram como medianos): ${desconhecidos.slice(0, 6).join(', ')}${desconhecidos.length > 6 ? ` e mais ${desconhecidos.length - 6}` : ''}. Cadastra/vota no painel.`
      : '';

    if (!enviar) {
      const notaOrigem = origem === 'salvos'
        ? `\n💾 São os times *salvos* (montados/editados no painel). Pra jogar tudo fora e montar de novo: *#timesde ${matchTimesDe[1]} ${quantidade} refazer*.`
        : `\n💾 Salvos — pode editar no painel que o bot passa a mostrar a versão editada.`;
      return msg.reply(
        `${anuncioGrupo}\n\n👆 *Prévia — o grupo NÃO recebeu nada.*\n${mediasTexto}${avisoDesconhecidos}${notaOrigem}\nGostou? Manda *#timesde ${matchTimesDe[1]} ${quantidade} enviar* que sai igualzinho (sem essa parte de baixo).`
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
  }

  const matchImportarElenco = texto.match(REGEX_IMPORTAR_ELENCO_DE);
  if (matchImportarElenco) {
    const r = resolverGrupo(matchImportarElenco[1]);
    if (r.mensagem) return msg.reply(r.mensagem);
    const { NIVEL_PARA_NOTA, VOTANTES, ELENCO, PELADA_PLANILHA, APELIDOS } = require('./elencoSeed');
    const porNome = new Map();
    let importados = 0;
    for (const [nome, niveis] of ELENCO) {
      const jogador = db.upsertJogador(r.grupo.chat_id, nome);
      porNome.set(nome, jogador);
      VOTANTES.forEach((votante, i) => {
        const nota = NIVEL_PARA_NOTA[niveis[i]];
        for (const fundamento of db.FUNDAMENTOS) {
          db.votarHabilidade(jogador.id, votante, fundamento, nota);
        }
      });
      importados++;
    }
    for (const [nome, apelidos] of APELIDOS) {
      const jogador = porNome.get(nome);
      if (jogador) for (const apelido of apelidos) db.adicionarApelido(jogador.id, apelido);
    }

    // Quem estava na planilha jogou aquela pelada: cria a lista histórica
    // (encerrada, com a data original) pra todos começarem com presença 1
    const { ja_existia, lista } = db.criarLista(
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
        if (!db.registrarPresencaHistorica(lista.id, nome, numero).erro) presencas++;
      }
    }

    return msg.reply(
      `📥 Elenco da planilha importado pra *${r.grupo.nome || r.grupo.chat_id}*: ${importados} jogador(es) com os votos dos 4 votantes (I=2, M=3, A=4 na escala 1-5).` +
      (presencas > 0
        ? `\n📅 Pelada de ${PELADA_PLANILHA.dataJogo} registrada — ${presencas} jogador(es) já começam com presença 1.`
        : `\n📅 A pelada de ${PELADA_PLANILHA.dataJogo} já estava registrada.`) +
      `\nRefina as notas no painel!`
    );
  }

  const matchCobrarDe = texto.match(REGEX_COBRAR_DE);
  const matchCobrarSubiuDe = matchCobrarDe ? null : texto.match(REGEX_COBRAR_SUBIU_DE);
  if (matchCobrarDe || matchCobrarSubiuDe) {
    const soPromovidos = Boolean(matchCobrarSubiuDe);
    const r = resolverGrupo((matchCobrarDe || matchCobrarSubiuDe)[1]);
    if (r.mensagem) return msg.reply(r.mensagem);
    const lista = db.getListaMaisRecente(r.grupo.chat_id);
    if (!lista) {
      return msg.reply(`*${r.grupo.nome || r.grupo.chat_id}* ainda não tem lista.`);
    }

    const resumo = db.resumoPagamentos(lista.id);
    const alvo = soPromovidos ? resumo.promovidosPendentes : resumo.pendentes;
    if (alvo.length === 0) {
      return msg.reply(soPromovidos
        ? `Ninguém que subiu da espera está devendo em *${r.grupo.nome || r.grupo.chat_id}* 🎉`
        : `Todo mundo em dia na lista ${lista.data_jogo} de *${r.grupo.nome || r.grupo.chat_id}* 🎉 Nada a cobrar.`);
    }

    try {
      await msg.enviarPara(
        r.grupo.chat_id,
        soPromovidos ? montarLembreteSubiu(alvo) : montarLembretePagamento(alvo)
      );
      const figurinha = acharFigurinha('cade-meu-pix');
      if (msg.enviarFigurinhaPara && figurinha && fs.existsSync(figurinha)) {
        await msg.enviarFigurinhaPara(r.grupo.chat_id, figurinha);
      }
    } catch (err) {
      return msg.reply(`⚠️ Não consegui mandar no grupo (${err.message}).`);
    }
    // Disparo manual não carimba o lembrete_em — o recado diário automático
    // segue o cronograma dele normalmente
    return msg.reply(
      `📣 Cobrança mandada pro grupo (${alvo.length} na mira${soPromovidos ? ', só quem subiu da espera' : ''}). O lembrete diário automático não foi afetado.`
    );
  }

  const matchRenomearDe = texto.match(REGEX_RENOMEAR_DE);
  if (matchRenomearDe) {
    const aviso = grupoEngoliuPosicao(matchRenomearDe[1], matchRenomearDe[2], `#renomearde ${matchRenomearDe[1]} ${matchRenomearDe[2]} 5 Nome Certo`);
    if (aviso) return msg.reply(aviso);
    const r = resolverGrupo(matchRenomearDe[1]);
    if (r.mensagem) return msg.reply(r.mensagem);
    const lista = db.getListaMaisRecente(r.grupo.chat_id);
    if (!lista) return msg.reply(`*${r.grupo.nome || r.grupo.chat_id}* ainda não tem lista.`);

    const resultado = db.renomearEntradaPorPosicao(lista.id, parseInt(matchRenomearDe[2], 10), matchRenomearDe[3]);
    if (resultado.erro === 'posicao_invalida') {
      return msg.reply(`Não achei ninguém na posição ${matchRenomearDe[2]} da lista ${lista.data_jogo}. Confere com *#listade*.`);
    }
    if (resultado.erro) return msg.reply('Falta o nome novo. Ex: *#renomearde riachuelo 5 Nome Certo*');

    // Correção é silenciosa (igual ao #editarlistade): se quiser mostrar a
    // lista corrigida no grupo, é só reenviar com #listade
    await msg.reply(`✏️ Posição ${matchRenomearDe[2]}: *${resultado.antes}* → *${resultado.depois}*. Posição e pagamento intactos.`);
    return msg.reply(db.montarListaFormatada(lista.id, lista.data_jogo));
  }

  const matchAdicionarDe = texto.match(REGEX_ADICIONAR_DE);
  if (matchAdicionarDe) {
    const separado = separarGrupoENome(matchAdicionarDe[1]);
    if (!separado.nome) return msg.reply('Falta o nome. Ex: *#adicionarde riachuelo Joao Convidado*');
    const r = resolverGrupo(separado.termo);
    if (r.mensagem) return msg.reply(r.mensagem);
    const lista = db.getListaMaisRecente(r.grupo.chat_id);
    if (!lista) return msg.reply(`*${r.grupo.nome || r.grupo.chat_id}* ainda não tem lista.`);

    const nome = separado.nome;
    const quieto = Boolean(matchAdicionarDe[2]);
    if (db.acharEntradasPorNome(lista.id, nome).length > 0) {
      return msg.reply(`*${nome}* já está na lista de ${lista.data_jogo}.`);
    }
    const devendo = db.ehInadimplente(r.grupo.chat_id, null, nome);
    if (devendo) {
      return msg.reply(`⛔ *${nome}* está na lista de inadimplentes. Resolve com *#quitado* no grupo antes de colocar de volta.`);
    }

    // Número sintético: convidado colocado pela mão do admin não tem
    // WhatsApp vinculado (se ele mesmo mandar #lista, aí sim vincula)
    const resultado = db.adicionarEntrada(lista.id, nome, `manual-${Date.now()}@bot`);
    if (resultado.erro === "tudo_lotado") {
      return msg.reply(`Lista de ${lista.data_jogo} lotada (principal + espera). Tira alguém com *#removerde* antes.`);
    }
    const ondeEntrou = resultado.tipo === "principal"
      ? `na *principal* (posição ${resultado.posicao})`
      : `na *espera* (posição ${resultado.posicao})`;

    if (!quieto && msg.enviarPara) {
      try {
        await msg.enviarPara(r.grupo.chat_id, `✅ *${nome}* entrou ${ondeEntrou} — convidado(a).`);
        await msg.enviarPara(r.grupo.chat_id, db.montarListaFormatada(lista.id, lista.data_jogo));
      } catch (err) {
        await msg.reply(`⚠️ Não consegui anunciar no grupo (${err.message}).`);
      }
    }
    await msg.reply(`✅ *${nome}* colocado ${ondeEntrou} na lista de ${lista.data_jogo}` + (quieto ? " — em silêncio." : " (anunciado no grupo)."));
    return msg.reply(db.montarListaFormatada(lista.id, lista.data_jogo));
  }

  const matchRemoverDe = texto.match(REGEX_REMOVER_DE);
  if (matchRemoverDe) {
    const aviso = grupoEngoliuPosicao(matchRemoverDe[1], matchRemoverDe[2], `#removerde ${matchRemoverDe[1]} ${matchRemoverDe[2]} 14`);
    if (aviso) return msg.reply(aviso);
    const r = resolverGrupo(matchRemoverDe[1]);
    if (r.mensagem) return msg.reply(r.mensagem);
    const lista = db.getListaMaisRecente(r.grupo.chat_id);
    if (!lista) {
      return msg.reply(`*${r.grupo.nome || r.grupo.chat_id}* ainda não tem lista.`);
    }

    // De baixo pra cima pra remoção não deslocar as posições seguintes
    const posicoes = expandirPosicoes(matchRemoverDe[2]).sort((a, b) => b - a);
    const removidos = [];
    const tinhamPago = [];
    const promovidos = [];
    const naoAchadas = [];
    for (const posicao of posicoes) {
      const resultado = db.removerPorPosicao(lista.id, posicao);
      if (resultado.erro) naoAchadas.push(posicao);
      else {
        removidos.unshift(resultado.removido);
        if (resultado.removidoTinhaPago) tinhamPago.push(resultado.removido);
        promovidos.push(...(resultado.promovidos || []));
      }
    }
    if (removidos.length === 0) {
      return msg.reply(`Não achei ninguém nessa(s) posição(ões) na lista ${lista.data_jogo}. Confere com *#listade*.`);
    }

    if (msg.enviarPara) {
      try {
        let anuncio = `❌ Saiu(ram) da lista: ${removidos.map((n) => `*${n}*`).join(', ')}.`;
        if (promovidos.length > 0) {
          anuncio += `\n⬆️ Da espera pra principal: ${promovidos.map((n) => `*${n}*`).join(', ')}!`;
        }
        await msg.enviarPara(r.grupo.chat_id, anuncio);
        await msg.enviarPara(r.grupo.chat_id, db.montarListaFormatada(lista.id, lista.data_jogo));
      } catch (err) {
        await msg.reply(`⚠️ Não consegui anunciar no grupo (${err.message}).`);
      }
    }

    const avisos = [
      naoAchadas.length > 0 ? `⚠️ Posições não encontradas: ${naoAchadas.reverse().join(', ')}.` : '',
      tinhamPago.length > 0 ? `⚠️ Atenção: ${tinhamPago.join(', ')} já tinha(m) pago ✅!` : '',
    ].filter(Boolean).join(' ');
    return msg.reply(
      `❌ ${removidos.length} removido(s) da lista ${lista.data_jogo} (anunciado no grupo).${avisos ? ` ${avisos}` : ''}`
    );
  }

  const matchEditarListaDe = texto.match(REGEX_EDITAR_LISTA_DE);
  if (matchEditarListaDe) {
    const r = resolverGrupo(matchEditarListaDe[1]);
    if (r.mensagem) return msg.reply(r.mensagem);
    const lista = db.getListaMaisRecente(r.grupo.chat_id);
    if (!lista) {
      return msg.reply(`*${r.grupo.nome || r.grupo.chat_id}* ainda não tem lista.`);
    }
    const resultado = db.editarLista(lista.id, {
      dataJogo: matchEditarListaDe[2],
      nome: matchEditarListaDe[3]?.trim() || null,
    });
    if (resultado.erro === 'data_ocupada') {
      return msg.reply(`Já existe outra lista de *${matchEditarListaDe[2]}* nesse grupo. Cancela ela antes ou escolhe outra data.`);
    }
    // Correção é silenciosa no grupo: quem quiser reanuncia com #listade
    return msg.reply(
      `✏️ Lista corrigida: *${resultado.antes.data_jogo}*${resultado.antes.nome ? ` (${resultado.antes.nome})` : ''} → *${resultado.lista.data_jogo}*${resultado.lista.nome ? ` (${resultado.lista.nome})` : ''}. Ninguém saiu da lista.\n\n${db.montarListaFormatada(lista.id, resultado.lista.data_jogo)}`
    );
  }

  const matchReabrirListaDe = texto.match(REGEX_REABRIR_LISTA_DE);
  if (matchReabrirListaDe) {
    const r = resolverGrupo(matchReabrirListaDe[1]);
    if (r.mensagem) return msg.reply(r.mensagem);
    const lista = db.getListaMaisRecente(r.grupo.chat_id);
    if (!lista) return msg.reply(`*${r.grupo.nome || r.grupo.chat_id}* ainda não tem lista.`);
    db.reabrirLista(lista.id);
    const quieto = Boolean(matchReabrirListaDe[2]);
    if (!quieto && msg.enviarPara) {
      try {
        await msg.enviarPara(r.grupo.chat_id, `🔓 Lista de *${lista.data_jogo}* reaberta — pode mandar *#lista* de novo.`);
      } catch (err) {
        await msg.reply(`⚠️ Não consegui anunciar no grupo (${err.message}).`);
      }
    }
    return msg.reply(`🔓 Lista de *${lista.data_jogo}* de *${r.grupo.nome || r.grupo.chat_id}* reaberta` + (quieto ? ' — em silêncio.' : ' (anunciado no grupo).'));
  }

  const matchEncerrarListaDe = texto.match(REGEX_ENCERRAR_LISTA_DE);
  if (matchEncerrarListaDe) {
    const r = resolverGrupo(matchEncerrarListaDe[1]);
    if (r.mensagem) return msg.reply(r.mensagem);
    const lista = db.getListaAtiva(r.grupo.chat_id);
    if (!lista) {
      return msg.reply(`*${r.grupo.nome || r.grupo.chat_id}* não tem lista aberta pra encerrar.`);
    }
    db.encerrarLista(lista.id);
    if (!matchEncerrarListaDe[2] && msg.enviarPara) {
      try {
        await msg.enviarPara(
          r.grupo.chat_id,
          `🔒 Lista ${lista.nome ? `*${lista.nome}* ` : ''}do dia *${lista.data_jogo}* encerrada — não aceita mais nomes.`
        );
      } catch (err) {
        await msg.reply(`⚠️ Não consegui anunciar no grupo (${err.message}).`);
      }
    }
    await msg.reply(`🔒 Lista de *${lista.data_jogo}* de *${r.grupo.nome || r.grupo.chat_id}* encerrada${matchEncerrarListaDe[2] ? ' — em silêncio, o grupo não foi avisado.' : ' (anunciado no grupo).'} Cobrança, times e #pagode seguem funcionando.`);
    return msg.reply(db.montarListaFormatada(lista.id, lista.data_jogo));
  }

  const matchCancelarListaDe = texto.match(REGEX_CANCELAR_LISTA_DE);
  if (matchCancelarListaDe) {
    const r = resolverGrupo(matchCancelarListaDe[1]);
    if (r.mensagem) return msg.reply(r.mensagem);
    const resultado = db.cancelarLista(r.grupo.chat_id);
    if (resultado.erro === 'sem_lista') {
      return msg.reply(`*${r.grupo.nome || r.grupo.chat_id}* não tem lista pra cancelar.`);
    }
    if (msg.enviarPara) {
      try {
        await msg.enviarPara(
          r.grupo.chat_id,
          `🚫 A lista ${resultado.nome ? `*${resultado.nome}* ` : ''}de *${resultado.data_jogo}* foi cancelada.`
        );
      } catch (err) {
        await msg.reply(`⚠️ Não consegui anunciar no grupo (${err.message}).`);
      }
    }
    return msg.reply(
      `🚫 Lista de *${resultado.data_jogo}* de *${r.grupo.nome || r.grupo.chat_id}* cancelada e apagada (${resultado.entradas} entrada(s)). A data ficou livre pra recriar.`
    );
  }

  const matchListaDe = texto.match(REGEX_LISTA_DE);
  if (matchListaDe) {
    const r = resolverGrupo(matchListaDe[1]);
    if (r.mensagem) return msg.reply(r.mensagem);
    // Mostra a última lista mesmo encerrada — é a visão gerencial
    const lista = db.getListaMaisRecente(r.grupo.chat_id);
    if (!lista) {
      return msg.reply(`*${r.grupo.nome || r.grupo.chat_id}*: nenhuma lista criada ainda.`);
    }
    const marcaEncerrada = lista.status === 'encerrada' ? ' 🔒 (encerrada)' : '';
    return msg.reply(`🏐 *${r.grupo.nome || r.grupo.chat_id}*${marcaEncerrada}\n\n${db.montarListaFormatada(lista.id, lista.data_jogo)}`);
  }

  const matchPagosDe = texto.match(REGEX_PAGOS_DE);
  if (matchPagosDe) {
    const r = resolverGrupo(matchPagosDe[1]);
    if (r.mensagem) return msg.reply(r.mensagem);
    // Última lista mesmo encerrada: a conciliação vem depois do jogo
    const lista = db.getListaMaisRecente(r.grupo.chat_id);
    if (!lista) {
      return msg.reply(`*${r.grupo.nome || r.grupo.chat_id}*: nenhuma lista criada ainda.`);
    }
    const resumo = db.resumoPagamentos(lista.id);
    const marcaEncerrada = lista.status === 'encerrada' ? ' 🔒 encerrada' : '';
    const tituloLista = lista.nome ? `*${lista.nome}* — ${lista.data_jogo}` : `lista ${lista.data_jogo}`;

    let resposta = `💰 *Pagamentos — ${r.grupo.nome || r.grupo.chat_id}*\n`;
    resposta += `📋 ${tituloLista}${marcaEncerrada}\n`;
    resposta += `\n✅ ${resumo.emDia}/${resumo.totalCobrados} em dia (espera não deve ainda)`;
    if (resumo.mensalistasNaLista > 0) {
      resposta += `\n🗓 ${resumo.mensalistasNaLista} mensalista(s) — contam pelo mês pago`;
    }
    resposta += `\n`;
    if (resumo.valorCentavos > 0) {
      resposta += `\n💵 Arrecadado na lista: *${db.formatarReais(resumo.arrecadadoCentavos)}* (${db.formatarReais(resumo.valorCentavos)}/pessoa)`;
    } else {
      resposta += `\n💵 Lista sem valor definido — define com *#valorlistade <grupo> 25*`;
    }
    resposta += `\n`;
    if (resumo.pendentes.length > 0) {
      resposta += `\n⏳ Faltam: ${resumo.pendentes.join(', ')}`;
    } else if (resumo.totalCobrados > 0) {
      resposta += `\n🎉 Todo mundo em dia!`;
    }
    return msg.reply(resposta);
  }

  const matchMensalistasDe = texto.match(REGEX_MENSALISTAS_DE);
  if (matchMensalistasDe) {
    const r = resolverGrupo(matchMensalistasDe[1]);
    if (r.mensagem) return msg.reply(r.mensagem);
    const resumo = db.resumoMensalistas(r.grupo.chat_id);
    let resposta = `🏐 *${r.grupo.nome || r.grupo.chat_id}*\n\n${db.montarMensalistasFormatado(r.grupo.chat_id)}`;
    if (resumo.arrecadadoMesCentavos > 0) {
      resposta += `\n💵 Arrecadado no mês: *${db.formatarReais(resumo.arrecadadoMesCentavos)}*`;
    }
    return msg.reply(resposta);
  }

  // Guard compartilhado dos comandos remotos com posição: nome de grupo que
  // termina em número (ex: "Quadra 7") engoliria a posição do mensalista
  function grupoEngoliuPosicao(termo, posicao, exemplo) {
    const inteiro = `${termo} ${posicao}`.trim();
    if (db.buscarGrupos(inteiro).length > 0) {
      return `"${inteiro}" parece ser o nome do grupo — faltou a posição do mensalista. Ex: *${exemplo}*`;
    }
    return null;
  }

  const matchAbrirMensalistas = texto.match(REGEX_ABRIR_MENSALISTAS_DE);
  const matchFecharMensalistas = matchAbrirMensalistas ? null : texto.match(REGEX_FECHAR_MENSALISTAS_DE);
  if (matchAbrirMensalistas || matchFecharMensalistas) {
    const abrir = Boolean(matchAbrirMensalistas);
    const m = matchAbrirMensalistas || matchFecharMensalistas;
    const quieto = Boolean(m[2]);
    const r = resolverGrupo(m[1]);
    if (r.mensagem) return msg.reply(r.mensagem);
    const nomeGrupo = r.grupo.nome || r.grupo.chat_id;
    db.abrirPreLista(r.grupo.chat_id, abrir);

    const resumo = db.resumoMensalistas(r.grupo.chat_id);
    const vagas = Math.max(0, resumo.limite - resumo.total);
    const anuncio = abrir
      ? `🗓 *Inscrições de mensalista abertas!* ${vagas} vaga(s) + fila de espera.\n\nManda *#mensalista* pra garantir a tua. Pagamento até o 5º dia útil com os admins — o ✅ é o que confirma a vaga.`
      : `🗓 *Inscrições de mensalista encerradas.* Quem garantiu, garantiu — agora é acertar o pagamento com os admins.`;
    let aviso = '';
    if (!quieto && msg.enviarPara) {
      try {
        await msg.enviarPara(r.grupo.chat_id, anuncio);
      } catch (err) {
        aviso = `\n⚠️ Não consegui anunciar no grupo (${err.message}).`;
      }
    }
    await msg.reply(
      `🗓 Inscrições de *${nomeGrupo}* ${abrir ? 'abertas' : 'fechadas'}${quieto ? ' — em silêncio, o grupo não foi avisado.' : ' e anunciadas no grupo.'}${aviso}`
    );
    return msg.reply(db.montarMensalistasFormatado(r.grupo.chat_id));
  }

  const matchReiniciarMensalistas = texto.match(REGEX_REINICIAR_MENSALISTAS_DE);
  if (matchReiniciarMensalistas) {
    const r = resolverGrupo(matchReiniciarMensalistas[1]);
    if (r.mensagem) return msg.reply(r.mensagem);
    const { removidos } = db.reiniciarMensalistas(r.grupo.chat_id);
    await msg.reply(
      `♻️ Quadro de mensalistas de *${r.grupo.nome || r.grupo.chat_id}* reiniciado: ${removidos} não-fixo(s) removido(s), inscrições fechadas. Fixos mantidos (pendentes até pagar). Abre a rodada nova com *#abrirmensalistasde*.`
    );
    return msg.reply(db.montarMensalistasFormatado(r.grupo.chat_id));
  }

  const matchPagoMesDe = texto.match(REGEX_PAGO_MES_DE);
  const matchNaoPagoMesDe = matchPagoMesDe ? null : texto.match(REGEX_NAOPAGO_MES_DE);
  if (matchPagoMesDe || matchNaoPagoMesDe) {
    const m = matchPagoMesDe || matchNaoPagoMesDe;
    const marcar = Boolean(matchPagoMesDe);
    const aviso = grupoEngoliuPosicao(m[1], m[2], `#pagomesde ${m[1]} ${m[2]} 3`);
    if (aviso) return msg.reply(aviso);
    const r = resolverGrupo(m[1]);
    if (r.mensagem) return msg.reply(r.mensagem);
    const valor = marcar
      ? (m[3] ? db.paraCentavos(m[3]) : (r.grupo.valor_mes_centavos || 0))
      : 0;

    const marcados = [];
    const naoAchadas = [];
    for (const posicao of expandirPosicoes(m[2])) {
      const resultado = db.marcarMesPagoPorPosicao(r.grupo.chat_id, posicao, marcar, valor);
      if (resultado.erro) naoAchadas.push(posicao);
      else marcados.push(resultado);
    }
    if (marcados.length === 0) {
      return msg.reply(`Não achei mensalista nessa(s) posição(ões) em *${r.grupo.nome || r.grupo.chat_id}*. Confere com *#mensalistasde*.`);
    }

    // Pagamento confirmado é notícia pro grupo — em lote, um anúncio só.
    // Fixo já tem vaga cativa (anúncio é só a quitação); pro não-fixo o ✅
    // é o que confirma a vaga de mensalista.
    if (marcar && msg.enviarPara) {
      try {
        const nomes = marcados.map((x) => `*${x.nome}*${x.fixo ? ' 📌' : ''}`).join(', ');
        const temNaoFixo = marcados.some((x) => !x.fixo);
        const anuncio = marcados.length === 1
          ? (marcados[0].fixo
            ? `🗓 *${marcados[0].nome}* (fixo 📌) pagou o mês! ✅`
            : `🗓 *${marcados[0].nome}* pagou o mês e tá confirmado(a) como mensalista! ✅ Vaga garantida nas listas a partir de agora.`)
          : `🗓 *Pagaram o mês:* ${nomes} ✅${temNaoFixo ? '\nMensalistas confirmados — vaga garantida nas próximas listas!' : ''}`;
        await msg.enviarPara(r.grupo.chat_id, anuncio);
        const figurinha = acharFigurinhaQuitado();
        if (msg.enviarFigurinhaPara && figurinha && fs.existsSync(figurinha)) {
          await msg.enviarFigurinhaPara(r.grupo.chat_id, figurinha);
        }
      } catch (err) {
        await msg.reply(`⚠️ Não consegui anunciar no grupo (${err.message}).`);
      }
    }

    const resumoErros = naoAchadas.length > 0 ? ` ⚠️ Posições não encontradas: ${naoAchadas.join(', ')}.` : '';
    await msg.reply(marcar
      ? (marcados.length === 1
        ? `🗓 ${marcados[0].nome} pagou o mês! ✅ (anunciado no grupo)${resumoErros}`
        : `🗓 ${marcados.length} mensalidades marcadas ✅ (anunciado no grupo).${resumoErros}`)
      : (marcados.length === 1
        ? `↩️ Mensalidade de ${marcados[0].nome} desmarcada.${resumoErros}`
        : `↩️ ${marcados.length} mensalidades desmarcadas.${resumoErros}`));
    return msg.reply(db.montarMensalistasFormatado(r.grupo.chat_id));
  }

  const matchPagoDe = texto.match(REGEX_PAGO_DE);
  const matchNaoPagoDe = matchPagoDe ? null : texto.match(REGEX_NAOPAGO_DE);
  if (matchPagoDe || matchNaoPagoDe) {
    const m = matchPagoDe || matchNaoPagoDe;
    const marcar = Boolean(matchPagoDe);
    const aviso = grupoEngoliuPosicao(m[1], m[2], `#pagode ${m[1]} ${m[2]} 3`);
    if (aviso) return msg.reply(aviso);
    const r = resolverGrupo(m[1]);
    if (r.mensagem) return msg.reply(r.mensagem);
    const lista = db.getListaMaisRecente(r.grupo.chat_id);
    if (!lista) {
      return msg.reply(`*${r.grupo.nome || r.grupo.chat_id}* ainda não tem lista.`);
    }

    const marcados = [];
    const naoAchadas = [];
    for (const posicao of expandirPosicoes(m[2])) {
      const resultado = db.marcarPagoPorPosicao(lista.id, posicao, marcar);
      if (resultado.erro) naoAchadas.push(posicao);
      else marcados.push(resultado);
    }
    if (marcados.length === 0) {
      return msg.reply(`Não achei ninguém nessa(s) posição(ões) na lista ${lista.data_jogo}. Confere com *#listade*.`);
    }

    if (marcar && msg.enviarPara) {
      try {
        await msg.enviarPara(
          r.grupo.chat_id,
          `💰 Pagamento confirmado: ${marcados.map((x) => `*${x.nome}*`).join(', ')} ✅`
        );
        const figurinha = acharFigurinhaQuitado();
        if (msg.enviarFigurinhaPara && figurinha && fs.existsSync(figurinha)) {
          await msg.enviarFigurinhaPara(r.grupo.chat_id, figurinha);
        }
      } catch (err) {
        await msg.reply(`⚠️ Não consegui anunciar no grupo (${err.message}).`);
      }
    }

    const resumoErros = naoAchadas.length > 0 ? ` ⚠️ Posições não encontradas: ${naoAchadas.join(', ')}.` : '';
    await msg.reply(marcar
      ? `💰 ${marcados.length} pagamento(s) marcados ✅ (anunciado no grupo).${resumoErros}`
      : `↩️ ${marcados.length} pagamento(s) desmarcados.${resumoErros}`);
    return msg.reply(db.montarListaFormatada(lista.id, lista.data_jogo));
  }

  const matchFixoDe = texto.match(REGEX_FIXO_DE);
  if (matchFixoDe) {
    const aviso = grupoEngoliuPosicao(matchFixoDe[1], matchFixoDe[2], `#fixode ${matchFixoDe[1]} ${matchFixoDe[2]} 3`);
    if (aviso) return msg.reply(aviso);
    const r = resolverGrupo(matchFixoDe[1]);
    if (r.mensagem) return msg.reply(r.mensagem);
    const resultado = db.alternarFixoPorPosicao(r.grupo.chat_id, parseInt(matchFixoDe[2], 10));
    if (resultado.erro) {
      return msg.reply(`Não achei mensalista na posição ${matchFixoDe[2]} de *${r.grupo.nome || r.grupo.chat_id}*.`);
    }
    await msg.reply(resultado.fixo
      ? `📌 ${resultado.nome} agora é fixo — vaga cativa.`
      : `${resultado.nome} deixou de ser fixo.`);
    return msg.reply(db.montarMensalistasFormatado(r.grupo.chat_id));
  }

  const matchRemoverMensalistaDe = texto.match(REGEX_REMOVER_MENSALISTA_DE);
  if (matchRemoverMensalistaDe) {
    const aviso = grupoEngoliuPosicao(matchRemoverMensalistaDe[1], matchRemoverMensalistaDe[2], `#removermensalistade ${matchRemoverMensalistaDe[1]} ${matchRemoverMensalistaDe[2]} 3`);
    if (aviso) return msg.reply(aviso);
    const r = resolverGrupo(matchRemoverMensalistaDe[1]);
    if (r.mensagem) return msg.reply(r.mensagem);
    // De baixo pra cima: cada remoção desloca as posições seguintes, então
    // processar em ordem decrescente mantém as posições restantes válidas
    const posicoes = expandirPosicoes(matchRemoverMensalistaDe[2]).sort((a, b) => b - a);
    const removidos = [];
    const promovidos = [];
    const naoAchadas = [];
    for (const posicao of posicoes) {
      const resultado = db.removerMensalistaPorPosicao(r.grupo.chat_id, posicao);
      if (resultado.erro) naoAchadas.push(posicao);
      else {
        removidos.unshift(resultado.nome); // exibe em ordem crescente de posição
        if (resultado.promovido) promovidos.push(resultado.promovido);
      }
    }
    if (removidos.length === 0) {
      return msg.reply(`Não achei mensalista nessa(s) posição(ões) em *${r.grupo.nome || r.grupo.chat_id}*.`);
    }

    const resumoErros = naoAchadas.length > 0 ? ` ⚠️ Posições não encontradas: ${naoAchadas.reverse().join(', ')}.` : '';
    await msg.reply(removidos.length === 1
      ? `❌ ${removidos[0]} saiu do quadro de mensalistas.${resumoErros}`
      : `❌ Saíram do quadro: ${removidos.join(', ')}.${resumoErros}`);
    for (const promovido of promovidos) {
      await msg.reply(`⬆️ ${promovido} subiu da espera pra vaga mensal — falta o pagamento pra confirmar.`);
    }
    return msg.reply(db.montarMensalistasFormatado(r.grupo.chat_id));
  }

  const matchMensalistaDe = texto.match(REGEX_MENSALISTA_DE);
  if (matchMensalistaDe) {
    const r = resolverGrupo(matchMensalistaDe[1]);
    if (r.mensagem) return msg.reply(r.mensagem);
    const nome = matchMensalistaDe[2].trim();
    // Dedup por nome: o cadastro remoto não tem o WhatsApp da pessoa
    const jaExiste = db.listarMensalistas(r.grupo.chat_id)
      .some((m) => m.nome.trim().toLowerCase() === nome.toLowerCase());
    if (jaExiste) {
      return msg.reply(`${nome} já está no quadro de *${r.grupo.nome || r.grupo.chat_id}*.`);
    }
    const resultado = db.adicionarMensalista(r.grupo.chat_id, nome, `manual-${Date.now()}@bot`);
    await msg.reply(resultado.espera
      ? `⏳ Vagas cheias — ${nome} entrou na espera dos mensalistas (posição ${resultado.posicao}).`
      : `🗓 ${nome} entrou no quadro (vaga ${resultado.posicao}/${resultado.limite}). Obs: sem vínculo com o WhatsApp dele — se a pessoa mandar *#mensalista* no grupo, remove este e deixa o dela.`);
    return msg.reply(db.montarMensalistasFormatado(r.grupo.chat_id));
  }

  const matchValorMesDe = texto.match(REGEX_VALOR_MES_DE);
  if (matchValorMesDe) {
    if (nomeEngoliuValor(matchValorMesDe[1], matchValorMesDe[2])) {
      return msg.reply(`"${matchValorMesDe[1]} ${matchValorMesDe[2]}" parece ser o nome do grupo — faltou o valor. Ex: *#valormesde ${matchValorMesDe[1]} ${matchValorMesDe[2]} 53*`);
    }
    const r = resolverGrupo(matchValorMesDe[1]);
    if (r.mensagem) return msg.reply(r.mensagem);
    const centavos = db.paraCentavos(matchValorMesDe[2]);
    db.setarValorMes(r.grupo.chat_id, centavos);
    return msg.reply(centavos === 0
      ? `💰 Mensalidade de *${r.grupo.nome || r.grupo.chat_id}* removida.`
      : `💰 Mensalidade de *${r.grupo.nome || r.grupo.chat_id}*: ${db.formatarReais(centavos)} (padrão do #pagomesde).`);
  }

  const matchVagasMensalistasDe = texto.match(REGEX_VAGAS_MENSALISTAS_DE);
  if (matchVagasMensalistasDe) {
    const aviso = grupoEngoliuPosicao(matchVagasMensalistasDe[1], matchVagasMensalistasDe[2], `#vagasmensalistasde ${matchVagasMensalistasDe[1]} ${matchVagasMensalistasDe[2]} 12`);
    if (aviso) return msg.reply(aviso);
    const r = resolverGrupo(matchVagasMensalistasDe[1]);
    if (r.mensagem) return msg.reply(r.mensagem);
    const vagas = parseInt(matchVagasMensalistasDe[2], 10);
    if (vagas < 1) return msg.reply('O número de vagas precisa ser pelo menos 1.');
    db.setarLimiteMensalistas(r.grupo.chat_id, vagas);
    return msg.reply(`🗓 Vagas de mensalista de *${r.grupo.nome || r.grupo.chat_id}*: *${vagas}*.`);
  }

  const matchAdminsDe = texto.match(REGEX_ADMINS_DE);
  if (matchAdminsDe) {
    const r = resolverGrupo(matchAdminsDe[1]);
    if (r.mensagem) return msg.reply(r.mensagem);
    if (!msg.getAdminsDoGrupo) {
      return msg.reply('Consulta de admins indisponível nesta sessão.');
    }
    try {
      const admins = await msg.getAdminsDoGrupo(r.grupo.chat_id);
      if (!admins || admins.length === 0) {
        return msg.reply(`Não achei admins em *${r.grupo.nome || r.grupo.chat_id}* — o bot está nesse grupo?`);
      }
      const linhas = admins.map((a) => `• ${String(a).replace(/@.+$/, '')}`).join('\n');
      return msg.reply(`👑 *Admins de ${r.grupo.nome || r.grupo.chat_id}* (${admins.length}) — são eles que podem marcar #pago lá:\n${linhas}`);
    } catch (err) {
      return msg.reply(`Não consegui consultar os admins de *${r.grupo.nome || r.grupo.chat_id}* (${err.message}). O bot está nesse grupo?`);
    }
  }

  // "#valorde Quadra 7" com o valor esquecido: o 7 é parte do NOME do grupo,
  // não um preço — se o argumento inteiro bate com algum grupo, pede o valor
  // em vez de gravar preço errado.
  function nomeEngoliuValor(termo, valor) {
    return db.buscarGrupos(`${termo} ${valor}`.trim()).length > 0;
  }

  const matchValorDe = texto.match(REGEX_VALOR_DE);
  if (matchValorDe) {
    if (nomeEngoliuValor(matchValorDe[1], matchValorDe[2])) {
      return msg.reply(`"${matchValorDe[1]} ${matchValorDe[2]}" parece ser o nome do grupo — faltou o valor. Ex: *#valorde ${matchValorDe[1]} ${matchValorDe[2]} 25*`);
    }
    const r = resolverGrupo(matchValorDe[1]);
    if (r.mensagem) return msg.reply(r.mensagem);
    const centavos = db.paraCentavos(matchValorDe[2]);
    db.setarValorPadraoGrupo(r.grupo.chat_id, centavos);
    if (centavos === 0) {
      return msg.reply(`💰 Valor padrão de *${r.grupo.nome || r.grupo.chat_id}* removido — próximas listas sem cobrança.`);
    }
    return msg.reply(
      `💰 Valor padrão de *${r.grupo.nome || r.grupo.chat_id}*: ${db.formatarReais(centavos)} por pessoa. Vale pras próximas listas — pra lista aberta agora, usa *#valorlistade*.`
    );
  }

  const matchValorListaDe = texto.match(REGEX_VALOR_LISTA_DE);
  if (matchValorListaDe) {
    if (nomeEngoliuValor(matchValorListaDe[1], matchValorListaDe[2])) {
      return msg.reply(`"${matchValorListaDe[1]} ${matchValorListaDe[2]}" parece ser o nome do grupo — faltou o valor. Ex: *#valorlistade ${matchValorListaDe[1]} ${matchValorListaDe[2]} 30*`);
    }
    const r = resolverGrupo(matchValorListaDe[1]);
    if (r.mensagem) return msg.reply(r.mensagem);
    const lista = db.getListaMaisRecente(r.grupo.chat_id);
    if (!lista) {
      return msg.reply(`*${r.grupo.nome || r.grupo.chat_id}* ainda não tem lista. Pro padrão das próximas, usa *#valorde*.`);
    }
    const centavos = db.paraCentavos(matchValorListaDe[2]);
    db.setarValorLista(lista.id, centavos);
    if (centavos === 0) {
      return msg.reply(`💰 Valor da lista *${lista.data_jogo}* de *${r.grupo.nome || r.grupo.chat_id}* removido — sem cobrança.`);
    }
    return msg.reply(`💰 Lista *${lista.data_jogo}* de *${r.grupo.nome || r.grupo.chat_id}*: ${db.formatarReais(centavos)} por pessoa.`);
  }

  const matchGrupoAdmin = texto.match(REGEX_GRUPO_ADMIN);
  if (matchGrupoAdmin) {
    // Só no privado: senão qualquer um num grupo promovido poderia promover outros
    if (msg.origem !== 'privado') {
      return msg.reply('Por segurança, *#grupoadmin* só funciona no privado com o admin do bot.');
    }
    const chatId = matchGrupoAdmin[1];
    const desligar = Boolean(matchGrupoAdmin[2]);
    // Grupo com lista aberta é grupo de pelada — virar admin por engano
    // silencia os comandos de lista e deixa os pagamentos imarcáveis
    if (!desligar && db.getListaAtiva(chatId)) {
      return msg.reply('Esse grupo tem uma lista aberta — parece grupo de pelada, não de admins. Se tiver certeza, encerra a lista lá primeiro.');
    }
    const ok = db.marcarGrupoAdmin(chatId, !desligar);
    if (!ok) {
      return msg.reply('Não achei nenhum grupo com esse chat_id. Confere com *#listargrupos*.');
    }
    return msg.reply(desligar
      ? `🛠 Grupo ${chatId} deixou de ser grupo de admins.`
      : `🛠 Grupo ${chatId} agora é grupo de admins! Todo mundo lá pode usar os comandos remotos (#listade, #pagosde, #adminsde, #valorde...). Manda *#admin* lá pra ver tudo.`);
  }

  if (texto.toLowerCase() === CMD_AJUDA_ADMIN) {
    return msg.reply(TEXTO_AJUDA_ADMIN);
  }

  // #comandos no contexto admin = ajuda completa, em duas mensagens:
  // o que existe no grupo da pelada e o arsenal remoto daqui
  if (texto.toLowerCase() === '#comandos') {
    await msg.reply(`${TEXTO_AJUDA_COMUM}${TEXTO_AJUDA_ADMIN_GRUPO}`);
    return msg.reply(TEXTO_AJUDA_ADMIN);
  }

  // Qualquer variação dos comandos acima que não casou é sintaxe errada
  // (ex: "18 -6", "#listade" sem grupo, "#listargrupos x") — responde com o
  // uso em vez de ficar mudo e deixar o admin achando que funcionou
  if (/^#(ativargrupo|desativargrupo|abrirlistade|editarlistade|encerrarlistade|reabrirlistade|cancelarlistade|listade|pagosde|adminsde|mensalistasde|mensalistade|abrirmensalistasde|fecharmensalistasde|reiniciarmensalistasde|pagomesde|naopagomesde|pagode|naopagode|removerde|adicionarde|renomearde|cobrarde|cobrarsubiude|timesde|importarelencode|fixode|removermensalistade|valormesde|vagasmensalistasde|valorde|valorlistade|grupoadmin|listargrupos|admin)\b/i.test(texto)) {
    return msg.reply(
      `Não entendi o formato 🤔 Exemplos:\n*#ativargrupo <chat_id> 18 --6*\n*#listade quinta* · *#pagosde quinta* · *#valorde quinta 25*\nManda *#admin* pra ver a sintaxe de tudo.`
    );
  }

  // Comando do grupo de pelada digitado no contexto admin (ex: responder um
  // comprovante encaminhado com #pago) — aponta o equivalente remoto
  if (/^#(pago|naopago|valor|valorpadr[aã]o|valormes|mostralista|remover|encerrarlista|lista|mensalistas?|pagomes|naopagomes|fixo|removermensalista|vagasmensalistas|inadimplente|quitado)\b/i.test(texto)) {
    return msg.reply(
      `Esse comando funciona dentro do grupo da pelada. Aqui os equivalentes são remotos: *#listade <grupo>*, *#pagosde <grupo>*, *#valorlistade <grupo> 30*... Manda *#admin* pra ver tudo.`
    );
  }
}

module.exports = { processarComandoAdmin };
