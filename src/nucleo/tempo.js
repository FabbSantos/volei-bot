// Relógio de Brasília. O container roda em UTC; tudo que depende de "hoje",
// "que horas são" ou "que mês é" passa por aqui.
const TZ_BRASILIA = 'America/Sao_Paulo';

// 'AAAA-MM' no fuso de Brasília: a virada do mês tem que acontecer à
// meia-noite local, não às 21h
function mesAtual() {
  const partes = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ_BRASILIA,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  const ano = partes.find((p) => p.type === 'year').value;
  const mes = partes.find((p) => p.type === 'month').value;
  return `${ano}-${mes}`;
}

function agoraBrasilia() {
  const agora = new Date();
  return {
    dia: agora.toLocaleDateString('en-CA', { timeZone: TZ_BRASILIA }), // YYYY-MM-DD
    // hourCycle h23 explícito: com hour12:false, alguns ICU (ex: Node 20 do
    // container) usam ciclo 1-24 e meia-noite vira "24" — que passava no
    // filtro `>= LEMBRETE_HORA` e disparava o lembrete de madrugada
    hora: parseInt(
      new Intl.DateTimeFormat('en-GB', { timeZone: TZ_BRASILIA, hour: '2-digit', hourCycle: 'h23' }).format(agora),
      10
    ),
  };
}

module.exports = { TZ_BRASILIA, mesAtual, agoraBrasilia };
