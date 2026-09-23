// Números que o próprio bot inventou (cadastro remoto, import, testes) não
// servem pra casar com o elenco, nem pra marcar ninguém no WhatsApp — só
// número de WhatsApp de verdade
function numeroSintetico(numero) {
  const u = String(numero || '');
  return !u || u.startsWith('manual-') || u.startsWith('fake-') || u.startsWith('planilha-');
}

module.exports = { numeroSintetico };
