// Textos de ajuda (#comandos no grupo, #admin e #comandos no contexto admin)
// e as respostas pra comando conhecido digitado no formato errado.
const { comando } = require('../../nucleo/comandos');

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

const TEXTO_AJUDA_ADMIN = `🔧 *Comandos de admin (privado ou grupo de admins)*

*#teste* — checa se está tudo de pé: conexão, máquina, banco, listas e figurinhas
*#mensalistasde <grupo> enviar* — publica o quadro de mensalistas no grupo (sem o arrecadado)
*#anuncio <texto>* — manda o texto pro grupo da pelada, exatamente como escrito
*#anunciarde <grupo> <texto>* — o mesmo, escolhendo o grupo (também aceita *#anunciode*)

*#listargrupos* — todos os grupos, com status, tamanho, valor e chat_id
*#ativargrupo <chat_id>* — libera um grupo pra usar o bot
*#ativargrupo <chat_id> 18 --6* — libera e dimensiona (padrão: 18 + 6)
*#desativargrupo <chat_id>* — bloqueia um grupo (ex: inadimplência)

📡 *Consulta/gestão remota (<grupo> = pedaço do nome ou chat_id):*
*#abrirlistade <grupo> 07/08 17 Sexta 3h* — abre a lista de lá (valor e nome opcionais) e anuncia no grupo
*#abrirextrade <grupo> 29/09 15* — pelada extra: só os fixos entram sozinhos, e pagam como todo mundo (a mensalidade não cobre)
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

const TEST_MODE = process.env.TEST_MODE === 'true';

const ajudaGrupo = comando('#comandos', async (msg) => {
  const solicitanteEhAdmin = await msg.ehAdmin();
  let ajuda = TEXTO_AJUDA_COMUM;
  if (solicitanteEhAdmin) {
    ajuda += TEXTO_AJUDA_ADMIN_GRUPO;
    if (TEST_MODE) ajuda += TEXTO_AJUDA_TESTE;
  }
  return msg.reply(ajuda);
});

const ajudaAdmin = comando('#admin', (msg) => msg.reply(TEXTO_AJUDA_ADMIN));

// #comandos no contexto admin = ajuda completa, em duas mensagens:
// o que existe no grupo da pelada e o arsenal remoto daqui
const comandosNoAdmin = comando('#comandos', async (msg) => {
  await msg.reply(`${TEXTO_AJUDA_COMUM}${TEXTO_AJUDA_ADMIN_GRUPO}`);
  return msg.reply(TEXTO_AJUDA_ADMIN);
});

// Variação malformada de comando conhecido (ex: "#pago 3 4", "#valor25",
// "#pago João") não pode morrer em silêncio — o admin acharia que funcionou
const MALFORMADO_NO_GRUPO = /^#(pago|naopago|valor|valorpadr[aã]o|valormes|remover|mostralista|encerrarlista|lista|comandos|mensalistas?|pagomes|naopagomes|fixo|removermensalista|vagasmensalistas|inadimplente|quitado|testarencher|testarlimpar)\b/i;

async function responderMalformadoNoGrupo(msg, texto) {
  if (MALFORMADO_NO_GRUPO.test(texto)) {
    return msg.reply('Não entendi o formato 🤔 Manda *#comandos* pra ver como usar cada um.');
  }
}

// Qualquer variação dos comandos de admin que não casou é sintaxe errada
// (ex: "18 -6", "#listade" sem grupo, "#listargrupos x") — responde com o
// uso em vez de ficar mudo e deixar o admin achando que funcionou
const MALFORMADO_NO_ADMIN = /^#(ativargrupo|desativargrupo|abrirlistade|editarlistade|encerrarlistade|reabrirlistade|cancelarlistade|listade|pagosde|adminsde|mensalistasde|mensalistade|abrirmensalistasde|fecharmensalistasde|reiniciarmensalistasde|pagomesde|naopagomesde|pagode|naopagode|removerde|adicionarde|renomearde|cobrarde|cobrarsubiude|timesde|importarelencode|fixode|removermensalistade|valormesde|vagasmensalistasde|valorde|valorlistade|grupoadmin|listargrupos|admin)\b/i;
// Comando do grupo de pelada digitado no contexto admin (ex: responder um
// comprovante encaminhado com #pago) — aponta o equivalente remoto
const DE_GRUPO_NO_ADMIN = /^#(pago|naopago|valor|valorpadr[aã]o|valormes|mostralista|remover|encerrarlista|lista|mensalistas?|pagomes|naopagomes|fixo|removermensalista|vagasmensalistas|inadimplente|quitado)\b/i;

async function responderMalformadoNoAdmin(msg, texto) {
  if (MALFORMADO_NO_ADMIN.test(texto)) {
    return msg.reply(
      `Não entendi o formato 🤔 Exemplos:\n*#ativargrupo <chat_id> 18 --6*\n*#listade quinta* · *#pagosde quinta* · *#valorde quinta 25*\nManda *#admin* pra ver a sintaxe de tudo.`
    );
  }
  if (DE_GRUPO_NO_ADMIN.test(texto)) {
    return msg.reply(
      `Esse comando funciona dentro do grupo da pelada. Aqui os equivalentes são remotos: *#listade <grupo>*, *#pagosde <grupo>*, *#valorlistade <grupo> 30*... Manda *#admin* pra ver tudo.`
    );
  }
}

module.exports = {
  comandosGrupo: [ajudaGrupo],
  comandosAdmin: [ajudaAdmin, comandosNoAdmin],
  responderMalformadoNoGrupo,
  responderMalformadoNoAdmin,
};
