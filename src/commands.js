const fs = require('fs');
const path = require('path');
const db = require('./db');

// Figurinha com dedicatória: quando a pessoa está na mira da cobrança, essa
// vai no lugar do sorteio. E ela NÃO entra no sorteio geral — a graça é ser
// dedicada. Pra adicionar outra, é só mais uma linha aqui.
const FIGURINHAS_PESSOAIS = [
  { pessoa: 'Ghemison', tema: 'cade-meu-pix', arquivo: 'cade-meu-pix-antonio' },
];

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

// Todas as figurinhas de um tema: agiota-pago.png, agiota-pago-2.gif,
// agiota-pago_festa.webp... (gif e webp animado viram figurinha animada)
function listarFigurinhas(nomeBase) {
  const pasta = path.join(__dirname, '..', 'assets');
  let arquivos;
  try {
    arquivos = fs.readdirSync(pasta);
  } catch {
    return [];
  }
  const base = String(nomeBase).toLowerCase();
  // as dedicadas ficam de fora do sorteio (a não ser que sejam o próprio tema pedido)
  const dedicadas = FIGURINHAS_PESSOAIS.map((f) => f.arquivo.toLowerCase()).filter((a) => a !== base);
  return arquivos
    .filter((a) => {
      const nome = a.toLowerCase();
      const ext = nome.slice(nome.lastIndexOf('.'));
      if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return false;
      const semExt = nome.slice(0, nome.lastIndexOf('.'));
      if (dedicadas.includes(semExt)) return false;
      // aceita o nome exato ou com sufixo separado por - ou _
      return semExt === base || semExt.startsWith(base + '-') || semExt.startsWith(base + '_');
    })
    .sort()
    .map((a) => path.join(pasta, a));
}

// Uma figurinha por vez, sorteada — assim não fica repetitivo
function acharFigurinha(nomeBase) {
  const todas = listarFigurinhas(nomeBase);
  if (todas.length === 0) return null;
  return todas[Math.floor(Math.random() * todas.length)];
}

// Cobrança: se alguém com figurinha dedicada está na mira, ela ganha do
// sorteio; senão, sorteia normalmente entre as do tema
function acharFigurinhaCobranca(pendentes = []) {
  const naMira = (pendentes || []).map(semAcento);
  for (const regra of FIGURINHAS_PESSOAIS) {
    if (regra.tema !== 'cade-meu-pix') continue;
    const alvo = semAcento(regra.pessoa);
    const achou = naMira.some((nome) => nome.includes(alvo) || alvo.includes(nome));
    if (!achou) continue;
    const dedicada = listarFigurinhas(regra.arquivo);
    if (dedicada.length > 0) return dedicada[Math.floor(Math.random() * dedicada.length)];
  }
  return acharFigurinha('cade-meu-pix');
}

// Figurinha comemorativa dos pagamentos — env FIGURINHA_QUITADO ganha do padrão
function acharFigurinhaQuitado() {
  if (process.env.FIGURINHA_QUITADO) return process.env.FIGURINHA_QUITADO;
  return acharFigurinha('agiota-pago');
}

// Textos de cobrança — usados pelo lembrete diário automático (bot.js) e
// pelos disparos manuais #cobrarde / #cobrarsubiude (adminCommands.js)
// Marca quem tem WhatsApp conhecido (@numero vira menção no WhatsApp) e
// deixa o nome cru pra quem foi cadastrado na mão
function comMencoes(pessoas) {
  const lista = (pessoas || []).map((p) => (typeof p === 'string' ? { nome: p, numero: null } : p));
  const mencoes = [];
  const partes = lista.map((p) => {
    if (!p.numero) return p.nome;
    mencoes.push(p.numero);
    return '@' + String(p.numero).split('@')[0];
  });
  return { texto: partes.join(', '), mencoes };
}

// Quem manda #lista antes da lista existir merece um cutucão carinhoso
const ZOEIRAS_SEM_LISTA = [
  'Ansiedade 2, o retorno? 😅 Ainda não tem lista aberta, meu consagrado.',
  'Calma, jovem: a lista nem nasceu ainda. Psicólogo também tem família. 🛋️',
  'Tá com o dedo mais rápido que o admin. Nenhuma lista aberta ainda! 🤠',
  'Nenhuma lista aberta. Respira, toma uma água e volta quando abrir. 💧',
  'Você chegou tão cedo que a quadra ainda tá sonhando. Sem lista por enquanto. 😴',
  'Lista fechada, coração aberto. Espera o admin abrir aí. ❤️',
  'A pressa é inimiga da perfeição — e da lista, que ainda não existe. 🐢',
  'Sem lista aberta! Mas anota aí: sua vontade de jogar tá 10/10. 🏐',
];

// Zoeira com dedicatória: quem tem nome aqui leva a versão personalizada
// (mesma turma da figurinha dedicada). Pra adicionar, é só mais uma entrada.
const ZOEIRAS_PESSOAIS = {
  ghemison: [
    'Porra, Antônio! 🤦 Nem tem lista aberta ainda e você já tá aí.',
    'Antônio, meu amigo... a lista não existe. Sua ansiedade sim. 😂',
    'De novo, Antônio? Sem lista aberta. Vai pagar a passada primeiro. 💸',
    'ANTÔNIO. Respira. Sem lista. E o pix, hein? 👀',
  ],
};

