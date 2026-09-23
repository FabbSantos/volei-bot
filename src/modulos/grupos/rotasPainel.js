// Rotas do painel sobre grupos
const grupos = require('./repositorio');

function rotasPainel(api) {
  api.get('/grupos', (req, res) => {
    res.json(grupos.listarGrupos().filter((g) => g.ativo && !g.eh_admin));
  });
}

module.exports = { rotasPainel };
