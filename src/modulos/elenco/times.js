// Montagem de times equilibrados a partir do elenco, e os times salvos por
// lista (sobrevivem a recarregar o painel e aceitam edição de última hora).
const { db, migrarColunas } = require('../../nucleo/banco');
const pelada = require('../pelada/repositorio');
const elenco = require('./repositorio');
const perfis = require('./perfis');

// A montagem de times fica salva por lista: sobrevive a recarregar a página,
// aceita edição (troca de última hora) e é a mesma que o bot mostra/envia
db.exec(`
  CREATE TABLE IF NOT EXISTS times_montados (
    lista_id INTEGER PRIMARY KEY,
    dados TEXT NOT NULL,
    atualizado_em TEXT NOT NULL,
    FOREIGN KEY (lista_id) REFERENCES listas(id)
  );
`);
// Qual montador gerou os times salvos: 'notas' (o de sempre) ou 'perfil'
migrarColunas('times_montados', { metodo: "TEXT NOT NULL DEFAULT 'notas'" });
// Montadores (13/11/2026): notas, perfil e sorteio (puro acaso). O comparar
// só põe lado a lado os dois que equilibram — sorteio não tem o que comparar.
const METODOS = ['notas', 'perfil', 'sorteio'];
const METODOS_COMPARAVEIS = ['notas', 'perfil'];

pelada.quandoApagarLista((listaId) => {
  db.prepare('DELETE FROM times_montados WHERE lista_id = ?').run(listaId);
});

// Draft em zigue-zague (serpentina): ordena do mais forte pro mais fraco e
// distribui 1..n, n..1, 1..n... — o mesmo método da planilha
// Espalha quem tem uma altura pelos times, trocando jogadores de nota
// parecida — assim dois bloqueadores não caem no mesmo time. Troca só
// acontece se o desequilíbrio for maior que 1 e a diferença de nota for
// pequena: o equilíbrio de habilidade continua mandando.
function equilibrarAltura(times, alturaAlvo, tolerancia = 1) {
  return espalhar(times, (j) => j.altura === alturaAlvo, tolerancia);
}

// O mesmo pra qualquer grupo: os altos, os 🔥 "desequilibra", os 😬 "puts".
// Um por time antes de repetir — é o que impede dois craques no mesmo time.
function espalhar(times, ehDoGrupo, tolerancia = 1) {
  const conta = (t) => t.filter(ehDoGrupo).length;
  for (let volta = 0; volta < 20; volta++) {
    const ordenados = [...times].sort((a, b) => conta(b) - conta(a));
    const cheio = ordenados[0];
    const vazio = ordenados[ordenados.length - 1];
    if (conta(cheio) - conta(vazio) <= 1) return;

    let melhor = null;
    for (const a of cheio.filter(ehDoGrupo)) {
      for (const b of vazio.filter((j) => !ehDoGrupo(j))) {
        const dif = Math.abs(a.nota - b.nota);
        if (!melhor || dif < melhor.dif) melhor = { a, b, dif };
      }
    }
    if (!melhor || melhor.dif > tolerancia) return; // não vale estragar a média
    cheio[cheio.indexOf(melhor.a)] = melhor.b;
    vazio[vazio.indexOf(melhor.b)] = melhor.a;
  }
}

