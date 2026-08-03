const fs = require('fs');
const db = require('./db');
const { TEXTO_AJUDA_COMUM, TEXTO_AJUDA_ADMIN_GRUPO, acharFigurinhaQuitado } = require('./commands');

// #ativargrupo <chat_id> [vagas] [--espera] — ex: #ativargrupo 123@g.us 18 --6
// Os números são opcionais: sem eles, ativa mantendo o tamanho já configurado.
const REGEX_ATIVAR = /^#ativargrupo\s+(\S+)(?:\s+(\d{1,3}))?(?:\s+--(\d{1,3}))?$/i;
const REGEX_DESATIVAR = /^#desativargrupo\s+(\S+)$/i;
const CMD_LISTAR = '#listargrupos';
const CMD_AJUDA_ADMIN = '#admin';
// Comandos remotos: <grupo> pode ser um pedaço do nome ou o chat_id exato
const REGEX_LISTA_DE = /^#listade\s+(.+)$/i;
// #abrirlistade <grupo> DD/MM [valor] [nome] — abre a lista da pelada daqui,
// já anunciando no grupo dela (ex: #abrirlistade riachuelo 07/08 17 Sexta 3h)
const REGEX_ABRIR_LISTA_DE = /^#abrirlistade\s+(.+?)\s+(\d{1,2}\/\d{1,2})(?:\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?))?(?:\s+(.+))?$/i;
const REGEX_PAGOS_DE = /^#pagosde\s+(.+)$/i;
const REGEX_ADMINS_DE = /^#adminsde\s+(.+)$/i;
const REGEX_MENSALISTAS_DE = /^#mensalistasde\s+(.+)$/i;
// Pré-lista de mensalistas: abre/fecha as inscrições do mês e reinício manual
const REGEX_ABRIR_MENSALISTAS_DE = /^#abrirmensalistasde\s+(.+)$/i;
const REGEX_FECHAR_MENSALISTAS_DE = /^#fecharmensalistasde\s+(.+)$/i;
const REGEX_REINICIAR_MENSALISTAS_DE = /^#reiniciarmensalistasde\s+(.+)$/i;
// Gestão remota de mensalistas — mexe no quadro de um grupo sem poluir o
// grupo da pelada com comando; o efeito aparece lá na próxima lista
const REGEX_MENSALISTA_DE = /^#mensalistade\s+(.+?)\s+([^\d\s].*)$/i; // grupo + nome
const REGEX_PAGO_MES_DE = /^#pagomesde\s+(.+?)\s+(\d{1,3})(?:\s+(?:r\$\s*)?(\d{1,4}(?:[.,]\d{1,2})?))?$/i;
const REGEX_NAOPAGO_MES_DE = /^#naopagomesde\s+(.+?)\s+(\d{1,3})$/i;
const REGEX_FIXO_DE = /^#fixode\s+(.+?)\s+(\d{1,3})$/i;
const REGEX_REMOVER_MENSALISTA_DE = /^#removermensalistade\s+(.+?)\s+(\d{1,3})$/i;
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
*#listade <grupo>* — lista atual do grupo
*#pagosde <grupo>* — quem pagou, quem falta e quanto arrecadou
*#mensalistasde <grupo>* — quadro de mensalistas do mês + arrecadação
*#adminsde <grupo>* — admins do grupo no WhatsApp (são eles que marcam #pago lá)

