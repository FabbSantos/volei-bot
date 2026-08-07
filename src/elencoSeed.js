// Importação única da planilha "Planejamento Volei Riachuelo" (estado de 31/07):
// o nível que cada votante deu (Iniciante/Intermediário/Avançado) vira voto
// 1-5 (I=2, M=3, A=4) aplicado aos 4 fundamentos. A partir daí a vida segue
// no painel, com granularidade real por fundamento.
const NIVEL_PARA_NOTA = { I: 2, M: 3, A: 4 };
const VOTANTES = ['Fabrício', 'Diego', 'Marcel', 'Bianca'];

// A pelada que a planilha registrava — quem estava lá jogou, então o import
// cria essa lista histórica pra todo mundo começar com presença 1
const PELADA_PLANILHA = { dataJogo: '31/07', nome: 'Pelada da planilha', criadaEm: '2026-07-31T21:00:00.000Z' };

// [nome, níveis na ordem dos votantes acima]
const ELENCO = [
  ['Marcel Garcia', 'MMMM'],
  ['Fabrício Bahiense', 'MMMM'],
  ['Kamila Vianna', 'MIMM'],
  ['Diego Borges', 'MMMI'],
  ['Camila Vitorino', 'IIII'],
  ['Thiago Prata', 'AMAM'],
  ['Andressa não Urach', 'IIII'],
  ['Marcelle', 'IIII'],
  ['Carlos Brugger', 'MMMM'],
  ['W. Luketa', 'AMMM'],
  ['Camila W.', 'MAMA'],
  ['Pedro Moura', 'IIII'],
  ['Ryan Araújo', 'MMMM'],
  ['Dvd', 'MMMM'],
  ['Thiago', 'IMMM'],
  ['Vini', 'AMAM'],
  ['Aces', 'AAAA'],
  ['Stephanie Bastos', 'IIII'],
];

// Apelidos conhecidos: o nome no WhatsApp difere do nome da planilha.
// [nome no elenco, apelidos no WhatsApp]
const APELIDOS = [
  ['Aces', ['A6']],
  ['Dvd', ['David']],
];

module.exports = { NIVEL_PARA_NOTA, VOTANTES, ELENCO, PELADA_PLANILHA, APELIDOS };
