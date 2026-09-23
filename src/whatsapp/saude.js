// Decisões do teste de vida, separadas da sessao.js pra poderem ser testadas —
// carregar a sessão abre o navegador.

// Estados em que o bot REALMENTE recebe mensagem. "isLogged" não está aqui de
// propósito: é autenticado mas ainda sincronizando, e nesse estado ele fica
// surdo. Em 13/09/2026 uma reconexão parou aí e ninguém percebeu por dois dias,
// porque a página respondia ao ping e o teste de vida passava.
const ESTADOS_ESCUTANDO = ['inChat', 'CONNECTED'];

// Quanto tempo se pode ficar em isLogged antes de considerar que travou.
// A sincronização normal leva de 15 a 60 segundos.
const LIMITE_ISLOGGED_MS = 4 * 60_000;

// Devolve o novo instante de início (ou null) e se é hora de reconectar.
// `desde` é quando o bot entrou em isLogged; null significa "não estava".
function avaliarSincronizacao(status, desde, agora, limite = LIMITE_ISLOGGED_MS) {
  if (ESTADOS_ESCUTANDO.includes(status)) return { desde: null, reconectar: false };
  if (status !== 'isLogged') return { desde, reconectar: false };
  if (desde == null) return { desde: agora, reconectar: false };
  if (agora - desde < limite) return { desde, reconectar: false };
  return { desde: null, reconectar: true, paradoMs: agora - desde };
}

module.exports = { avaliarSincronizacao, ESTADOS_ESCUTANDO, LIMITE_ISLOGGED_MS };
