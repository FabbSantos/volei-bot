// Comprovantes automáticos: as regras de decisão (sem API) e o fluxo inteiro
// com um "Claude de mentira" — quem paga por quem, valor pra duas pessoas,
// comprovante repetido, pergunta aos admins e o aprendizado depois.
// Os casos são os da pelada: Fabrício paga a Kamila, Thiago paga a Duda.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'volei-comprovante-'));
process.env.DB_PATH = path.join(pasta, 'teste.db');
process.env.PIX_RECEBEDOR = 'Marcel Garcia Von Rondon';
delete process.env.COMPROVANTES;

const grupos = require('../src/modulos/grupos/repositorio');
const pelada = require('../src/modulos/pelada/repositorio');
const { decidir, recebedorConfere, nomeCasa } = require('../src/modulos/comprovantes/decisor');
const comprovantes = require('../src/modulos/comprovantes');
const repo = require('../src/modulos/comprovantes/repositorio');
const { processarComandoAdmin } = require('../src/roteador');
const { fecharBanco } = require('../src/nucleo/banco');

let falhas = 0;
function caso(nome, fn) {
  try {
    fn();
    console.log(`  ok  ${nome}`);
  } catch (err) {
    falhas++;
    console.log(`  FALHOU  ${nome}\n          ${err.message}`);
  }
}

// "2026-10-09T20:31" no horário de Brasília, a partir de um instante
const dataHoraBr = (ms) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};
const AGORA = Date.now();

const leitura = (extra = {}) => ({
  eh_comprovante_pix: true, situacao: 'concluido', valor_centavos: 1200, data_hora: dataHoraBr(AGORA - 3600_000),
  pagador_nome: 'Fulano de Tal', recebedor_nome: 'MARCEL GARCIA VON RONDON', recebedor_chave: null,
  id_transacao: `E${Math.random().toString(36).slice(2)}`, legenda_para: [], legenda_inclui_remetente: false, ...extra,
});

// ---------------------------------------------------------------- decisor
console.log('\nregras do comprovante');

caso('recebedor: nome do banco em vários formatos', () => {
  for (const ok of ['MARCEL GARCIA VON RONDON', 'Marcel G V Rondon', 'MARCEL G*** V** R*****', 'marcel garcia']) {
    assert.ok(recebedorConfere(ok, 'Marcel Garcia Von Rondon'), ok);
  }
  for (const ruim of ['Marcel', 'Marcelle Garcia', 'Marcel Souza', 'Diego Garcia', null]) {
    assert.ok(!recebedorConfere(ruim, 'Marcel Garcia Von Rondon'), String(ruim));
  }
});
caso('nome da lista casa com o nome do pagador', () => {
  assert.ok(nomeCasa('Diego', 'Diego Borges Silva'));
  assert.ok(nomeCasa('Fabrício Bahiense', 'FABRICIO BAHIENSE SANTOS'));
  assert.ok(!nomeCasa('Kamila Vianna', 'Fabricio Bahiense Santos'));
  assert.ok(!nomeCasa('Paulo Ribeiro (cvd Marcel)', 'Marcel Garcia'));
});

const LISTA = { id: 1, valor_centavos: 1200, criada_em: new Date(AGORA - 2 * 86400_000).toISOString() };
const e = (id, nome, numero, extra = {}) => ({ id, nome, numero, pago: 0, mensalista: 0, tipo: 'principal', ...extra });
const FAB = '5521968240663@c.us';
const KAMILA = '5521965201526@c.us';
const THIAGO = '5521965791781@c.us';
const DUDA = '5521973010217@c.us';
const base = {
  lista: LISTA, recebedorEsperado: 'Marcel Garcia Von Rondon', usado: null, agora: new Date(AGORA),
  entradas: [
    e(1, 'Fabrício Bahiense', 'manual-1@bot', { mensalista: 1 }),
    e(2, 'Kamila Vianna', KAMILA),
    e(3, 'Thiago Rodrigues', THIAGO),
    e(4, 'Duda', DUDA),
    e(5, 'Ryan', '5521900000005@c.us'),
  ],
};
const dec = (extra) => decidir({ ...base, ...extra });
const alvos = (d) => (d.alvos || []).map((a) => a.nome).sort().join(', ');