// Depois do sorteio e do ajuste de altura as médias saem tortas: cada troca
// feita por altura mexe na nota e ninguém desfazia o estrago. Esta passada faz
// o caminho inverso — testa toda troca possível entre dois times, aplica a que
// mais aproxima as médias, e repete até nenhuma troca melhorar. Nunca aceita
// uma troca que piore a distribuição de altura já conquistada, então os dois
// critérios convivem em vez de brigar.
//
// Determinística de propósito: a mesma lista sempre produz os mesmos times,
// senão a prévia do #timesde não bateria com o que é enviado ao grupo.
function equilibrarMedias(times, maxVoltas = 60) {
  const media = (t) => (t.length ? t.reduce((s, j) => s + j.nota, 0) / t.length : 0);
  const espalhamento = () => {
    const medias = times.map(media);
    return Math.max(...medias) - Math.min(...medias);
  };
  // Altura E categoria: os 🔥 e os 😬 também ficam espalhados, nenhuma troca
  // de média pode juntar dois deles de novo
  const grupos = [(j) => j.altura === 'alto', (j) => j.altura === 'baixo', (j) => j.categoria === 4, (j) => j.categoria === 1];
  const desequilibrioAltura = () => {
    let pior = 0;
    for (const ehDoGrupo of grupos) {
      const contagens = times.map((t) => t.filter(ehDoGrupo).length);
      pior = Math.max(pior, Math.max(...contagens) - Math.min(...contagens));
    }
    return pior;
  };

  for (let volta = 0; volta < maxVoltas; volta++) {
    const atual = espalhamento();
    const alturaAtual = desequilibrioAltura();
    let melhor = null;

    for (let a = 0; a < times.length; a++) {
      for (let b = a + 1; b < times.length; b++) {
        for (let i = 0; i < times[a].length; i++) {
          for (let j = 0; j < times[b].length; j++) {
            const ja = times[a][i];
            const jb = times[b][j];
            if (ja.nota === jb.nota) continue; // troca que não muda média nenhuma

            times[a][i] = jb;
            times[b][j] = ja;
            const novoEspalhamento = espalhamento();
            const novaAltura = desequilibrioAltura();
            times[a][i] = ja;
            times[b][j] = jb;

            if (novaAltura > alturaAtual) continue; // altura é piso, não moeda de troca
            if (novoEspalhamento < atual - 1e-9 && (!melhor || novoEspalhamento < melhor.valor - 1e-9)) {
              melhor = { a, b, i, j, valor: novoEspalhamento };
            }
          }
        }
      }
    }

    if (!melhor) return; // nenhuma troca melhora: chegamos no melhor alcançável
    const { a, b, i, j } = melhor;
    const guardado = times[a][i];
    times[a][i] = times[b][j];
    times[b][j] = guardado;
  }
}

// ---- times salvos por lista -------------------------------------------------

function salvarTimes(listaId, times, metodo = 'notas') {
  const limpos = times.map((t, i) => ({
    numero: i + 1,
    jogadores: (t.jogadores || []).map((j) => ({
      nome: j.nome,
      nota: typeof j.nota === 'number' ? j.nota : 3,
      categoria: j.categoria ?? null,
      altura: j.altura ?? null,
      conhecido: Boolean(j.conhecido),
    })),
  }));
  db.prepare(`
    INSERT INTO times_montados (lista_id, dados, atualizado_em, metodo) VALUES (?, ?, ?, ?)
    ON CONFLICT(lista_id) DO UPDATE SET dados = excluded.dados, atualizado_em = excluded.atualizado_em, metodo = excluded.metodo
  `).run(listaId, JSON.stringify(limpos), new Date().toISOString(), METODOS.includes(metodo) ? metodo : 'notas');
  return getTimesSalvos(listaId);
}

// Recalcula média/altos na leitura — nunca confia em número guardado
function getTimesSalvos(listaId) {
  const row = db.prepare('SELECT dados, atualizado_em, metodo FROM times_montados WHERE lista_id = ?').get(listaId);
  if (!row) return null;
  const lista = pelada.getLista(listaId);
  const jogadores = lista ? elenco.listarJogadores(lista.chat_id) : [];
  const perfisDoGrupo = lista ? perfis.perfisDoGrupo(lista.chat_id) : new Map();
  const resolver = (nome) => (lista ? elenco.acharJogadorDaEntrada(lista.chat_id, { nome, numero: null }, jogadores) : null);
  let times;
  try {
    times = JSON.parse(row.dados);
  } catch {
    return null;
  }
  // Quem está no elenco vem com categoria/nota/altura de AGORA: o que foi
  // guardado é foto da hora da montagem e envelhece quando a galera vota de
  // novo (29/10/2026: David 🙂 no painel e 👍 no time salvo)
  const atualizar = (j) => {
    const atual = resolver(j.nome);
    if (!atual) return { ...j, ...perfis.PADRAO, temPerfil: false, jogador_id: null };
    const perfil = perfisDoGrupo.get(atual.id);
    return {
      ...j,
      jogador_id: atual.id,
      nota: atual.notaTime ?? j.nota,
      categoria: atual.categoria ?? null,
      altura: atual.altura ?? null,
      conhecido: atual.notaTime != null,
      ...(perfil || perfis.PADRAO),
      temPerfil: Boolean(perfil),
    };
  };
  return {
    atualizadoEm: row.atualizado_em,
    metodo: row.metodo || 'notas',
    times: times.map((t, i) => comResumo((t.jogadores || []).map(atualizar), i)),
  };
}

