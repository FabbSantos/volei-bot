// Compara ignorando acento e caixa — "volei" tem que achar "Vôlei de Quinta"
function normalizarTexto(texto) {
  // NFD separa a letra do acento; \p{M} apaga as marcas combinantes
  return String(texto || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

// Variante das zoeiras e figurinhas dedicadas (já vem sem espaço nas pontas)
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

module.exports = { normalizarTexto, semAcento };
