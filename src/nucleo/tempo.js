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

// Dia da semana de uma data de jogo "DD/MM" ("sexta", "terça"...). A lista
// não guarda o ano: vale o ano que deixa a data mais perto de hoje (lista
// de 02/01 aberta em dezembro é do ano que vem). null se a data não existir.
const DIAS_DA_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

function diaDaSemanaDoJogo(dataJogo, agora = new Date()) {
  const m = String(dataJogo || '').match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  const [dia, mes] = [Number(m[1]), Number(m[2])];
  const ano = agora.getUTCFullYear();
  const candidatas = [ano - 1, ano, ano + 1]
    .map((a) => new Date(Date.UTC(a, mes - 1, dia)))
    .filter((d) => d.getUTCDate() === dia && d.getUTCMonth() === mes - 1); // 31/02 não existe
  if (candidatas.length === 0) return null;
  const maisPerto = candidatas.reduce((a, b) => (Math.abs(b - agora) < Math.abs(a - agora) ? b : a));
  return DIAS_DA_SEMANA[maisPerto.getUTCDay()];
}

module.exports = { TZ_BRASILIA, mesAtual, agoraBrasilia, diaDaSemanaDoJogo };