// O que cada time tem, nos dois olhares: média/altos (notas) e funções,
// meninas e saque (perfil) — é o que deixa comparar um montador com o outro
function comResumo(jogadores, i) {
  const n = jogadores.length;
  return {
    numero: i + 1,
    jogadores,
    media: n ? jogadores.reduce((s, j) => s + (j.nota ?? 3), 0) / n : 0,
    altos: jogadores.filter((j) => j.altura === 'alto').length,
    funcoes: perfis.funcoesDoTime(jogadores),
    meninas: jogadores.filter((j) => j.menina).length,
    saque: n ? jogadores.reduce((s, j) => s + (perfis.PESO_SAQUE[j.saque] ?? 2), 0) / n : 0,
  };
}

function apagarTimesSalvos(listaId) {
  db.prepare('DELETE FROM times_montados WHERE lista_id = ?').run(listaId);
}

// Cada participante com o que os dois montadores olham: nota/categoria/altura
// do elenco e o perfil de jogo (quem não tem perfil entra como Normal)
function avaliar(chatId, participantes) {
  const jogadores = elenco.listarJogadores(chatId);
  const perfisDoGrupo = perfis.perfisDoGrupo(chatId);
  return participantes.map((p) => {
    const jogador = elenco.acharJogadorDaEntrada(chatId, p, jogadores);
    const perfil = jogador ? perfisDoGrupo.get(jogador.id) : null;
    return {
      nome: p.nome,
      nota: jogador?.notaTime ?? 3, // desconhecido entra como mediano
      conhecido: Boolean(jogador?.notaTime != null),
      altura: jogador?.altura ?? null,
      categoria: jogador?.categoria ?? null,
      ...(perfil || perfis.PADRAO),
      temPerfil: Boolean(perfil),
    };
  });
}

// Zigue-zague: 1..n, n..1, 1..n — times do mesmo tamanho (no máximo 1 de diferença)
function serpentina(ordenados, quantidadeTimes) {
  const times = Array.from({ length: quantidadeTimes }, () => []);
  ordenados.forEach((j, i) => {
    const rodada = Math.floor(i / quantidadeTimes);
    const dentroDaRodada = i % quantidadeTimes;
    times[rodada % 2 === 0 ? dentroDaRodada : quantidadeTimes - 1 - dentroDaRodada].push(j);
  });
  return times;
}

// ---- montador por perfil (a planilha do Diego, 13/11/2026) -------------------
// Não olha nota nenhuma: espalha as funções que se destacam (pela regra
// Role1 → Role2), quem se destaca em geral, as meninas, os altos e o saque.
// O peso diz o que manda quando os critérios brigam: meninas primeiro (são
// poucas e todas baixas — duas no mesmo time pesa no ataque), depois funções.
const FUNCOES = perfis.ROLES.filter((r) => r !== 'Normal');
const PESOS_PERFIL = { meninas: 30, funcao: 10, saque: 8, destaques: 6, altos: 3 };

function custoPorPerfil(times) {
  const espalhamento = (valores) => Math.max(...valores) - Math.min(...valores);
  const contar = (ehDoGrupo) => espalhamento(times.map((t) => t.filter(ehDoGrupo).length));
  const funcoes = times.map(perfis.funcoesDoTime);
  const mediaSaque = (t) => (t.length ? t.reduce((s, j) => s + (perfis.PESO_SAQUE[j.saque] ?? 2), 0) / t.length : 0);
  let custo = 0;
  for (const f of FUNCOES) custo += PESOS_PERFIL.funcao * espalhamento(funcoes.map((c) => c[f] || 0));
  custo += PESOS_PERFIL.destaques * contar((j) => j.role1 !== 'Normal');
  custo += PESOS_PERFIL.meninas * contar((j) => j.menina);
  custo += PESOS_PERFIL.altos * contar((j) => j.altura === 'alto');
  custo += PESOS_PERFIL.saque * espalhamento(times.map(mediaSaque));
  return custo;
}