caso('foto qualquer: ignora calado', () =>
  assert.strictEqual(dec({ leitura: leitura({ eh_comprovante_pix: false }), remetente: '5521900000005@c.us' }).acao, 'ignorar'));
caso('Ryan paga os R$ 12 dele: marca o Ryan', () =>
  assert.strictEqual(alvos(dec({ leitura: leitura(), remetente: '5521900000005@c.us' })), 'Ryan'));
caso('Fabrício (mensalista) manda R$ 12 e paga pela Kamila: marca a Kamila', () =>
  assert.strictEqual(alvos(dec({ leitura: leitura({ pagador_nome: 'FABRICIO B SANTOS' }), remetente: FAB, dependentes: [{ dependente_nome: 'Kamila Vianna', dependente_numero: KAMILA }] })), 'Kamila Vianna'));
caso('a Kamila manda o comprovante que o Fabrício pagou: marca a Kamila', () =>
  assert.strictEqual(alvos(dec({ leitura: leitura({ pagador_nome: 'Fabricio Bahiense Santos' }), remetente: KAMILA })), 'Kamila Vianna'));
caso('Thiago manda R$ 24 sem legenda: ele e a Duda', () =>
  assert.strictEqual(alvos(dec({ leitura: leitura({ valor_centavos: 2400 }), remetente: THIAGO, dependentes: [{ dependente_nome: 'Duda', dependente_numero: DUDA }] })), 'Duda, Thiago Rodrigues'));
caso('Thiago manda R$ 12 sem legenda, os dois devendo: pergunta', () => {
  const d = dec({ leitura: leitura(), remetente: THIAGO, dependentes: [{ dependente_nome: 'Duda', dependente_numero: DUDA }] });
  assert.strictEqual(d.acao, 'perguntar');
  assert.match(d.motivo, /Thiago Rodrigues, Duda/);
});
caso('Thiago manda R$ 12 com legenda "da Duda": marca a Duda', () =>
  assert.strictEqual(alvos(dec({ leitura: leitura({ legenda_para: ['Duda'] }), remetente: THIAGO })), 'Duda'));
caso('Thiago manda R$ 12 com legenda "é meu", os dois devendo: marca só ele', () =>
  assert.strictEqual(alvos(dec({ leitura: leitura({ legenda_inclui_remetente: true }), remetente: THIAGO, dependentes: [{ dependente_nome: 'Duda', dependente_numero: DUDA }] })), 'Thiago Rodrigues'));
caso('e depois "da Duda", com ele já pago: marca a Duda', () => {
  const entradas = base.entradas.map((x) => (x.nome === 'Thiago Rodrigues' ? { ...x, pago: 1 } : x));
  assert.strictEqual(alvos(dec({ entradas, leitura: leitura({ legenda_para: ['Duda'] }), remetente: THIAGO, dependentes: [{ dependente_nome: 'Duda', dependente_numero: DUDA }] })), 'Duda');
});
caso('na ordem inversa: "da Duda" primeiro, depois "é meu"', () => {
  const dep = [{ dependente_nome: 'Duda', dependente_numero: DUDA }];
  assert.strictEqual(alvos(dec({ leitura: leitura({ legenda_para: ['Duda'] }), remetente: THIAGO, dependentes: dep })), 'Duda');
  const entradas = base.entradas.map((x) => (x.nome === 'Duda' ? { ...x, pago: 1 } : x));
  assert.strictEqual(alvos(dec({ entradas, leitura: leitura({ legenda_inclui_remetente: true }), remetente: THIAGO, dependentes: dep })), 'Thiago Rodrigues');
});
// Pelada de 16/10: Thiago na principal, Duda na ESPERA, nenhum dos dois com legenda
{
  const dep = [{ dependente_nome: 'Duda', dependente_numero: DUDA }];
  const dudaNaEspera = base.entradas.map((x) => (x.nome === 'Duda' ? { ...x, tipo: 'espera' } : x));
  caso('16/10: Thiago paga R$ 12 com a Duda na espera — é dele', () =>
    assert.strictEqual(alvos(dec({ entradas: dudaNaEspera, leitura: leitura(), remetente: THIAGO, dependentes: dep })), 'Thiago Rodrigues'));
  const dudaSubiu = base.entradas.map((x) => (x.nome === 'Thiago Rodrigues' ? { ...x, pago: 1 } : x));
  caso('16/10: a Duda sobe, Thiago (já pago) paga mais R$ 12 — é dela', () =>
    assert.strictEqual(alvos(dec({ entradas: dudaSubiu, leitura: leitura(), remetente: THIAGO, dependentes: dep })), 'Duda'));
  caso('Thiago paga R$ 24 com a Duda ainda na espera — os dois', () =>
    assert.strictEqual(alvos(dec({ entradas: dudaNaEspera, leitura: leitura({ valor_centavos: 2400 }), remetente: THIAGO, dependentes: dep })), 'Duda, Thiago Rodrigues'));
}
caso('legenda "eu e a Duda" com R$ 24: os dois', () =>
  assert.strictEqual(alvos(dec({ leitura: leitura({ valor_centavos: 2400, legenda_para: ['Duda'], legenda_inclui_remetente: true }), remetente: THIAGO })), 'Duda, Thiago Rodrigues'));
