// Os times como IMAGEM (13/11/2026): o texto do #timesde comparar ficava
// ilegível no celular. Aqui só se monta o HTML; quem tira o "print" é o Chrome
// do bot (whatsapp/print.js). Só admins veem: aparece categoria e perfil.
const perfis = require('./perfis');

const EMOJI_CATEGORIA = { 4: '🔥', 3: '👍', 2: '🙂', 1: '😬' };
const SAQUE_CURTO = {
  'Muito bom': ['MB', '#15803d', '#dcfce7'],
  Bom: ['B', '#3f7d20', '#ecfccb'],
  Normal: ['N', '#57534e', '#f5f5f4'],
  Regular: ['R', '#b45309', '#fef3c7'],
  Ruim: ['Ru', '#b91c1c', '#fee2e2'],
};
const CORES_TIME = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const decimal = (n) => (n ?? 2).toFixed(1).replace('.', ',');

function linhaJogador(j) {
  const funcoes = [j.role1, j.role2]
    .filter((r, i, a) => r && r !== 'Normal' && a.indexOf(r) === i)
    .map((r, i) => `<span class="f${i ? ' f2' : ''}" title="${esc(r)}">${perfis.EMOJI_ROLE[r] || ''}</span>`).join('');
  const [curto, cor, fundo] = SAQUE_CURTO[j.saque] || SAQUE_CURTO.Normal;
  return `<li>
    <span class="cat">${EMOJI_CATEGORIA[j.categoria] || '·'}</span>
    <span class="nome">${esc(j.nome)}</span>
    <span class="marcas">${j.menina ? '🎀' : ''}${j.altura === 'alto' ? '📏' : ''}${funcoes}</span>
    <span class="saque" style="color:${cor};background:${fundo}">${curto}</span>
  </li>`;
}

function cartaoTime(t, cor) {
  const cont = (pares) => pares.filter(([, n]) => n).map(([e, n]) => `<span class="chip">${e} ${n}</span>`).join('');
  const funcoes = cont(Object.entries(perfis.EMOJI_ROLE).map(([role, e]) => [e, t.funcoes?.[role] || 0]));
  const categorias = cont([4, 3, 2, 1].map((c) => [EMOJI_CATEGORIA[c], t.jogadores.filter((j) => j.categoria === c).length]));
  return `<section class="time" style="--cor:${cor}">
    <header><b>Time ${t.numero}</b><span>${t.jogadores.length} pessoas</span></header>
    <ul>${t.jogadores.map(linhaJogador).join('')}</ul>
    <footer>
      <div>${categorias || '<span class="chip">—</span>'}</div>
      <div>${funcoes}${cont([['🎀', t.meninas], ['📏', t.altos]])}<span class="chip forte">🏐 ${decimal(t.saque)}</span></div>
    </footer>
  </section>`;
}

