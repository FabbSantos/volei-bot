// Rotas do painel sobre a lista semanal
const pelada = require('./repositorio');

function rotasPainel(api) {
  // Encerrar/reabrir a lista sem mandar nada no grupo
  api.post('/lista/status', (req, res) => {
    const { grupo, aberta } = req.body || {};
    if (!grupo) return res.status(400).json({ erro: 'grupo é obrigatório' });
    const lista = pelada.getListaMaisRecente(grupo);
    if (!lista) return res.status(400).json({ erro: 'grupo sem lista' });
    if (aberta) pelada.reabrirLista(lista.id); else pelada.encerrarLista(lista.id);
    res.json({ data_jogo: lista.data_jogo, status: aberta ? 'aberta' : 'encerrada' });
  });
}

module.exports = { rotasPainel };
