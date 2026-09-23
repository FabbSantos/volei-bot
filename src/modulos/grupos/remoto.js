// Argumentos dos comandos remotos (#listade <grupo>, #pagode <grupo> 1-3...):
// achar o grupo pelo pedaço do nome, separar grupo de nome, expandir faixas
// de posições e pegar os casos em que o nome do grupo "engole" o número.
const grupos = require('./repositorio');

// Acha o grupo alvo de um comando remoto: chat_id exato ou pedaço do nome.
// Retorna { grupo } ou { mensagem } pronta pra responder.
function resolverGrupo(termo) {
  const achados = grupos.buscarGrupos(termo.trim());
  if (achados.length === 0) {
    return { mensagem: `Não achei nenhum grupo com "${termo}". Vê os nomes e chat_ids com *#listargrupos*.` };
  }
  if (achados.length > 1) {
    const linhas = achados.map((g) => `• ${g.nome || '(sem nome)'} — ${g.chat_id}`).join('\n');
    return { mensagem: `Achei ${achados.length} grupos com "${termo}":\n${linhas}\n\nSê mais específico ou usa o chat_id.` };
  }
  return { grupo: achados[0] };
}

// Em '<grupo> <nome>' os dois são texto livre: testa o pedaço de grupo mais
// longo que resolve pra exatamente um grupo (assim 'Sem Espera Maria' vira
// grupo 'Sem Espera' + nome 'Maria', e 'riachuelo Joao' vira 'riachuelo' + 'Joao')
function separarGrupoENome(resto) {
  const bruto = String(resto || '').trim();
  // Quebra em qualquer espaço em branco, não só no espaço: anúncio que começa
  // na linha de baixo fazia o nome do grupo engolir a quebra ("riachuelo\n\n📢"
  // virava uma palavra só e não achava grupo nenhum).
  // Guarda também onde cada palavra começa, pra devolver o resto EXATAMENTE
  // como veio — um join(' ') achataria as quebras de linha do anúncio.
  const partes = [];
  const achador = /\S+/g;
  let achado;
  while ((achado = achador.exec(bruto))) partes.push({ texto: achado[0], inicio: achado.index });

  for (let i = partes.length - 1; i >= 1; i--) {
    const termo = partes.slice(0, i).map((p) => p.texto).join(' ');
    if (grupos.buscarGrupos(termo).length === 1) {
      return { termo, nome: bruto.slice(partes[i].inicio) };
    }
  }
  return {
    termo: partes[0]?.texto || '',
    nome: partes[1] ? bruto.slice(partes[1].inicio) : '',
  };
}

// "1-5", "1,3,7" ou "2" → [1, 2, 3, 4, 5] — máx. 50 posições por comando,
// valendo pra faixa, avulsas e mistura (repetida conta uma vez só)
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

// Nome de grupo que termina em número (ex: "Quadra 7") engoliria a posição
// do comando — se "termo posição" é um grupo, avisa em vez de adivinhar
function grupoEngoliuPosicao(termo, posicao, exemplo) {
  const inteiro = `${termo} ${posicao}`.trim();
  if (grupos.buscarGrupos(inteiro).length > 0) {
    return `"${inteiro}" parece ser o nome do grupo — faltou a posição do mensalista. Ex: *${exemplo}*`;
  }
  return null;
}

// "#valorde Quadra 7" com o valor esquecido: o 7 é parte do NOME do grupo,
// não um preço — se o argumento inteiro bate com algum grupo, pede o valor
// em vez de gravar preço errado.
function nomeEngoliuValor(termo, valor) {
  return grupos.buscarGrupos(`${termo} ${valor}`.trim()).length > 0;
}

// Os comandos remotos avisam o grupo da pelada; se o envio falhar, o admin
// fica sabendo em vez de achar que o grupo viu
async function anunciarNoGrupo(msg, chatId, ...textos) {
  if (!msg.enviarPara) return;
  try {
    for (const texto of textos) await msg.enviarPara(chatId, texto);
  } catch (err) {
    await msg.reply(`⚠️ Não consegui anunciar no grupo (${err.message}).`);
  }
}

module.exports = {
  resolverGrupo,
  separarGrupoENome,
  expandirPosicoes,
  grupoEngoliuPosicao,
  nomeEngoliuValor,
  anunciarNoGrupo,
};