// colunas: [{ titulo, times }] — uma coluna por montador (comparar) ou só uma
// (foto), e aí os times ficam lado a lado em vez de empilhados
function htmlDosTimes({ titulo, subtitulo, colunas }) {
  const umaSo = colunas.length === 1;
  const largura = umaSo ? Math.min(3, colunas[0].times.length) * 330 + 40 : colunas.length * 440 + 40;
  const corpo = colunas.map((c) => `<div class="coluna">
      ${c.titulo ? `<h2>${esc(c.titulo)}</h2>` : ''}
      <div class="${umaSo ? 'lado' : 'pilha'}">${c.times.map((t, i) => cartaoTime(t, CORES_TIME[i % CORES_TIME.length])).join('')}</div>
    </div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #f1f5f9; font-family: 'Liberation Sans', Arial, 'Noto Color Emoji', 'WenQuanYi Micro Hei', 'DejaVu Sans', sans-serif; color: #0f172a; }
  #quadro { width: ${largura}px; padding: 20px; }
  h1 { font-size: 22px; } .sub { color: #64748b; font-size: 14px; margin: 2px 0 14px; }
  .colunas { display: flex; gap: 16px; align-items: flex-start; }
  .coluna { flex: 1; min-width: 0; }
  h2 { font-size: 18px; margin-bottom: 8px; padding: 6px 10px; background: #0f172a; color: #fff; border-radius: 8px; }
  .pilha { display: flex; flex-direction: column; gap: 10px; }
  .lado { display: grid; grid-template-columns: repeat(${Math.min(3, colunas[0].times.length)}, 1fr); gap: 10px; }
  .time { background: #fff; border-radius: 10px; border-top: 5px solid var(--cor); box-shadow: 0 1px 3px rgba(0,0,0,.12); overflow: hidden; }
  .time header { display: flex; justify-content: space-between; align-items: baseline; padding: 8px 12px 4px; }
  .time header b { font-size: 17px; color: var(--cor); } .time header span { font-size: 12px; color: #94a3b8; }
  ul { list-style: none; padding: 0 8px; }
  li { display: flex; align-items: center; gap: 6px; padding: 4px 4px; border-bottom: 1px solid #f1f5f9; font-size: 15px; }
  li:last-child { border-bottom: 0; }
  .cat { width: 22px; text-align: center; }
  .nome { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .marcas { white-space: nowrap; } .f2 { opacity: .45; }
  .saque { font-size: 11px; font-weight: bold; min-width: 26px; text-align: center; padding: 2px 4px; border-radius: 5px; }
  footer { background: #f8fafc; padding: 6px 10px 8px; display: flex; flex-direction: column; gap: 4px; }
  .chip { display: inline-block; font-size: 13px; background: #e2e8f0; border-radius: 10px; padding: 1px 7px; margin: 0 4px 0 0; }
  .chip.forte { background: #0f172a; color: #fff; }
  .legenda { margin-top: 12px; font-size: 12px; color: #64748b; line-height: 1.5; }
  </style></head><body><div id="quadro">
  <h1>${esc(titulo)}</h1>${subtitulo ? `<div class="sub">${esc(subtitulo)}</div>` : ''}
  <div class="colunas">${corpo}</div>
  <div class="legenda">🔥👍🙂😬 categoria • 💥 batedor • 🧱 bloqueador • 🎯 levantador • 🛡️ defensor • 🙌 receptor (apagado = função 2) • 🎀 menina • 📏 alto<br>
  Saque: MB muito bom • B bom • N normal • R regular • Ru ruim — 🏐 média do time (0 a 4)</div>
  </div></body></html>`;
}

// A foto que o GRUPO recebe no "enviar": só os nomes, sem pista nenhuma de
// nota, função ou saque — igual ao texto de sempre, só que bonito.
// times: [[nome, ...], ...]
function htmlAnuncio({ dataJogo, versao, times }) {
  const porLinha = times.length === 4 ? 2 : Math.min(3, times.length);
  const largura = porLinha * 320 + (porLinha - 1) * 18 + 56;
  const cartoes = times.map((nomes, i) => {
    const cor = CORES_TIME[i % CORES_TIME.length];
    return `<section class="time" style="--cor:${cor}">
      <header>⚔️ TIME ${i + 1}</header>
      <ol>${nomes.map((n) => `<li>${esc(n)}</li>`).join('')}</ol>
      <div class="barra"></div>
    </section>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Liberation Sans', Arial, 'Noto Color Emoji', 'WenQuanYi Micro Hei', 'DejaVu Sans', sans-serif; }
  #quadro { width: ${largura}px; padding: 28px; background: linear-gradient(160deg, #0f172a, #1e3a8a); color: #fff; }
  .topo { text-align: center; margin-bottom: 22px; }
  h1 { font-size: 30px; letter-spacing: .5px; }
  .versao { margin-top: 6px; font-size: 15px; color: #fde68a; letter-spacing: 1px; }
  .grade { display: grid; grid-template-columns: repeat(${porLinha}, 1fr); gap: 18px; }
  .time { background: #fff; color: #0f172a; border-radius: 14px; overflow: hidden; box-shadow: 0 6px 18px rgba(0,0,0,.35); display: flex; flex-direction: column; }
  .time header { background: var(--cor); color: #fff; font-weight: bold; font-size: 20px; letter-spacing: 1.5px; padding: 12px 18px; }
  ol { list-style: none; counter-reset: n; padding: 10px 18px 14px; flex: 1; }
  li { counter-increment: n; font-size: 20px; padding: 9px 0; border-bottom: 1px solid #e2e8f0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  li:last-child { border-bottom: 0; }
  li::before { content: counter(n); display: inline-block; width: 26px; color: var(--cor); font-weight: bold; font-size: 16px; }
  .barra { height: 8px; background: var(--cor); }
  .rodape { text-align: center; margin-top: 22px; font-size: 20px; }
  </style></head><body><div id="quadro">
  <div class="topo"><h1>🏐 Times da pelada${dataJogo ? ` — ${esc(dataJogo)}` : ''}</h1>
  <div class="versao">Montados com a ${esc(versao)} 🚀</div></div>
  <div class="grade">${cartoes}</div>
  <div class="rodape">Bom jogo! 🔥</div>
  </div></body></html>`;
}

module.exports = { htmlDosTimes, htmlAnuncio };
