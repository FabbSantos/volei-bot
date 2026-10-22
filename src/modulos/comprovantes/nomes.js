// Quem é quem pelo nome que a pessoa ESCREVE. Na lista fica o nome do
// WhatsApp ("DiegoB", "Fontella ✠", "A6 😎✌🏻 费利佩"); na resposta vem o nome
// de gente ("Diego", "Letícia", "Aces"). A ponte é o elenco do painel: cada
// entrada da lista já é ligada a um jogador, com nome e apelidos ensinados.
const elenco = require('../elenco/repositorio');
const { tokens } = require('./decisor');

// Palavras que aparecem nas respostas e não são nome de ninguém
const VAZIAS = new Set([
  'da', 'do', 'de', 'e', 'o', 'a', 'os', 'as', 'um', 'uma', 'pra', 'pro', 'para', 'pela', 'pelo', 'esse', 'essa',
  'isso', 'foi', 'era', 'sim', 'nao', 'ta', 'aqui', 'que', 'nos', 'so', 'dela', 'dele', 'meu', 'minha', 'eu', 'mim',
  'dois', 'duas', 'ambos', 'ambas', 'todos', 'tres', 'paguei', 'pagou', 'pago', 'pix', 'valeu', 'obrigado', 'obg',
  'com', 'sem', 'tambem', 'ja', 'mais', 'filha', 'filho', 'namorada', 'namorado', 'esposa', 'marido', 'amigo', 'amiga',
]);

// id da entrada → todos os nomes dela: o da lista, o do jogador e os apelidos
function apelidosDasEntradas(chatId, entradas) {
  const jogadores = elenco.listarJogadores(chatId);
  const mapa = new Map();
  for (const e of entradas) {
    const j = elenco.acharJogadorDaEntrada(chatId, e, jogadores);
    mapa.set(e.id, [...new Set([e.nome, ...(j ? [j.nome, ...(j.apelidos || [])] : [])])]);
  }
  return mapa;
}

const nomesDe = (e, apelidos) => apelidos.get(e.id) || [e.nome];

// Entradas que uma palavra pode ser. Palavra inteira de qualquer nome
// ("letícia" em "Letícia Fontella") vale antes de começo de nome ("diego" em
// "DiegoB", "vini" em "Vinicius"); empate desempata pelos candidatos.
function quemEh(palavra, entradas, apelidos, preferidosIds = []) {
  if (palavra.length < 2 || VAZIAS.has(palavra)) return [];
  const comPalavra = (teste) => entradas.filter((e) => nomesDe(e, apelidos).some((n) => tokens(n).some(teste)));
  let achados = comPalavra((t) => t === palavra);
  if (!achados.length && palavra.length >= 4) achados = comPalavra((t) => t.startsWith(palavra));
  if (achados.length > 1) {
    const preferidos = achados.filter((e) => preferidosIds.includes(e.id));
    if (preferidos.length) achados = preferidos;
  }
  return achados;
}

// Todas as pessoas citadas num texto. { nomeados, ambiguo }: ambiguo quando
// uma palavra serve pra mais de uma pessoa (dois Diego devendo) — aí não chuta
// Palavra que serve pra dois só é ambígua se nenhuma outra palavra decidir:
// em "do Thiago Prata", "thiago" é o Rodrigues ou o Prata, mas "prata" fecha
function nomeadosNoTexto(texto, entradas, apelidos, preferidosIds = []) {
  const porPalavra = tokens(texto).map((p) => quemEh(p, entradas, apelidos, preferidosIds)).filter((a) => a.length);
  const certos = porPalavra.filter((a) => a.length === 1).map((a) => a[0]);
  for (const duvida of porPalavra.filter((a) => a.length > 1)) {
    if (!duvida.some((e) => certos.includes(e))) return { nomeados: [], ambiguo: true };
  }
  return { nomeados: [...new Map(certos.map((e) => [e.id, e])).values()], ambiguo: false };
}

// O nome que o Claude devolveu (da lista ou um apelido) → a entrada
function entradaPeloNome(nome, entradas, apelidos) {
  const alvo = tokens(String(nome || '').replace(/\s*\(também.*$/i, '')).join(' ');
  if (!alvo) return null;
  const achados = entradas.filter((e) => nomesDe(e, apelidos).some((n) => tokens(n).join(' ') === alvo));
  return achados.length === 1 ? achados[0] : null;
}

// Como a lista vai pro Claude: o nome da lista e, entre parênteses, os outros
function nomesParaOClaude(entradas, apelidos) {
  return entradas.map((e) => {
    const outros = nomesDe(e, apelidos).filter((n) => n !== e.nome);
    return outros.length ? `${e.nome} (também chamado: ${outros.join(', ')})` : e.nome;
  });
}

module.exports = { apelidosDasEntradas, quemEh, nomeadosNoTexto, entradaPeloNome, nomesParaOClaude };
