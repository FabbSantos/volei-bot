// Montagem de times equilibrados a partir do elenco, e os times salvos por
// lista (sobrevivem a recarregar o painel e aceitam edição de última hora).
const { db } = require('../../nucleo/banco');
const pelada = require('../pelada/repositorio');
const elenco = require('./repositorio');

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
  const conta = (t) => t.filter((j) => j.altura === alturaAlvo).length;
  for (let volta = 0; volta < 20; volta++) {
    const ordenados = [...times].sort((a, b) => conta(b) - conta(a));
    const cheio = ordenados[0];
    const vazio = ordenados[ordenados.length - 1];
    if (conta(cheio) - conta(vazio) <= 1) return;

    let melhor = null;
    for (const a of cheio.filter((j) => j.altura === alturaAlvo)) {
      for (const b of vazio.filter((j) => j.altura !== alturaAlvo)) {
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
  const desequilibrioAltura = () => {
    let pior = 0;
    for (const alvo of ['alto', 'baixo']) {
      const contagens = times.map((t) => t.filter((j) => j.altura === alvo).length);
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

function salvarTimes(listaId, times) {
  const limpos = times.map((t, i) => ({
    numero: i + 1,
    jogadores: (t.jogadores || []).map((j) => ({
      nome: j.nome,
      nota: typeof j.nota === 'number' ? j.nota : 3,
      altura: j.altura ?? null,
      conhecido: Boolean(j.conhecido),
    })),
  }));
  db.prepare(`
    INSERT INTO times_montados (lista_id, dados, atualizado_em) VALUES (?, ?, ?)
    ON CONFLICT(lista_id) DO UPDATE SET dados = excluded.dados, atualizado_em = excluded.atualizado_em
  `).run(listaId, JSON.stringify(limpos), new Date().toISOString());
  return getTimesSalvos(listaId);
}

// Recalcula média/altos na leitura — nunca confia em número guardado
function getTimesSalvos(listaId) {
  const row = db.prepare('SELECT dados, atualizado_em FROM times_montados WHERE lista_id = ?').get(listaId);
  if (!row) return null;
  const lista = pelada.getLista(listaId);
  const jogadores = lista ? elenco.listarJogadores(lista.chat_id) : [];
  const resolver = (nome) => {
    const j = lista ? elenco.acharJogadorDaEntrada(lista.chat_id, { nome, numero: null }, jogadores) : null;
    return j ? j.id : null;
  };
  let times;
  try {
    times = JSON.parse(row.dados);
  } catch {
    return null;
  }
  return {
    atualizadoEm: row.atualizado_em,
    times: times.map((t, i) => ({
      numero: i + 1,
      jogadores: (t.jogadores || []).map((j) => ({ ...j, jogador_id: resolver(j.nome) })),
      media: t.jogadores?.length ? t.jogadores.reduce((s, j) => s + (j.nota ?? 3), 0) / t.jogadores.length : 0,
      altos: (t.jogadores || []).filter((j) => j.altura === 'alto').length,
    })),
  };
}

function apagarTimesSalvos(listaId) {
  db.prepare('DELETE FROM times_montados WHERE lista_id = ?').run(listaId);
}

function montarTimes(chatId, quantidadeTimes, participantes) {
  const jogadores = elenco.listarJogadores(chatId);
  const avaliados = participantes.map((p) => {
    const jogador = elenco.acharJogadorDaEntrada(chatId, p, jogadores);
    return {
      nome: p.nome,
      nota: jogador?.notaTime ?? 3, // desconhecido entra como mediano
      conhecido: Boolean(jogador?.notaTime != null),
      altura: jogador?.altura ?? null,
    };
  });

  avaliados.sort((a, b) => b.nota - a.nota);
  const times = Array.from({ length: quantidadeTimes }, () => []);
  avaliados.forEach((j, i) => {
    const rodada = Math.floor(i / quantidadeTimes);
    const dentroDaRodada = i % quantidadeTimes;
    const indice = rodada % 2 === 0 ? dentroDaRodada : quantidadeTimes - 1 - dentroDaRodada;
    times[indice].push(j);
  });

  // Só mexe se alguém tiver altura marcada — sem isso, nada muda
  if (avaliados.some((j) => j.altura)) {
    equilibrarAltura(times, 'alto');
    equilibrarAltura(times, 'baixo');
  }

  // Conserta as médias que o ajuste de altura (e o próprio zigue-zague)
  // deixaram tortas, sem devolver os altos todos pro mesmo time
  equilibrarMedias(times);

  return times.map((time, i) => ({
    numero: i + 1,
    jogadores: time,
    media: time.length ? time.reduce((s, j) => s + j.nota, 0) / time.length : 0,
    altos: time.filter((j) => j.altura === 'alto').length,
  }));
}

// O texto que o GRUPO vê: zero pista de como foi montado — nada de médias,
// notas ou método. Tecnologia da NASA e ponto. 🚀
// Mesmo formato no #timesde e no botão "anunciar" do painel.
function anuncioDosTimes(dataJogo, times) {
  const linhas = times.map((t, i) =>
    `⚔️ *Time ${i + 1}*\n${t.map((nome) => `• ${nome}`).join('\n')}`
  );
  return `🏐 *Times da pelada${dataJogo ? ` — ${dataJogo}` : ''}*\nMontados com tecnologia da NASA 🚀\n\n${linhas.join('\n\n')}\n\nBom jogo! 🔥`;
}

module.exports = { montarTimes, salvarTimes, getTimesSalvos, apagarTimesSalvos, equilibrarMedias, anuncioDosTimes };