🗓 *Gestão de mensalistas daqui mesmo:*
*#abrirmensalistasde <grupo>* / *#fecharmensalistasde <grupo>* — abre/fecha as inscrições do mês (anuncia no grupo)
*#reiniciarmensalistasde <grupo>* — zera os não-fixos e fecha as inscrições
*#pagomesde <grupo> 3* — marca o mês do mensalista 3 (valor opcional no fim)
*#naopagomesde <grupo> 3* — desmarca o mês
*#fixode <grupo> 3* — liga/desliga a vaga cativa (📌)
*#mensalistade <grupo> Nome* — cadastra candidato (melhor a pessoa mandar #mensalista no grupo: aí o WhatsApp dela fica vinculado)
*#removermensalistade <grupo> 3* — tira do quadro
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
    resposta += `\n✅ ${resumo.emDia}/${resumo.totalPessoas} em dia`;
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
    } else if (resumo.totalPessoas > 0) {
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
    const r = resolverGrupo((matchAbrirMensalistas || matchFecharMensalistas)[1]);
    if (r.mensagem) return msg.reply(r.mensagem);
    const nomeGrupo = r.grupo.nome || r.grupo.chat_id;
    db.abrirPreLista(r.grupo.chat_id, abrir);

    const resumo = db.resumoMensalistas(r.grupo.chat_id);
    const vagas = Math.max(0, resumo.limite - resumo.total);
    const anuncio = abrir
      ? `🗓 *Inscrições de mensalista abertas!* ${vagas} vaga(s) + fila de espera.\n\nManda *#mensalista* pra garantir a tua. Pagamento até o 5º dia útil com os admins — o ✅ é o que confirma a vaga.`
      : `🗓 *Inscrições de mensalista encerradas.* Quem garantiu, garantiu — agora é acertar o pagamento com os admins.`;
    let aviso = '';
    if (msg.enviarPara) {
      try {
        await msg.enviarPara(r.grupo.chat_id, anuncio);
      } catch (err) {
        aviso = `\n⚠️ Não consegui anunciar no grupo (${err.message}).`;
      }
    }
    await msg.reply(`🗓 Inscrições de *${nomeGrupo}* ${abrir ? 'abertas' : 'fechadas'} e anunciadas no grupo.${aviso}`);
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
    const resultado = db.marcarMesPagoPorPosicao(r.grupo.chat_id, parseInt(m[2], 10), marcar, valor);
    if (resultado.erro) {
      return msg.reply(`Não achei mensalista na posição ${m[2]} de *${r.grupo.nome || r.grupo.chat_id}*. Confere com *#mensalistasde*.`);
    }
    // Pagamento confirmado é notícia pro grupo: a pessoa virou mensalista de
    // fato e entra automático nas próximas listas
    if (marcar && msg.enviarPara) {
      try {
        await msg.enviarPara(
          r.grupo.chat_id,
          `🗓 *${resultado.nome}* pagou o mês e tá confirmado(a) como mensalista! ✅ Vaga garantida nas listas a partir de agora.`
        );
        // Figurinha do agiota junto com o anúncio, se a imagem existir
        const figurinha = acharFigurinhaQuitado();
        if (msg.enviarFigurinhaPara && figurinha && fs.existsSync(figurinha)) {
          await msg.enviarFigurinhaPara(r.grupo.chat_id, figurinha);
        }
      } catch (err) {
        await msg.reply(`⚠️ Não consegui anunciar no grupo (${err.message}).`);
      }
    }
    await msg.reply(marcar ? `🗓 ${resultado.nome} pagou o mês! ✅ (anunciado no grupo)` : `↩️ Mensalidade de ${resultado.nome} desmarcada.`);
    return msg.reply(db.montarMensalistasFormatado(r.grupo.chat_id));
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
    const resultado = db.removerMensalistaPorPosicao(r.grupo.chat_id, parseInt(matchRemoverMensalistaDe[2], 10));
    if (resultado.erro) {
      return msg.reply(`Não achei mensalista na posição ${matchRemoverMensalistaDe[2]} de *${r.grupo.nome || r.grupo.chat_id}*.`);
    }
    await msg.reply(`❌ ${resultado.nome} saiu do quadro de mensalistas.`);
    if (resultado.promovido) {
      await msg.reply(`⬆️ ${resultado.promovido} subiu da espera pra vaga mensal — falta o pagamento pra confirmar.`);
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

  // #comandos no contexto admin = ajuda completa, em duas mensagens:
  // o que existe no grupo da pelada e o arsenal remoto daqui
  if (texto.toLowerCase() === '#comandos') {
    await msg.reply(`${TEXTO_AJUDA_COMUM}${TEXTO_AJUDA_ADMIN_GRUPO}`);
    return msg.reply(TEXTO_AJUDA_ADMIN);
  }

  // Qualquer variação dos comandos acima que não casou é sintaxe errada
  // (ex: "18 -6", "#listade" sem grupo, "#listargrupos x") — responde com o
  // uso em vez de ficar mudo e deixar o admin achando que funcionou
  if (/^#(ativargrupo|desativargrupo|abrirlistade|listade|pagosde|adminsde|mensalistasde|mensalistade|abrirmensalistasde|fecharmensalistasde|reiniciarmensalistasde|pagomesde|naopagomesde|fixode|removermensalistade|valormesde|vagasmensalistasde|valorde|valorlistade|grupoadmin|listargrupos|admin)\b/i.test(texto)) {
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
