// Uma frase diferente a cada pagamento conferido ("pra não ficar chapado
// toda vez", pedido do Fabrício em 21/10/2026). O Claude escreve com um tema
// sorteado; se demorar, falhar ou sair algo fora do combinado, vale uma da
// reserva — o anúncio do pagamento nunca espera a piada.
const TEMAS = [
  'agiota aliviado', 'narração de jogo de vôlei', 'novela das nove', 'previsão do tempo', 'receita de bolo',
  'manchete de jornal', 'propaganda de banco', 'GPS dando rota', 'comentarista de Big Brother', 'sommelier de vinho',
  'filme de ação', 'professor de matemática', 'astrólogo', 'locutor de rodeio', 'documentário de natureza',
];

const RESERVA = [
  'O agiota dorme tranquilo hoje. 😴',
  'Pagamento confirmado: a rede tá liberada pra cortar. 🏐',
  'Caiu na conta mais rápido que saque de quem não treina. ⚡',
  'Tá limpo com o agiota. Pode pedir a bola tranquilo. 🤝',
  'Uma salva de palmas pra quem paga em dia. 👏',
  'O caixa da pelada agradece de joelhos. 🙏',
  'Esse aí já pode chegar na quadra de cabeça erguida. 😎',
  'Pix recebido, consciência leve, saque forte. 💪',
  'O agiota até sorriu. Foto rara. 📸',
  'Mais um pro time dos adimplentes. 🏆',
  'Mais um que joga sem peso na consciência. 🪶',
  'Dinheiro na conta, vôlei na veia. 🔥',
];

// Coisa que não pode sair num anúncio de pagamento: cobrar, expor quem deve,
// marcar alguém
const PROIBIDO = /deve|devendo|d[ií]vida|calote|n[aã]o pag|@|https?:/i;

const sortear = (lista, aleatorio = Math.random) => lista[Math.floor(aleatorio() * lista.length)];

function frasePronta(aleatorio = Math.random) {
  return sortear(RESERVA, aleatorio);
}

// Confere o que o Claude escreveu: uma linha, curta, sem nada proibido
function fraseValida(texto) {
  const t = String(texto || '').trim().replace(/^["“”']+|["“”']+$/g, '');
  if (!t || t.includes('\n') || t.length > 180 || PROIBIDO.test(t)) return null;
  return t;
}

// escrever({ quem, tema }) → texto (o Claude, em ./leitor). Sem ele, ou se
// passar do prazo, reserva.
async function fraseDePagamento(quem, { escrever = null, aleatorio = Math.random, prazoMs = 8000 } = {}) {
  if (!escrever) return frasePronta(aleatorio);
  let prazo;
  try {
    const texto = await Promise.race([
      escrever({ quem, tema: sortear(TEMAS, aleatorio) }),
      new Promise((_, rej) => { prazo = setTimeout(() => rej(new Error('demorou')), prazoMs); }),
    ]);
    return fraseValida(texto) || frasePronta(aleatorio);
  } catch (err) {
    console.warn(`[comprovante] frase reserva (${err.message})`);
    return frasePronta(aleatorio);
  } finally {
    clearTimeout(prazo);
  }
}

module.exports = { fraseDePagamento, fraseValida, frasePronta, TEMAS, RESERVA };
