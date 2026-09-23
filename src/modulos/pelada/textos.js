// Textos da pelada: cobrança (lembrete diário e disparos manuais) e o
// cutucão de quem pede #lista antes de existir lista.
const { semAcento } = require('../../nucleo/texto');

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

// Textos de cobrança — usados pelo lembrete diário automático e pelos
// disparos manuais #cobrarde / #cobrarsubiude
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

module.exports = { comMencoes, zoeiraSemLista, montarLembretePagamento, montarLembreteSubiu };