function zoeiraSemLista(quemMandou) {
  const alvo = semAcento(quemMandou);
  let opcoes = ZOEIRAS_SEM_LISTA;
  for (const [pessoa, frases] of Object.entries(ZOEIRAS_PESSOAIS)) {
    if (alvo && (alvo.includes(pessoa) || pessoa.includes(alvo))) {
      opcoes = frases;
      break;
    }
  }
  const frase = opcoes[Math.floor(Math.random() * opcoes.length)];
  return `${frase}${String.fromCharCode(10)}${String.fromCharCode(10)}_Quando um admin abrir com *#listaDD/MM*, pode mandar *#lista* que eu te coloco._`;
}

function montarLembretePagamento(pendentes) {
  const { texto: naMira, mencoes } = comMencoes(pendentes);
  const texto = (
    `⏰ *Recado do agiota* 🏐\n\n` +
    `Quem ainda não pagou a pelada da semana tem até *sexta, 12h* pra acertar — ` +
    `depois disso sai da lista e a espera assume a vaga.\n` +
    `Quem subir da espera tem até *sexta, 17h* pra pagar.\n\n` +
    `⏳ Na mira do agiota: ${naMira}\n\n` +
    `Pagou? Manda o comprovante aqui que os admins dão o ✅. O agiota agradece. 🤝`
  );
  return { texto, mencoes };
}

function montarLembreteSubiu(nomes) {
  const { texto: quem, mencoes } = comMencoes(nomes);
  const texto = (
    `📣 *Atenção, reforços!* 🏐\n\n` +
    `${quem}: vocês subiram da espera pra lista!\n` +
    `O prazo de vocês é até *sexta, 17h* pra fazer o pagamento — senão a vaga passa pro próximo da espera.\n\n` +
    `Manda o comprovante aqui que os admins dão o ✅. O agiota tá de olho. 👀`
  );
  return { texto, mencoes };
}

// Figurinha do agiota em TODO pagamento marcado — semanal, mensal ou quitação
async function celebrarPagamento(msg) {
  const figurinha = acharFigurinhaQuitado();
  if (msg.enviarFigurinha && figurinha && fs.existsSync(figurinha)) {
    await msg.enviarFigurinha(figurinha);
  }
}

// Regex pro comando de abertura: #lista05/07, #lista 05/07, e com valor e/ou
// nome opcionais: "#lista07/08 17 Sexta 3h" (valor precisa vir logo após a
// data; nome é o resto)
const REGEX_ABRIR = /^#lista\s?(\d{1,2}\/\d{1,2})(?:\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?))?(?:\s+(.+))?$/i;
// #lista sozinho, ou #lista Nome Sobrenome (nome explícito opcional)
const REGEX_ENTRAR = /^#lista(?:\s+(.+))?$/i;
const CMD_MOSTRAR = '#mostralista';
const CMD_ENCERRAR = '#encerrarlista';
const CMD_CANCELAR = '#cancelarlista';
// #editarlista 07/08 [Nome] — conserta data/nome da lista mais recente
const REGEX_EDITAR = /^#editarlista\s+(\d{1,2}\/\d{1,2})(?:\s+(.+))?$/i;
const CMD_AJUDA = '#comandos';
// #remover (sozinho ou com o próprio nome) = sair da lista, aberto a todos;
// #remover N / #remover NomeDeOutro = só admins
const REGEX_REMOVER = /^#remover(?:\s+(.+))?$/i;
// Pagamento — restritos a admins DO GRUPO no WhatsApp (+ o admin do bot).
// #pago/#naopago sem número funcionam respondendo a mensagem da pessoa (ex: o comprovante).
const REGEX_PAGO = /^#pago(?:\s+(\d{1,3}))?$/i;
const REGEX_NAOPAGO = /^#naopago(?:\s+(\d{1,3}))?$/i;
const REGEX_VALOR = /^#valor(?:\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?))?$/i;
// [aã]: o corretor do celular escreve "padrão" com acento
const REGEX_VALOR_PADRAO = /^#valorpadr[aã]o\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?)$/i;
// Mensalistas — vaga garantida no topo de toda lista, paga por mês
const CMD_MENSALISTAS = '#mensalistas';
const REGEX_MENSALISTA = /^#mensalista(?:\s+(.+))?$/i;
const REGEX_PAGO_MES = /^#pagomes\s+(\d{1,3})(?:\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?))?$/i;
const REGEX_NAOPAGO_MES = /^#naopagomes\s+(\d{1,3})$/i;
const REGEX_FIXO = /^#fixo\s+(\d{1,3})$/i;
const REGEX_REMOVER_MENSALISTA = /^#removermensalista\s+(\d{1,3})$/i;
const REGEX_VALOR_MES = /^#valormes\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?)$/i;
const REGEX_VAGAS_MENSALISTAS = /^#vagasmensalistas\s+(\d{1,3})$/i;
// Inadimplentes — exibidos na lista e bloqueados de entrar até o #quitado
const REGEX_INADIMPLENTE = /^#inadimplente\s+(.+?)(?:\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?))?$/i;
const REGEX_QUITADO = /^#quitado\s+(.+)$/i;
// Comandos de teste — só funcionam se TEST_MODE=true no .env/Railway.
// Pensados pra validar o fluxo de lotação/espera sem precisar de 22 pessoas reais.
const REGEX_TESTAR_ENCHER = /^#testarencher\s+(\d+)$/i;
const CMD_TESTAR_LIMPAR = '#testarlimpar';

