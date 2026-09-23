// Entende o horário que a pessoa pede: "sexta 20h-21h", "hoje 20h30-21h",
// "ontem 19h-20h", "25/09 20:00-21:30" ou só "20h-21h" (hoje).
// Sempre no passado: vídeo é do jogo que já aconteceu. "sexta" numa sexta é
// hoje; em qualquer outro dia, a última que passou.
const { normalizarTexto } = require('../../nucleo/texto');

const DIAS = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];

// "20h", "20h30", "20:30", "20" → { h, m }
function lerHora(texto) {
  const m = String(texto).trim().match(/^(\d{1,2})(?:(?:h|:)(\d{2})?)?h?$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

function lerDia(texto, agora) {
  const t = normalizarTexto(texto).replace(/-feira$/, '');
  const hoje = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
  if (!t || t === 'hoje') return hoje;
  if (t === 'ontem') return new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() - 1);

  const dia = DIAS.findIndex((d) => d === t || d.startsWith(t) && t.length >= 3);
  if (dia >= 0) {
    const volta = (hoje.getDay() - dia + 7) % 7;
    return new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() - volta);
  }

  const data = t.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (data) {
    const d = parseInt(data[1], 10);
    const mes = parseInt(data[2], 10) - 1;
    let resultado = new Date(hoje.getFullYear(), mes, d);
    // 28/12 pedido em janeiro é do ano passado
    if (resultado > hoje) resultado = new Date(hoje.getFullYear() - 1, mes, d);
    if (resultado.getMonth() !== mes || resultado.getDate() !== d) return null; // 31/02
    return resultado;
  }
  return null;
}

// Devolve { inicio, fim } (Date) ou { erro } com uma frase pronta pra responder
function lerPeriodo(texto, agora = new Date()) {
  const partes = String(texto || '').trim().split(/\s+/);
  const faixa = partes.pop() || '';
  const [textoInicio, textoFim] = faixa.split('-');
  const hInicio = lerHora(textoInicio || '');
  const hFim = lerHora(textoFim || '');
  if (!hInicio || !hFim) {
    return { erro: 'Não entendi o horário. Exemplos: *sexta 20h-21h*, *hoje 20h30-21h15*, *25/09 19h-20h*.' };
  }

  const dia = lerDia(partes.join(' '), agora);
  if (!dia) {
    return { erro: `Não entendi o dia "${partes.join(' ')}". Use hoje, ontem, um dia da semana ou DD/MM.` };
  }

  const inicio = new Date(dia.getFullYear(), dia.getMonth(), dia.getDate(), hInicio.h, hInicio.m);
  let fim = new Date(dia.getFullYear(), dia.getMonth(), dia.getDate(), hFim.h, hFim.m);
  if (fim <= inicio) fim = new Date(fim.getTime() + 24 * 60 * 60 * 1000); // 23h-1h vira a noite
  if (inicio > agora) {
    return { erro: 'Esse horário ainda não aconteceu 😅' };
  }
  return { inicio, fim };
}

module.exports = { lerPeriodo, lerHora };
