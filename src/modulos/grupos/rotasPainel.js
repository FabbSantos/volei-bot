// Rotas do painel sobre grupos
const grupos = require('./repositorio');

function rotasPainel(api) {
  api.get('/grupos', (req, res) => {
    // Sem votantes_ignorados: quem conta nas médias é decisão do dono do
    // bot, só no privado — o painel é aberto pra todos os admins
    res.json(grupos.listarGrupos()
      .filter((g) => g.ativo && !g.eh_admin)
      .map(({ votantes_ignorados, ...g }) => g));
  });
}

module.exports = { rotasPainel };