const TEST_MODE = process.env.TEST_MODE === 'true';

// Ajuda em camadas: pessoa comum só vê o que pode usar; a parte de admin
// entra apenas quando quem pediu tem a permissão
const TEXTO_AJUDA_COMUM = `🏐 *Comandos do bot*

*#lista* — entra na lista ativa usando seu nome do WhatsApp
*#lista Nome* — entra na lista com um nome específico (ex: #lista João)
*#mostralista* — mostra a lista atual
*#remover* — sai da lista (também tira quem você adicionou com #lista Nome)
*#valor* — mostra o valor por pessoa da lista atual
*#mensalista* — vira candidato a mensalista (vaga garantida no topo das listas)
*#mensalistas* — mostra o quadro de mensalistas do mês
*#comandos* — mostra essa ajuda`;

const TEXTO_AJUDA_ADMIN_GRUPO = `

💰 *Só pra admins (do grupo ou do grupo de admins):*
*#listaDD/MM* — abre a lista pro dia; valor e nome opcionais: #lista07/08 17 Sexta 3h
*#encerrarlista* — fecha a lista, para de aceitar nomes
*#editarlista 07/08 Nome* — corrige a data/nome da lista (nome opcional)
*#cancelarlista* — APAGA a lista mais recente (criada errada/teste); libera a data
*#remover N* — remove quem está na posição N (ou #remover Nome)
*#pago N* — marca ✅ de quem está na posição N (ou responde o comprovante com *#pago*)
*#naopago N* — desmarca (ou respondendo a mensagem com *#naopago*)
*#valor 25* — define o valor por pessoa da lista atual (aceita 25,50)
*#valorpadrao 25* — valor padrão pras próximas listas do grupo

🗓 *Mensalistas (admins):*
*#pagomes N* — marca o mês pago do mensalista N (valor opcional: #pagomes 3 53)
*#naopagomes N* — desmarca o mês
*#fixo N* — liga/desliga vaga cativa (📌) do mensalista N
*#removermensalista N* — tira a pessoa do quadro
*#valormes 53* — mensalidade padrão · *#vagasmensalistas 12* — total de vagas

⛔ *Inadimplentes (admins):*
*#inadimplente N* — marca quem está na posição N da lista (ou #inadimplente Nome 17)
*#quitado Nome* — tira da lista de inadimplentes (ou #quitado N)`;

const TEXTO_AJUDA_TESTE = `\n\n🧪 *Comandos de teste (TEST_MODE ligado)*
*#testarencher N* — adiciona N pessoas fake na lista (ex: #testarencher 15)
*#testarlimpar* — apaga todo mundo da lista ativa, sem precisar recriar`;

function correspondeAlgumComando(texto) {
  const textoLower = texto.toLowerCase();
  const comandoNormal = (
    REGEX_ABRIR.test(texto) ||
    REGEX_ENTRAR.test(texto) ||
    REGEX_REMOVER.test(texto) ||
    REGEX_PAGO.test(texto) ||
    REGEX_NAOPAGO.test(texto) ||
    REGEX_VALOR.test(texto) ||
    REGEX_VALOR_PADRAO.test(texto) ||
    REGEX_MENSALISTA.test(texto) ||
    REGEX_PAGO_MES.test(texto) ||
    REGEX_NAOPAGO_MES.test(texto) ||
    REGEX_FIXO.test(texto) ||
    REGEX_REMOVER_MENSALISTA.test(texto) ||
    REGEX_VALOR_MES.test(texto) ||
    REGEX_VAGAS_MENSALISTAS.test(texto) ||
    REGEX_INADIMPLENTE.test(texto) ||
    REGEX_QUITADO.test(texto) ||
    textoLower === CMD_MOSTRAR ||
    textoLower === CMD_ENCERRAR ||
    textoLower === CMD_CANCELAR ||
    REGEX_EDITAR.test(texto) ||
    textoLower === CMD_MENSALISTAS ||
    textoLower === CMD_AJUDA
  );
  const comandoTeste = TEST_MODE && (
    REGEX_TESTAR_ENCHER.test(texto) || textoLower === CMD_TESTAR_LIMPAR
  );
  return comandoNormal || comandoTeste;
}

