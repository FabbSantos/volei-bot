// Formato comum dos comandos de todos os módulos.
//
// Um comando é { casa(texto) → match ou null, executar(msg, match, ctx) }.
// Cada módulo exporta a própria lista, e o roteador (src/roteador.js) testa
// na ordem até um casar. `msg` é a porta pro canal (hoje, o WhatsApp):
//
//   grupo da pelada: { body, pushname, chatId, numero, nomeGrupo, reply(texto),
//                      enviarFigurinha(caminho), ehAdmin(): Promise<bool>,
//                      remetenteCitado(): Promise<numero|null> }
//   admin:           { body, origem: 'privado'|'grupoadmin', reply(texto),
//                      enviarPara(chatId, texto, opcoes), enviarFigurinhaPara(chatId, caminho),
//                      getAdminsDoGrupo(chatId), getMembrosDoGrupo(chatId), saude() }
//
// Nenhum módulo fala com o wppconnect direto — só por essa porta.

// padrao: RegExp (casa com texto.match) ou string (comando exato, sem caixa)
function comando(padrao, executar) {
  const casa = typeof padrao === 'string'
    ? (texto) => (texto.toLowerCase() === padrao ? [texto] : null)
    : (texto) => texto.match(padrao);
  return { casa, executar };
}

// Roda o primeiro comando que casar. Devolve false se nenhum casou.
async function despachar(comandos, texto, msg, ctx) {
  for (const c of comandos) {
    const match = c.casa(texto);
    if (match) {
      await c.executar(msg, match, ctx);
      return true;
    }
  }
  return false;
}

module.exports = { comando, despachar };
