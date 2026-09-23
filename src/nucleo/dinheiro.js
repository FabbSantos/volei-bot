// Dinheiro: tudo em centavos (INTEGER) pra não sofrer com float
function paraCentavos(texto) {
  // aceita "25", "25,50", "25.50"
  return Math.round(parseFloat(String(texto).replace(',', '.')) * 100);
}

function formatarReais(centavos) {
  return `R$ ${(centavos / 100).toFixed(2).replace('.', ',')}`;
}

module.exports = { paraCentavos, formatarReais };