// msg = { body, pushname, chatId, numero, nomeGrupo, reply(texto),
//         ehAdmin(): Promise<bool>  — remetente é admin do grupo no WhatsApp (ou o admin do bot),
//         remetenteCitado(): Promise<numero|null> — quem enviou a mensagem respondida, se houver }
async function processarMensagem(msg) {
  const texto = (msg.body || '').trim();
  const chatId = msg.chatId;

  // Cadastra o grupo silenciosamente na primeira mensagem — não faz
  // nada além disso até algum comando de fato ser reconhecido.
  const grupo = db.registrarGrupoSeNovo(chatId, msg.nomeGrupo);

  if (!grupo.ativo) {
    // Só avisa se for de fato um comando reconhecido do bot (ex: #lista,
    // #lista05/07, #mostralista...), não qualquer mensagem com # no meio
    // do papo normal do grupo (tipo "#quintou").
    if (correspondeAlgumComando(texto)) {
      return msg.reply('🔒 Esse grupo ainda não foi liberado pra usar o bot. Fala com quem administra.');
    }
    return;
  }

  const matchAbrir = texto.match(REGEX_ABRIR);
  if (matchAbrir) {
    // Abrir lista é coisa de admin — senão qualquer um cria lista fantasma
    if (!(await msg.ehAdmin())) {
      return msg.reply('🔒 Só admin pode abrir lista.');
    }
    const dataJogo = matchAbrir[1];
    const valorCriacao = matchAbrir[2] ? db.paraCentavos(matchAbrir[2]) : null;
    const nomeLista = matchAbrir[3]?.trim() || null;
    const { ja_existia } = db.criarLista(chatId, dataJogo, nomeLista, valorCriacao);
    if (ja_existia) {
      return msg.reply(`Já existe uma lista pro dia ${dataJogo}. Manda *#mostralista* pra ver.`);
    }
    const notaValor = valorCriacao != null ? ` — ${db.formatarReais(valorCriacao)} por pessoa` : '';
    return msg.reply(
      `✅ Lista ${nomeLista ? `*${nomeLista}* ` : ''}aberta pro dia *${dataJogo}*${notaValor}! Manda *#lista* pra entrar.`
    );
  }

  const matchEntrar = texto.match(REGEX_ENTRAR);
  if (matchEntrar) {
    const nomeExplicito = matchEntrar[1]?.trim();
    const nome = nomeExplicito || msg.pushname || msg.numero;

    const lista = db.getListaAtiva(chatId);
    if (!lista) {
      return msg.reply(zoeiraSemLista(nome));
    }

    const resultado = db.adicionarEntrada(lista.id, nome, msg.numero);

    if (resultado.erro === 'ja_esta_na_lista') {
      return msg.reply(`${nome}, você já tá na lista! 😉`);
    }
    if (resultado.erro === 'inadimplente') {
      return msg.reply(`⛔ ${nome}, você está na lista de inadimplentes — acerta com um admin antes de entrar.`);
    }
    if (resultado.erro === 'tudo_lotado') {
      return msg.reply(`${nome}, infelizmente já lotou tudo hoje 🏐`);
    }

    // Se a lista cresceu, quem estava na espera subiu antes desse novato entrar
    for (const promovido of resultado.promovidos || []) {
      await msg.reply(`⬆️ ${promovido} subiu da espera pra lista principal!`);
    }

    const rotulo = resultado.tipo === 'principal'
      ? `posição ${resultado.posicao} da lista principal`
      : `posição ${resultado.posicao} da lista de espera`;
    await msg.reply(`✅ ${nome} entrou! Você está na ${rotulo}.`);

    if (resultado.evento === 'lista_cheia') {
      await msg.reply('🚨 Lista encheu! Vamos começar a lista de espera.');
    } else if (resultado.evento === 'tudo_lotado') {
      await msg.reply('🚨 Tudo lotado! Encerrando as vagas por hoje.');
    }

    // Cospe a lista atualizada como confirmação visual, sempre
    const textoLista = db.montarListaFormatada(lista.id, lista.data_jogo);
    return msg.reply(textoLista);
  }

  if (texto.toLowerCase() === CMD_MOSTRAR) {
    const lista = db.getListaAtiva(chatId);
    if (!lista) {
      const ultimas = db.historico(chatId);
      if (ultimas.length > 0) {
        return msg.reply(`Nenhuma lista aberta agora. A última foi *${ultimas[0].data_jogo}* (${ultimas[0].status}).`);
      }
      return msg.reply('Nenhuma lista criada ainda. Manda *#listaDD/MM* pra abrir uma.');
    }
    const textoLista = db.montarListaFormatada(lista.id, lista.data_jogo);
    return msg.reply(textoLista);
  }

  if (texto.toLowerCase() === CMD_ENCERRAR) {
    if (!(await msg.ehAdmin())) {
      return msg.reply('🔒 Só admin pode encerrar a lista.');
    }
    const lista = db.getListaAtiva(chatId);
    if (!lista) {
      return msg.reply('Não tem lista aberta pra encerrar.');
    }
    db.encerrarLista(lista.id);
    return msg.reply(`🔒 Lista do dia *${lista.data_jogo}* encerrada. Não aceita mais nomes.`);
  }

  const matchEditar = texto.match(REGEX_EDITAR);
  if (matchEditar) {
    if (!(await msg.ehAdmin())) {
      return msg.reply('🔒 Só admin pode editar a lista.');
    }
    const lista = db.getListaMaisRecente(chatId);
    if (!lista) {
      return msg.reply('Não tem lista pra editar.');
    }
    const resultado = db.editarLista(lista.id, {
      dataJogo: matchEditar[1],
      nome: matchEditar[2]?.trim() || null,
    });
    if (resultado.erro === 'data_ocupada') {
      return msg.reply(`Já existe outra lista de *${matchEditar[1]}* aqui. Cancela ela antes ou escolhe outra data.`);
    }
    await msg.reply(
      `✏️ Lista corrigida: *${resultado.antes.data_jogo}* → *${resultado.lista.data_jogo}*${resultado.lista.nome ? ` (${resultado.lista.nome})` : ''}. Ninguém saiu da lista.`
    );
    return msg.reply(db.montarListaFormatada(lista.id, resultado.lista.data_jogo));
  }

  if (texto.toLowerCase() === CMD_CANCELAR) {
    if (!(await msg.ehAdmin())) {
      return msg.reply('🔒 Só admin pode cancelar a lista.');
    }
    const resultado = db.cancelarLista(chatId);
    if (resultado.erro === 'sem_lista') {
      return msg.reply('Não tem lista pra cancelar.');
    }
    return msg.reply(
      `🚫 Lista ${resultado.nome ? `*${resultado.nome}* ` : ''}de *${resultado.data_jogo}* cancelada e apagada (${resultado.entradas} entrada(s)). A data ficou livre pra recriar.`
    );
  }

  const matchRemover = texto.match(REGEX_REMOVER);
  if (matchRemover) {
    const lista = db.getListaAtiva(chatId);
    if (!lista) {
      return msg.reply('Nenhuma lista aberta no momento.');
    }

    const argumento = matchRemover[1]?.trim();
    let resultado;

    if (!argumento) {
      // #remover sozinho: sai da lista — acha pela pessoa que pediu, então
      // funciona também pra quem entrou com "#lista Nome"
      resultado = db.removerPorNumero(lista.id, msg.numero);
      if (resultado.erro === 'nao_esta_na_lista') {
        return msg.reply('Você não está na lista atual.');
      }
    } else if (/^\d+$/.test(argumento)) {
      // #remover N: tirar os outros é coisa de admin
      if (!(await msg.ehAdmin())) {
        return msg.reply('🔒 Só admin pode remover os outros. Pra sair da lista, manda *#remover* sozinho.');
      }
      resultado = db.removerPorPosicao(lista.id, parseInt(argumento, 10));
      if (resultado.erro === 'posicao_invalida') {
        return msg.reply(`Não achei ninguém na posição ${argumento}. Confere com *#mostralista*.`);
      }
    } else {
      // #remover Nome: remove se a entrada estiver pendurada no SEU número
      // (você mesmo, ou alguém que você adicionou com "#lista Nome");
      // admin remove qualquer um pelo nome
      const candidatos = db.acharEntradasPorNome(lista.id, argumento);
      if (candidatos.length === 0) {
        return msg.reply(`Não achei "${argumento}" na lista. Confere com *#mostralista*.`);
      }
      const usuario = String(msg.numero || '').split('@')[0];
      const meu = candidatos.find((e) => String(e.numero).split('@')[0] === usuario);
      if (meu) {
        resultado = db.removerEntrada(lista.id, meu);
      } else if (await msg.ehAdmin()) {
        if (candidatos.length > 1) {
          return msg.reply(`Tem ${candidatos.length} pessoas chamadas "${argumento}" — usa *#remover N* pela posição.`);
        }
        resultado = db.removerEntrada(lista.id, candidatos[0]);
      } else {
        return msg.reply(`🔒 "${argumento}" não foi adicionado(a) pelo seu número — só admin pode remover os outros.`);
      }
    }

    const avisoPago = resultado.removidoTinhaPago
      ? ' ⚠️ Atenção: essa pessoa já tinha pago ✅!'
      : '';
    await msg.reply(`❌ ${resultado.removido} saiu da lista.${avisoPago}`);
    for (const promovido of resultado.promovidos || []) {
      await msg.reply(`⬆️ ${promovido} subiu da espera pra lista principal!`);
    }

    const textoLista = db.montarListaFormatada(lista.id, lista.data_jogo);
    return msg.reply(textoLista);
  }

  const matchPago = texto.match(REGEX_PAGO);
  const matchNaoPago = matchPago ? null : texto.match(REGEX_NAOPAGO);
  if (matchPago || matchNaoPago) {
    const marcar = Boolean(matchPago);
    const posicaoTexto = (matchPago || matchNaoPago)[1];

    if (!(await msg.ehAdmin())) {
      return msg.reply('🔒 Só admin do grupo pode marcar pagamento.');
    }

    // Última lista mesmo se encerrada: a cobrança costuma vir depois do jogo,
    // e #encerrarlista trava só a entrada de nomes, não o dinheiro
    const lista = db.getListaMaisRecente(chatId);
    if (!lista) {
      return msg.reply('Nenhuma lista criada ainda.');
    }

    let resultado;
    if (posicaoTexto) {
      resultado = db.marcarPagoPorPosicao(lista.id, parseInt(posicaoTexto, 10), marcar);
      if (resultado.erro) {
        return msg.reply(`Não achei ninguém na posição ${posicaoTexto}. Confere com *#mostralista*.`);
      }
    } else {
      const citado = await msg.remetenteCitado();
      if (!citado) {
        return msg.reply(
          marcar
            ? 'Usa *#pago N* (posição da lista) ou responde a mensagem do comprovante com *#pago*.'
            : 'Usa *#naopago N* (posição da lista) ou responde a mensagem da pessoa com *#naopago*.'
        );
      }
      resultado = db.marcarPagoPorNumero(lista.id, citado, marcar);
      if (resultado.erro) {
        return msg.reply('Quem mandou essa mensagem não está na lista atual.');
      }
    }

    await msg.reply(marcar ? `💰 ${resultado.nome} pagou! ✅` : `↩️ Pagamento de ${resultado.nome} desmarcado.`);
    if (marcar) await celebrarPagamento(msg);
    return msg.reply(db.montarListaFormatada(lista.id, lista.data_jogo));
  }

  const matchValorPadrao = texto.match(REGEX_VALOR_PADRAO);
  if (matchValorPadrao) {
    if (!(await msg.ehAdmin())) {
      return msg.reply('🔒 Só admin do grupo pode definir o valor.');
    }
    const centavos = db.paraCentavos(matchValorPadrao[1]);
    db.setarValorPadraoGrupo(chatId, centavos);
    // 0 significa "sem valor" no sistema todo — confirma como remoção,
    // não como "R$ 0,00 por pessoa"
    if (centavos === 0) {
      return msg.reply('💰 Valor padrão removido — próximas listas nascem sem cobrança.');
    }
    return msg.reply(
      `💰 Valor padrão do grupo: *${db.formatarReais(centavos)}* por pessoa. Vale pras próximas listas — pra mudar a lista atual, usa *#valor ${matchValorPadrao[1]}*.`
    );
  }

  const matchValor = texto.match(REGEX_VALOR);
  if (matchValor) {
    const lista = db.getListaMaisRecente(chatId);

    // #valor sem número é consulta — aberto a todo mundo
    if (!matchValor[1]) {
      if (!lista) return msg.reply('Nenhuma lista criada ainda.');
      const valor = db.getLista(lista.id).valor_centavos;
      return msg.reply(
        valor > 0
          ? `💰 Valor por pessoa desta lista: *${db.formatarReais(valor)}*`
          : 'Essa lista não tem valor definido. Um admin do grupo define com *#valor 25*.'
      );
    }

    if (!(await msg.ehAdmin())) {
      return msg.reply('🔒 Só admin do grupo pode definir o valor.');
    }
    if (!lista) {
      return msg.reply('Nenhuma lista criada ainda. O valor é por lista — abre uma com *#listaDD/MM*, ou define o padrão do grupo com *#valorpadrao 25*.');
    }
    const centavos = db.paraCentavos(matchValor[1]);
    db.setarValorLista(lista.id, centavos);
    if (centavos === 0) {
      return msg.reply('💰 Valor removido — lista sem cobrança.');
    }
    return msg.reply(`💰 Valor desta lista: *${db.formatarReais(centavos)}* por pessoa.`);
  }

  // ---- mensalistas

  if (texto.toLowerCase() === CMD_MENSALISTAS) {
    return msg.reply(db.montarMensalistasFormatado(chatId));
  }

  const matchMensalista = texto.match(REGEX_MENSALISTA);
  if (matchMensalista) {
    const nome = matchMensalista[1]?.trim() || msg.pushname || msg.numero;
    // Inscrição só com a pré-lista aberta (os admins abrem no 1º dia útil)
    if (!grupo.pre_lista_aberta) {
      return msg.reply('🗓 As inscrições de mensalista estão fechadas no momento. Os admins abrem no começo do mês — fica ligado no grupo!');
    }
    if (db.ehInadimplente(chatId, msg.numero, nome)) {
      return msg.reply(`⛔ ${nome}, você está na lista de inadimplentes — acerta com um admin antes.`);
    }
    const resultado = db.adicionarMensalista(chatId, nome, msg.numero);
    if (resultado.erro === 'ja_e_mensalista') {
      return msg.reply(`${nome}, você já está no quadro de mensalistas! 😉`);
    }
    if (resultado.espera) {
      await msg.reply(`⏳ Vagas mensais preenchidas — ${nome} entrou na *espera* dos mensalistas (posição ${resultado.posicao}). Se abrir vaga, você sobe.`);
    } else {
      await msg.reply(`🗓 ${nome} garantiu a vaga ${resultado.posicao}/${resultado.limite} da pré-lista! Agora é só acertar o pagamento com os admins — o ✅ confirma você como mensalista.`);
    }
    return msg.reply(db.montarMensalistasFormatado(chatId));
  }

  const matchPagoMes = texto.match(REGEX_PAGO_MES);
  const matchNaoPagoMes = matchPagoMes ? null : texto.match(REGEX_NAOPAGO_MES);
  if (matchPagoMes || matchNaoPagoMes) {
    if (!(await msg.ehAdmin())) {
      return msg.reply('🔒 Só admin do grupo pode marcar mensalidade.');
    }
    const marcar = Boolean(matchPagoMes);
    const posicao = parseInt((matchPagoMes || matchNaoPagoMes)[1], 10);
    const grupo = db.getGrupo(chatId);
    // Valor explícito > mensalidade padrão do grupo — vira o snapshot do mês
    const valor = marcar
      ? (matchPagoMes[2] ? db.paraCentavos(matchPagoMes[2]) : (grupo?.valor_mes_centavos || 0))
      : 0;
    const resultado = db.marcarMesPagoPorPosicao(chatId, posicao, marcar, valor);
    if (resultado.erro) {
      return msg.reply(`Não achei mensalista na posição ${posicao}. Confere com *#mensalistas*.`);
    }
    await msg.reply(marcar ? `🗓 ${resultado.nome} pagou o mês! ✅` : `↩️ Mensalidade de ${resultado.nome} desmarcada.`);
    if (marcar) await celebrarPagamento(msg);
    return msg.reply(db.montarMensalistasFormatado(chatId));
  }

  const matchFixo = texto.match(REGEX_FIXO);
  if (matchFixo) {
    if (!(await msg.ehAdmin())) {
      return msg.reply('🔒 Só admin do grupo pode definir fixos.');
    }
    const resultado = db.alternarFixoPorPosicao(chatId, parseInt(matchFixo[1], 10));
    if (resultado.erro) {
      return msg.reply(`Não achei mensalista na posição ${matchFixo[1]}. Confere com *#mensalistas*.`);
    }
    await msg.reply(resultado.fixo
      ? `📌 ${resultado.nome} agora é fixo — vaga cativa de mensalista.`
      : `${resultado.nome} deixou de ser fixo.`);
    return msg.reply(db.montarMensalistasFormatado(chatId));
  }

  const matchRemoverMensalista = texto.match(REGEX_REMOVER_MENSALISTA);
  if (matchRemoverMensalista) {
    if (!(await msg.ehAdmin())) {
      return msg.reply('🔒 Só admin do grupo pode remover mensalista.');
    }
    const resultado = db.removerMensalistaPorPosicao(chatId, parseInt(matchRemoverMensalista[1], 10));
    if (resultado.erro) {
      return msg.reply(`Não achei mensalista na posição ${matchRemoverMensalista[1]}. Confere com *#mensalistas*.`);
    }
    await msg.reply(`❌ ${resultado.nome} saiu do quadro de mensalistas.`);
    if (resultado.promovido) {
      await msg.reply(`⬆️ ${resultado.promovido} subiu da espera pra vaga mensal — falta o pagamento pra confirmar.`);
    }
    return msg.reply(db.montarMensalistasFormatado(chatId));
  }

  const matchValorMes = texto.match(REGEX_VALOR_MES);
  if (matchValorMes) {
    if (!(await msg.ehAdmin())) {
      return msg.reply('🔒 Só admin do grupo pode definir a mensalidade.');
    }
    const centavos = db.paraCentavos(matchValorMes[1]);
    db.setarValorMes(chatId, centavos);
    return msg.reply(centavos === 0
      ? '💰 Mensalidade removida.'
      : `💰 Mensalidade do grupo: *${db.formatarReais(centavos)}* (usada como padrão no #pagomes).`);
  }

  const matchVagasMensalistas = texto.match(REGEX_VAGAS_MENSALISTAS);
  if (matchVagasMensalistas) {
    if (!(await msg.ehAdmin())) {
      return msg.reply('🔒 Só admin do grupo pode mudar as vagas.');
    }
    const vagas = parseInt(matchVagasMensalistas[1], 10);
    if (vagas < 1) {
      return msg.reply('O número de vagas precisa ser pelo menos 1.');
    }
    db.setarLimiteMensalistas(chatId, vagas);
    return msg.reply(`🗓 Vagas de mensalista: *${vagas}*.`);
  }

  // ---- inadimplentes

  const matchInadimplente = texto.match(REGEX_INADIMPLENTE);
  if (matchInadimplente) {
    if (!(await msg.ehAdmin())) {
      return msg.reply('🔒 Só admin do grupo pode marcar inadimplente.');
    }
    const alvoTexto = matchInadimplente[1].trim();
    const valor = matchInadimplente[2] ? db.paraCentavos(matchInadimplente[2]) : 0;

    let nome = alvoTexto;
    let numero = null;
    // Número curto = posição na lista atual (pega nome + contato de lá);
    // texto = marca só pelo nome
    if (/^\d{1,3}$/.test(alvoTexto)) {
      const lista = db.getListaMaisRecente(chatId);
      const entrada = lista && db.getEntradaPorPosicao(lista.id, parseInt(alvoTexto, 10));
      if (!entrada) {
        return msg.reply(`Não achei ninguém na posição ${alvoTexto}. Confere com *#mostralista* ou usa *#inadimplente Nome*.`);
      }
      nome = entrada.nome;
      numero = entrada.numero;
    }

    const resultado = db.adicionarInadimplente(chatId, { nome, numero, valorCentavos: valor });
    if (resultado.erro === 'ja_esta') {
      return msg.reply(`${nome} já está na lista de inadimplentes.`);
    }
    return msg.reply(
      `⛔ ${nome} entrou na lista de inadimplentes${valor > 0 ? ` (deve ${db.formatarReais(valor)})` : ''}. Não entra em lista nova até um admin dar *#quitado ${nome}*.`
    );
  }

  const matchQuitado = texto.match(REGEX_QUITADO);
  if (matchQuitado) {
    if (!(await msg.ehAdmin())) {
      return msg.reply('🔒 Só admin do grupo pode quitar inadimplente.');
    }
    const resultado = db.quitarInadimplente(chatId, matchQuitado[1].trim());
    if (resultado.erro) {
      return msg.reply('Não achei essa pessoa na lista de inadimplentes.');
    }
    await msg.reply(`✅ ${resultado.nome} pagou o agiota. 🤝`);
    await celebrarPagamento(msg);
    return;
  }

  if (TEST_MODE) {
    // Gate de admin: TEST_MODE é global do bot, e #testarlimpar apaga
    // entradas com pagamento marcado — não pode ficar aberto ao grupo
    const ehComandoTeste = REGEX_TESTAR_ENCHER.test(texto) || texto.toLowerCase() === CMD_TESTAR_LIMPAR;
    if (ehComandoTeste && !(await msg.ehAdmin())) {
      return msg.reply('🔒 Só admin do grupo pode usar comandos de teste.');
    }

    const matchEncher = texto.match(REGEX_TESTAR_ENCHER);
    if (matchEncher) {
      const lista = db.getListaAtiva(chatId);
      if (!lista) {
        return msg.reply('Nenhuma lista aberta pra testar. Abre uma com *#listaDD/MM* primeiro.');
      }

      const quantidade = parseInt(matchEncher[1], 10);
      const sufixo = Date.now(); // evita colidir com testes anteriores
      let ultimoEvento = null;
      let adicionados = 0;

      for (let i = 1; i <= quantidade; i++) {
        const resultado = db.adicionarEntrada(lista.id, `Teste ${i}`, `fake-${sufixo}-${i}@c.us`);
        if (resultado.erro) break; // lotou de vez, para de tentar
        adicionados++;
        if (resultado.evento) ultimoEvento = resultado.evento;
      }

      await msg.reply(`🧪 ${adicionados} pessoa(s) fake adicionada(s).`);
      if (ultimoEvento === 'lista_cheia') {
        await msg.reply('🚨 Lista encheu! Vamos começar a lista de espera.');
      } else if (ultimoEvento === 'tudo_lotado') {
        await msg.reply('🚨 Tudo lotado! Encerrando as vagas por hoje.');
      }

      const textoLista = db.montarListaFormatada(lista.id, lista.data_jogo);
      return msg.reply(textoLista);
    }

    if (texto.toLowerCase() === CMD_TESTAR_LIMPAR) {
      const lista = db.getListaAtiva(chatId);
      if (!lista) {
        return msg.reply('Nenhuma lista aberta pra limpar.');
      }
      const removidos = db.limparEntradas(lista.id);
      return msg.reply(`🧪 Lista limpa! ${removidos} entrada(s) removida(s). A lista *${lista.data_jogo}* continua aberta, zerada.`);
    }
  }

  if (texto.toLowerCase() === CMD_AJUDA) {
    const solicitanteEhAdmin = await msg.ehAdmin();
    let ajuda = TEXTO_AJUDA_COMUM;
    if (solicitanteEhAdmin) {
      ajuda += TEXTO_AJUDA_ADMIN_GRUPO;
      if (TEST_MODE) ajuda += TEXTO_AJUDA_TESTE;
    }
    return msg.reply(ajuda);
  }

  // Variação malformada de comando conhecido (ex: "#pago 3 4", "#valor25",
  // "#pago João") não pode morrer em silêncio — o admin acharia que funcionou
  if (/^#(pago|naopago|valor|valorpadr[aã]o|valormes|remover|mostralista|encerrarlista|lista|comandos|mensalistas?|pagomes|naopagomes|fixo|removermensalista|vagasmensalistas|inadimplente|quitado|testarencher|testarlimpar)\b/i.test(texto)) {
    return msg.reply('Não entendi o formato 🤔 Manda *#comandos* pra ver como usar cada um.');
  }
}

module.exports = {
  processarMensagem,
  TEXTO_AJUDA_COMUM,
  TEXTO_AJUDA_ADMIN_GRUPO,
  acharFigurinha,
  acharFigurinhaCobranca,
  comMencoes,
  listarFigurinhas,
  acharFigurinhaQuitado,
  montarLembretePagamento,
  montarLembreteSubiu,
};
