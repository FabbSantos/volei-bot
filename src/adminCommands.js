const db = require('./db');

// #ativargrupo <chat_id> [vagas] [--espera] — ex: #ativargrupo 123@g.us 18 --6
// Os números são opcionais: sem eles, ativa mantendo o tamanho já configurado.
const REGEX_ATIVAR = /^#ativargrupo\s+(\S+)(?:\s+(\d{1,3}))?(?:\s+--(\d{1,3}))?$/i;
const REGEX_DESATIVAR = /^#desativargrupo\s+(\S+)$/i;
const CMD_LISTAR = '#listargrupos';
const CMD_AJUDA_ADMIN = '#admin';
// Comandos remotos: <grupo> pode ser um pedaço do nome ou o chat_id exato
const REGEX_LISTA_DE = /^#listade\s+(.+)$/i;
const REGEX_PAGOS_DE = /^#pagosde\s+(.+)$/i;
const REGEX_ADMINS_DE = /^#adminsde\s+(.+)$/i;
const REGEX_VALOR_DE = /^#valorde\s+(.+?)\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?)$/i;
const REGEX_VALOR_LISTA_DE = /^#valorlistade\s+(.+?)\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?)$/i;
const REGEX_GRUPO_ADMIN = /^#grupoadmin\s+(\S+)(?:\s+(off))?$/i;

const TEXTO_AJUDA_ADMIN = `🔧 *Comandos de admin (privado ou grupo de admins)*

*#listargrupos* — todos os grupos, com status, tamanho, valor e chat_id
*#ativargrupo <chat_id>* — libera um grupo pra usar o bot
*#ativargrupo <chat_id> 18 --6* — libera e dimensiona (padrão: 18 + 6)
*#desativargrupo <chat_id>* — bloqueia um grupo (ex: inadimplência)

📡 *Consulta/gestão remota (<grupo> = pedaço do nome ou chat_id):*
*#listade <grupo>* — lista atual do grupo
*#pagosde <grupo>* — quem pagou, quem falta e quanto arrecadou
*#adminsde <grupo>* — admins do grupo no WhatsApp (são eles que marcam #pago lá)
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
    const marcaEncerrada = lista.status === 'encerrada' ? ' — encerrada' : '';
    let resposta = `💰 *Pagamentos — ${r.grupo.nome || r.grupo.chat_id}* (lista ${lista.data_jogo}${marcaEncerrada})\n`;
    resposta += `✅ ${resumo.pagos}/${resumo.totalPessoas} pagaram`;
    if (resumo.valorCentavos > 0) {
      resposta += `\n💵 Arrecadado: *${db.formatarReais(resumo.arrecadadoCentavos)}* (${db.formatarReais(resumo.valorCentavos)}/pessoa)`;
    } else {
      resposta += `\n(lista sem valor definido — define com *#valorlistade <grupo> 25*)`;
    }
    if (resumo.pendentes.length > 0) {
      resposta += `\n⏳ Faltam: ${resumo.pendentes.join(', ')}`;
    } else if (resumo.totalPessoas > 0) {
      resposta += `\n🎉 Todo mundo pagou!`;
    }
    return msg.reply(resposta);
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
    const lista = db.getListaAtiva(r.grupo.chat_id);
    if (!lista) {
      return msg.reply(`*${r.grupo.nome || r.grupo.chat_id}* não tem lista aberta agora. Pro padrão das próximas, usa *#valorde*.`);
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

  // Qualquer variação dos comandos acima que não casou é sintaxe errada
  // (ex: "18 -6", "#listade" sem grupo, "#listargrupos x") — responde com o
  // uso em vez de ficar mudo e deixar o admin achando que funcionou
  if (/^#(ativargrupo|desativargrupo|listade|pagosde|adminsde|valorde|valorlistade|grupoadmin|listargrupos|admin)\b/i.test(texto)) {
    return msg.reply(
      `Não entendi o formato 🤔 Exemplos:\n*#ativargrupo <chat_id> 18 --6*\n*#listade quinta* · *#pagosde quinta* · *#valorde quinta 25*\nManda *#admin* pra ver a sintaxe de tudo.`
    );
  }

  // Comando do grupo de pelada digitado no contexto admin (ex: responder um
  // comprovante encaminhado com #pago) — aponta o equivalente remoto
  if (/^#(pago|naopago|valor|valorpadr[aã]o|mostralista|remover|encerrarlista|lista|comandos)\b/i.test(texto)) {
    return msg.reply(
      `Esse comando funciona dentro do grupo da pelada. Aqui os equivalentes são remotos: *#listade <grupo>*, *#pagosde <grupo>*, *#valorlistade <grupo> 30*... Manda *#admin* pra ver tudo.`
    );
  }
}

module.exports = { processarComandoAdmin };
