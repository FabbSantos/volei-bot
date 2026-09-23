// Rotas do painel sobre mensalistas
const mensalistas = require('./repositorio');

function rotasPainel(api) {
  // Abre/fecha as inscrições de mensalista SEM anunciar no grupo — o painel é
  // a superfície silenciosa (o comando do bot avisa a galera de propósito)
  api.post('/prelista', (req, res) => {
    const { grupo, aberta } = req.body || {};
    if (!grupo) return res.status(400).json({ erro: 'grupo é obrigatório' });
    const ok = mensalistas.abrirPreLista(grupo, Boolean(aberta));
    if (!ok) return res.status(400).json({ erro: 'grupo não encontrado' });
    res.json({ aberta: Boolean(aberta) });
  });
}

module.exports = { rotasPainel };