// Testa toda troca entre dois times e aplica a que mais baixa o custo, até
// nenhuma baixar. Só troca (nunca move): o tamanho dos times não muda.
function melhorarPorTrocas(times, custo, maxVoltas = 200) {
  let atual = custo(times);
  for (let volta = 0; volta < maxVoltas; volta++) {
    let melhor = null;
    for (let a = 0; a < times.length; a++) {
      for (let b = a + 1; b < times.length; b++) {
        for (let i = 0; i < times[a].length; i++) {
          for (let j = 0; j < times[b].length; j++) {
            const ja = times[a][i];
            const jb = times[b][j];
            times[a][i] = jb;
            times[b][j] = ja;
            const c = custo(times);
            times[a][i] = ja;
            times[b][j] = jb;
            if (c < atual - 1e-9 && (!melhor || c < melhor.c - 1e-9)) melhor = { a, b, i, j, c };
          }
        }
      }
    }
    if (!melhor) break;
    const { a, b, i, j } = melhor;
    [times[a][i], times[b][j]] = [times[b][j], times[a][i]];
    atual = melhor.c;
  }
  return atual;
}

// Determinístico como o das notas: a prévia do #timesde bate com o envio.
// Parte de alguns zigue-zagues diferentes e fica com o de menor custo — a
// busca por trocas sozinha às vezes empaca num arranjo "quase bom".
function montarTimesPorPerfil(chatId, quantidadeTimes, participantes) {
  const avaliados = avaliar(chatId, participantes);
  const porNome = (a, b) => a.nome.localeCompare(b.nome, 'pt-BR');
  const forca = (j) => (j.role1 !== 'Normal' ? 2 : 0) + (j.role2 !== 'Normal' ? 1 : 0) + (perfis.PESO_SAQUE[j.saque] ?? 2) / 4;
  const ordens = [
    (a, b) => forca(b) - forca(a) || porNome(a, b),
    (a, b) => (b.menina - a.menina) || forca(b) - forca(a) || porNome(a, b),
    (a, b) => (perfis.PESO_SAQUE[b.saque] ?? 2) - (perfis.PESO_SAQUE[a.saque] ?? 2) || porNome(a, b),
    porNome,
  ];
  let escolhido = null;
  for (const ordem of ordens) {
    const times = serpentina([...avaliados].sort(ordem), quantidadeTimes);
    const custo = melhorarPorTrocas(times, custoPorPerfil);
    if (!escolhido || custo < escolhido.custo - 1e-9) escolhido = { times, custo };
  }
  return escolhido.times.map((time, i) => comResumo(time, i));
}

function montarTimes(chatId, quantidadeTimes, participantes) {
  const avaliados = avaliar(chatId, participantes);

  avaliados.sort((a, b) => b.nota - a.nota);
  const times = serpentina(avaliados, quantidadeTimes);

  // Só mexe se alguém tiver altura marcada — sem isso, nada muda
  if (avaliados.some((j) => j.altura)) {
    equilibrarAltura(times, 'alto');
    equilibrarAltura(times, 'baixo');
  }

  // Os craques (🔥) um por time antes de repetir; os 😬 idem. A tolerância é
  // maior que a da altura: separar dois "desequilibra" vale mais que a média
  // perfeita ("contar mais", pedido de 28/10/2026)
  espalhar(times, (j) => j.categoria === 4, 1.5);
  espalhar(times, (j) => j.categoria === 1, 1.5);

  // Conserta as médias que o ajuste de altura (e o próprio zigue-zague)
  // deixaram tortas, sem devolver os altos todos pro mesmo time
  equilibrarMedias(times);

  return times.map((time, i) => comResumo(time, i));
}