caso('Pix pra outra pessoa: pergunta', () =>
  assert.match(dec({ leitura: leitura({ recebedor_nome: 'Diego Borges' }), remetente: THIAGO }).motivo, /não pro Marcel/));
caso('Pix agendado: pergunta', () =>
  assert.match(dec({ leitura: leitura({ situacao: 'agendado' }), remetente: THIAGO }).motivo, /AGENDADO/));
caso('comprovante repetido: pergunta', () =>
  assert.match(dec({ leitura: leitura(), remetente: '5521900000005@c.us', usado: { criado_em: new Date().toISOString(), remetente_nome: 'Ryan' } }).motivo, /já foi usado/));
caso('Pix da semana passada: pergunta', () =>
  assert.match(dec({ leitura: leitura({ data_hora: dataHoraBr(AGORA - 9 * 86400_000) }), remetente: '5521900000005@c.us' }).motivo, /antes dessa lista abrir/));
caso('R$ 53 é mensalidade, não lista: pergunta e diz o comando', () =>
  assert.match(dec({ leitura: leitura({ valor_centavos: 5300 }), remetente: THIAGO, valorMes: 5300 }).motivo, /#pagomesde/));
caso('quem mandou não deve nada e não paga por ninguém: pergunta', () =>
  assert.strictEqual(dec({ leitura: leitura(), remetente: '5521911111111@c.us' }).acao, 'perguntar'));
caso('legenda cita quem já pagou: pergunta', () => {
  const entradas = base.entradas.map((x) => (x.nome === 'Duda' ? { ...x, pago: 1 } : x));
  assert.match(dec({ entradas, leitura: leitura({ legenda_para: ['Duda'] }), remetente: THIAGO }).motivo, /já está pago/);
});

// Como o bot entende a resposta à pergunta "é teu ou é pra Duda?"
{
  const { interpretarResposta } = comprovantes;
  const pend = [e(3, 'Thiago Rodrigues', THIAGO), e(4, 'Duda', DUDA), e(6, 'Lucas (cvd Ryan)', 'manual-1@bot'), e(7, 'Diego', 'x'), e(8, 'Diego B', 'y')];
  const r = (texto) => (interpretarResposta(texto, pend, [3, 4], [3]) || []).map((x) => x.nome).sort().join(', ') || null;
  caso('resposta "meu" → quem enviou', () => assert.strictEqual(r('meu'), 'Thiago Rodrigues'));
  caso('resposta "é pra mim" → quem enviou', () => assert.strictEqual(r('é pra mim'), 'Thiago Rodrigues'));
  caso('resposta "eu" sozinho → quem enviou', () => assert.strictEqual(r('eu'), 'Thiago Rodrigues'));
  caso('resposta "da Duda" → Duda', () => assert.strictEqual(r('da Duda'), 'Duda'));
  caso('resposta "eu paguei pra Duda" → só a Duda (o "eu" é sujeito)', () => assert.strictEqual(r('eu paguei pra Duda'), 'Duda'));
  caso('resposta "eu e a Duda" → os dois', () => assert.strictEqual(r('eu e a Duda'), 'Duda, Thiago Rodrigues'));
  caso('resposta "os dois" → os candidatos', () => assert.strictEqual(r('os dois'), 'Duda, Thiago Rodrigues'));
  caso('resposta "do Lucas" → o convidado, mesmo fora dos candidatos', () => assert.strictEqual(r('do Lucas'), 'Lucas (cvd Ryan)'));
  caso('dois "Diego" devendo: não chuta', () => assert.strictEqual(r('do Diego'), null));
  caso('"blz" não é resposta', () => assert.strictEqual(r('blz'), null));
}

// ------------------------------------------------------------ fluxo inteiro
async function fluxo() {
  console.log('\ncomprovante de ponta a ponta (Claude de mentira)');
  const G = 'pelada@g.us';
  const ADM = 'adm@g.us';
  grupos.registrarGrupoSeNovo(G, 'Vôlei no Riachuelo');
  grupos.ativarGrupo(G);
  grupos.registrarGrupoSeNovo(ADM, 'Admins');
  grupos.marcarGrupoAdmin(ADM, true);
  const { lista } = pelada.criarLista(G, '09/10', null, 1200);
  pelada.adicionarEntrada(lista.id, 'Thiago Rodrigues', THIAGO);
  pelada.adicionarEntrada(lista.id, 'Duda', DUDA);
  pelada.adicionarEntrada(lista.id, 'Ryan', '5521900000005@c.us');
  const grupo = grupos.getGrupo(G);

  const enviados = [];
  let proximoId = 0;
  const enviar = async (chatId, t, opcoes) => {
    const id = `bot-${++proximoId}`;
    enviados.push({ para: chatId, t, id, mencoes: opcoes?.mentionedList || [] });
    return { id };
  };
  const porta = (numero, pushname, legenda = '') => ({
    body: legenda, pushname, chatId: G, numero, nomeGrupo: 'Vôlei no Riachuelo',
    midia: { mimetype: 'image/jpeg', baixar: async () => Buffer.from('imagem') },
    reply: async (t) => enviados.push({ para: G, t }),
    enviarPara: enviar,
    enviarFigurinha: async () => {},
    enviarFigurinhaPara: async (chatId) => enviados.push({ para: chatId, t: '[figurinha]' }),
  });
  // Mensagem de texto no grupo (a resposta à pergunta do bot, ou conversa)
  const fala = (numero, pushname, texto, idCitado = null) => comprovantes.tentarResposta({
    ...porta(numero, pushname, texto), midia: null, idCitado,
  }, grupo);
  const comLeitura = (l) => ({ ler: async ({ nomesDaLista }) => { assert.ok(nomesDaLista.includes('Duda')); return l; } });
  const pago = (nome) => pelada.listarCombinada(lista.id).find((x) => x.nome === nome).pago === 1;
  const perguntaNoGrupo = () => [...enviados].reverse().find((m) => m.para === G && /^🤔/.test(m.t));
  const ultimoComprovante = () => {
    const m = [...enviados].reverse().find((x) => x.para === ADM && /Comprovante (\d+)/.test(x.t));
    return m && m.t.match(/Comprovante (\d+)/)[1];
  };

  // Ryan paga o dele
  const doRyan = leitura({ id_transacao: 'E-RYAN-1' });
  await comprovantes.receber(porta('5521900000005@c.us', 'Ryan'), grupo, comLeitura(doRyan));
  caso('Ryan enviou: marcou sozinho', () => assert.ok(pago('Ryan')));
  caso('e comemorou no grupo com figurinha', () => {
    assert.ok(enviados.some((m) => m.para === G && /Ryan pagou! ✅/.test(m.t)));
    assert.ok(enviados.some((m) => m.para === G && m.t === '[figurinha]'));
  });
  caso('e avisou os admins do automático', () => assert.ok(enviados.some((m) => m.para === ADM && /🤖✅ \*Ryan\*/.test(m.t))));

  // O mesmo comprovante de novo: problema de verdade, só pros admins
  enviados.length = 0;
  await comprovantes.receber(porta('5521900000005@c.us', 'Ryan'), grupo, comLeitura(doRyan));
  caso('comprovante repetido: só os admins ficam sabendo', () => {
    assert.ok(enviados.some((m) => m.para === ADM && /já foi usado/.test(m.t)));
    assert.ok(!perguntaNoGrupo());
  });

  const respostas = [];
  const admin = (texto) => processarComandoAdmin({
    body: texto, origem: 'grupoadmin', chatId: ADM,
    reply: async (t) => respostas.push(t),
    enviarPara: enviar,
    enviarFigurinhaPara: async () => {},
  });

  // O Ryan (já pago) envia mais R$ 12 — é do convidado dele. O bot pergunta
  // pra ELE no grupo, e a resposta resolve sem admin
  pelada.adicionarEntrada(lista.id, 'Lucas (cvd Ryan)', 'manual-123@bot');
  enviados.length = 0;
  await comprovantes.receber(porta('5521900000005@c.us', 'Ryan'), grupo, comLeitura(leitura({ id_transacao: 'E-RYAN-2' })));
  const p1 = perguntaNoGrupo();
  caso('Ryan já pago envia outro: pergunta NO GRUPO, marcando ele', () => {
    assert.ok(p1, JSON.stringify(enviados));
    assert.match(p1.t, /@5521900000005, recebi teu Pix de R\$ 12,00\. Pra quem é\?/);
    assert.deepStrictEqual(p1.mencoes, ['5521900000005@c.us']);
  });
  caso('e os admins só recebem um aviso de que ele foi perguntado', () =>
    assert.ok(enviados.some((m) => m.para === ADM && /Perguntei pro Ryan no grupo/.test(m.t))));
  caso('ninguém marcado ainda', () => assert.ok(!pago('Lucas (cvd Ryan)')));
  const id1 = ultimoComprovante();
  const tratou = await fala('5521900000005@c.us', 'Ryan', 'é do Lucas');
  caso('"é do Lucas" (sem citar, curto) marca o Lucas', () => assert.ok(tratou && pago('Lucas (cvd Ryan)')));
  caso('e aprende que o Ryan paga pelo Lucas', () =>
    assert.deepStrictEqual(repo.dependentesDe(G, '5521900000005@c.us').map((d) => d.dependente_nome), ['Lucas (cvd Ryan)']));
  caso('e conta pros admins que ele respondeu', () =>
    assert.ok(enviados.some((m) => m.para === ADM && /Ryan respondeu no grupo: comprovante \d+ → Lucas/.test(m.t))));
  await admin(`#comprovante ${id1} Lucas`);
  caso('resolver de novo pelo admin não marca duas vezes', () => assert.match(respostas.at(-1), /já foi resolvido/));
  const depois = await fala('5521900000005@c.us', 'Ryan', 'meu');
  caso('depois de resolvido, mensagem do Ryan não é mais resposta', () => assert.strictEqual(depois, false));

  // Thiago paga a Duda; R$ 12 sem legenda com os dois devendo. Ele não
  // responde, e um admin resolve
  await admin('#pagapor riachuelo Thiago > Duda');
  caso('#pagapor cadastra pelo nome', () => assert.match(respostas.at(-1), /Thiago Rodrigues → Duda/));
  enviados.length = 0;
  await comprovantes.receber(porta(THIAGO, 'Thiago Rodrigues'), grupo, comLeitura(leitura({ id_transacao: 'E-THIAGO-1' })));
  caso('Thiago R$ 12, os dois devendo: "É teu ou é pra Duda?"', () => {
    assert.ok(!pago('Thiago Rodrigues') && !pago('Duda'));
    assert.match(perguntaNoGrupo()?.t || '', /É teu ou é pra Duda\?/);
  });
  await admin(`#comprovante ${ultimoComprovante()} Duda`);
  caso('o admin resolve com #comprovante N Duda', () => assert.ok(pago('Duda') && !pago('Thiago Rodrigues')));
  await comprovantes.receber(porta(THIAGO, 'Thiago Rodrigues'), grupo, comLeitura(leitura({ id_transacao: 'E-THIAGO-2' })));
  caso('próximo comprovante do Thiago: marca ele sozinho', () => assert.ok(pago('Thiago Rodrigues')));

  // As respostas que valem e as que NÃO podem valer
  pelada.adicionarEntrada(lista.id, 'Ana', '5521900000011@c.us');
  pelada.adicionarEntrada(lista.id, 'Bento (cvd Ana)', 'manual-456@bot');
  await admin('#pagapor riachuelo Ana > Bento');
  enviados.length = 0;
  await comprovantes.receber(porta('5521900000011@c.us', 'Ana'), grupo, comLeitura(leitura({ id_transacao: 'E-ANA-1' })));
  const pAna = perguntaNoGrupo();
  caso('Ana: "É teu ou é pra Bento (cvd Ana)?"', () => assert.match(pAna?.t || '', /É teu ou é pra Bento \(cvd Ana\)\?/));
  const outro = await fala('5521900000005@c.us', 'Ryan', 'meu');
  caso('outra pessoa dizendo "meu" não responde pela Ana', () => assert.ok(outro === false && !pago('Ana') && !pago('Bento (cvd Ana)')));
  const conversa = await fala('5521900000011@c.us', 'Ana', 'o Bento vai atrasar hoje viu galera');
  caso('conversa longa sem citar a pergunta não vira resposta', () => assert.ok(conversa === false && !pago('Bento (cvd Ana)')));
  enviados.length = 0;
  const demais = await fala('5521900000011@c.us', 'Ana', 'eu e o Bento', pAna.id);
  caso('"eu e o Bento" pra R$ 12: não marca e explica que é uma pessoa', () => {
    assert.ok(demais && !pago('Ana') && !pago('Bento (cvd Ana)'));
    assert.ok(enviados.some((m) => /dá pra 1 pessoa\(s\), e eu entendi Ana e Bento/.test(m.t)), JSON.stringify(enviados));
  });
  const certa = await fala('5521900000011@c.us', 'Ana', 'paguei esse pro Bento, o meu eu pago depois', pAna.id);
  caso('citando a pergunta, "pro Bento, o meu eu pago depois" é ambíguo (2 pra R$ 12): pergunta de novo', () =>
    assert.ok(certa === true && !pago('Ana') && !pago('Bento (cvd Ana)')));
  const curta = await fala('5521900000011@c.us', 'Ana', 'do Bento');
  caso('"do Bento" marca o Bento', () => assert.ok(curta && pago('Bento (cvd Ana)') && !pago('Ana')));

  await admin('#pagapor riachuelo');
  caso('#pagapor lista quem paga por quem', () => assert.match(respostas.at(-1), /Ana → Bento[\s\S]*Ryan → Lucas[\s\S]*Thiago Rodrigues → Duda/));
  await admin('#naopagapor riachuelo thiago > duda');
  caso('#naopagapor esquece', () => assert.strictEqual(repo.dependentesDe(G, THIAGO).length, 0));

  // 20/10/2026: a figurinha falhou ("prepRawMedia") no meio e o comprovante
  // ficou marcado mas sem registro, sem aviso aos admins e sem a lista
  pelada.adicionarEntrada(lista.id, 'Zé', '5521900000009@c.us');
  enviados.length = 0;
  const semFigurinha = {
    ...porta('5521900000009@c.us', 'Zé'),
    enviarFigurinhaPara: async () => { throw new Error("Cannot read properties of undefined (reading 'prepRawMedia')"); },
  };
  await comprovantes.receber(semFigurinha, grupo, comLeitura(leitura({ id_transacao: 'E-ZE-1' })));
  caso('figurinha quebrada: o Zé fica marcado mesmo assim', () => assert.ok(pago('Zé')));
  caso('e o comprovante fica registrado como usado', () => assert.strictEqual(repo.jaUsado('id:E-ZE-1')?.status, 'marcado'));
  caso('e os admins recebem o 🤖✅, não o ⚠️', () => {
    assert.ok(enviados.some((m) => m.para === ADM && /🤖✅ \*Zé\*/.test(m.t)));
    assert.ok(!enviados.some((m) => /Não consegui conferir/.test(m.t)));
  });
  caso('e a lista atualizada sai no grupo', () => assert.ok(enviados.some((m) => m.para === G && /Zé ✅/.test(m.t))));

  // Sem PIX_RECEBEDOR o módulo fica desligado
  delete process.env.PIX_RECEBEDOR;
  enviados.length = 0;
  await comprovantes.receber(porta('5521900000005@c.us', 'Ryan'), grupo, comLeitura(leitura()));
  caso('sem PIX_RECEBEDOR, não faz nada', () => assert.strictEqual(enviados.length, 0));
}

fluxo()
  .catch((err) => {
    falhas++;
    console.log(`  FALHOU  ${err.stack}`);
  })
  .finally(() => {
    fecharBanco();
    fs.rmSync(pasta, { recursive: true, force: true });
    console.log(falhas ? `\n${falhas} falha(s)` : '\ntudo ok');
    process.exit(falhas ? 1 : 0);
  });