// Sorteio puro: embaralha (Fisher-Yates) e distribui em rodízio — times do
// mesmo tamanho, sem olhar nota, perfil, nada. A avaliação só entra no resumo
// que os admins veem. Cada chamada sorteia de novo (por isso fica salvo).
function montarSorteio(chatId, quantidadeTimes, participantes, aleatorio = Math.random) {
  const gente = avaliar(chatId, participantes);
  for (let i = gente.length - 1; i > 0; i--) {
    const j = Math.floor(aleatorio() * (i + 1));
    [gente[i], gente[j]] = [gente[j], gente[i]];
  }
  const times = Array.from({ length: quantidadeTimes }, () => []);
  gente.forEach((p, i) => times[i % quantidadeTimes].push(p));
  return times.map((time, i) => comResumo(time, i));
}

// Um ponto de entrada pros montadores
function montarPorMetodo(metodo, chatId, quantidadeTimes, participantes) {
  if (metodo === 'perfil') return montarTimesPorPerfil(chatId, quantidadeTimes, participantes);
  if (metodo === 'sorteio') return montarSorteio(chatId, quantidadeTimes, participantes);
  return montarTimes(chatId, quantidadeTimes, participantes);
}

// O texto que o GRUPO vê: zero pista de como foi montado — nada de médias,
// notas ou método. Tecnologia da NASA e ponto. 🚀
// Mesmo formato no #timesde e no botão "anunciar" do painel. A única pista do
// montador é a "versão": notas = NASA 2, perfil = NASA 3.0 (pedido de 13/11/2026).
// Sorteio = versão "bugada", estilo MissingNo: símbolos aleatórios a cada
// anúncio. Sem * _ ~ ` (viram formatação no WhatsApp).
const VERSAO_NASA = { notas: 'NOVA TECNOLOGIA DA NASA 2', perfil: 'NOVA TECNOLOGIA DA NASA 3.0' };
const SIMBOLOS_BUG = '?#$@(!%&¿§¤¥▒░▓█¡ÆØ}{][)+=¦¶';
function versaoBugada(aleatorio = Math.random) {
  const n = 5 + Math.floor(aleatorio() * 3);
  return Array.from({ length: n }, () => SIMBOLOS_BUG[Math.floor(aleatorio() * SIMBOLOS_BUG.length)]).join('');
}
const versaoNasa = (metodo) => (metodo === 'sorteio'
  ? `TECNOLOGIA DA NASA ${versaoBugada()}`
  : VERSAO_NASA[metodo] || VERSAO_NASA.notas);

function anuncioDosTimes(dataJogo, times, metodo = 'notas') {
  const linhas = times.map((t, i) =>
    `⚔️ *Time ${i + 1}*\n${t.map((nome) => `• ${nome}`).join('\n')}`
  );
  return `🏐 *Times da pelada${dataJogo ? ` — ${dataJogo}` : ''}*\nMontados com a ${versaoNasa(metodo)} 🚀\n\n${linhas.join('\n\n')}\n\nBom jogo! 🔥`;
}

// Anúncio no grupo: como FOTO (nomes bem espaçados, 13/11/2026); se o print
// falhar ou o canal não tiver foto, sai o texto de sempre. Devolve 'foto'|'texto'.
async function anunciarNoGrupo({ enviarImagemHtml, enviarTexto }, dataJogo, nomesPorTime, metodo = 'notas') {
  if (enviarImagemHtml) {
    try {
      const imagemTimes = require('./imagemTimes');
      const html = imagemTimes.htmlAnuncio({ dataJogo, versao: versaoNasa(metodo), times: nomesPorTime });
      await enviarImagemHtml(html, `🏐 *Times da pelada${dataJogo ? ` — ${dataJogo}` : ''}* 🚀\nBom jogo! 🔥`);
      return 'foto';
    } catch (err) {
      console.warn(`[times] anúncio em foto falhou (${err.message}) — indo em texto`);
    }
  }
  await enviarTexto(anuncioDosTimes(dataJogo, nomesPorTime, metodo));
  return 'texto';
}

module.exports = {
  anunciarNoGrupo,
  METODOS, METODOS_COMPARAVEIS, montarSorteio, montarTimes, montarTimesPorPerfil, montarPorMetodo, custoPorPerfil, salvarTimes, getTimesSalvos, apagarTimesSalvos, equilibrarMedias, anuncioDosTimes, versaoNasa,
};
