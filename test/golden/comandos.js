// Teste de comportamento dos comandos (grupo da pelada + admin) e da API do
// painel: roda um roteiro fixo e imprime tudo que o bot responderia, mais o
// conteúdo final do banco. A saída é comparada com comandos.esperado.txt —
// qualquer diferença é mudança de comportamento.
//
//   node test/golden/comandos.js            compara com o esperado
//   node test/golden/comandos.js --gravar   regrava o esperado
const ambiente = require('./ambiente');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const Database = require('better-sqlite3');
const app = require('./app');

const saida = [];
const log = (linha) => saida.push(ambiente.limparCaminho(linha));

// ---- quem é quem
const G1 = 'g1@g.us';
const G2 = 'g2@g.us';
const ADM = 'adm@g.us';
const ADMIN_DO_GRUPO = '5521900000001@c.us';
const pessoa = (n) => `55219000000${String(n).padStart(2, '0')}@c.us`;
const NOMES = { 1: 'Fabricio', 2: 'Marcel Garcia', 3: 'Diego', 4: 'Bianca', 5: 'Kamila', 6: 'Thiago Prata', 7: 'Vini', 8: 'Aces', 9: 'Ghemison', 10: 'Pedro' };

async function noGrupo(chatId, n, texto, { citado = null, nomeGrupo = null } = {}) {
  log(`\n>>> [${chatId}] ${NOMES[n] || n}: ${texto}`);
  await app.processarMensagem({
    body: texto,
    pushname: NOMES[n],
    chatId,
    numero: pessoa(n),
    nomeGrupo,
    reply: async (t) => log(`<<< ${t}`),
    enviarFigurinha: async (c) => log(`<<< [figurinha] ${c}`),
    ehAdmin: async () => pessoa(n) === ADMIN_DO_GRUPO,
    remetenteCitado: async () => citado,
  });
}

async function comoAdmin(texto, origem = 'grupoadmin') {
  log(`\n>>> [admin/${origem}] ${texto}`);
  await app.processarComandoAdmin({
    body: texto,
    origem,
    chatId: origem === 'privado' ? '5521999990000@c.us' : ADM,
    autor: 'Fabricio',
    reply: async (t) => log(`<<< ${t}`),
    enviarPara: async (chatId, t, opcoes) => log(`--> [${chatId}]${opcoes ? ` ${JSON.stringify(opcoes)}` : ''} ${t}`),
    enviarFigurinhaPara: async (chatId, c) => log(`--> [${chatId}] [figurinha] ${c}`),
    getAdminsDoGrupo: async () => [ADMIN_DO_GRUPO, pessoa(4)],
    getMembrosDoGrupo: async () => [pessoa(1), pessoa(2), pessoa(3)],
    saude: () => ({ status: 'inChat', tentativas: 0, esperandoQr: false, uptimeSegundos: 93784, memoriaMb: 512, maquina: 'maquina-de-teste' }),
  });
}

async function roteiro() {
  // ---- grupo novo nasce inativo
  await noGrupo(G1, 1, '#lista', { nomeGrupo: 'Vôlei Riachuelo' });
  await noGrupo(G1, 1, 'bora #quintou');
  await noGrupo(G2, 3, 'oi', { nomeGrupo: 'Quadra 7' });
  await noGrupo(ADM, 1, 'oi', { nomeGrupo: 'Admins do vôlei' });

  await comoAdmin('#listargrupos', 'privado');
  await comoAdmin(`#ativargrupo ${G1} 4 —2`, 'privado');
  await comoAdmin(`#ativargrupo ${G2}`, 'privado');
  await comoAdmin(`#grupoadmin ${ADM}`, 'grupoadmin');
  await comoAdmin(`#grupoadmin ${ADM}`, 'privado');
  await comoAdmin('#admin');
  await comoAdmin('#comandos');

  // ---- lista semanal no grupo
  await noGrupo(G1, 2, '#comandos');
  await noGrupo(G1, 1, '#comandos');
  await noGrupo(G1, 9, '#lista');
  await noGrupo(G1, 2, '#lista');
  await noGrupo(G1, 2, '#mostralista');
  await noGrupo(G1, 2, '#lista05/10');
  await noGrupo(G1, 1, '#lista05/10 20 Sexta');
  await noGrupo(G1, 1, '#lista 05/10');
  for (const n of [1, 2, 3, 4]) await noGrupo(G1, n, '#lista');
  await noGrupo(G1, 2, '#lista');
  await noGrupo(G1, 5, '#lista Joao Convidado');
  await noGrupo(G1, 6, '#lista');
  await noGrupo(G1, 7, '#lista');
  await noGrupo(G1, 2, '#pago 2');
  await noGrupo(G1, 1, '#pago 2');
  await noGrupo(G1, 1, '#pago', { citado: pessoa(3) });
  await noGrupo(G1, 1, '#pago');
  await noGrupo(G1, 1, '#pago', { citado: pessoa(10) });
  await noGrupo(G1, 1, '#naopago 2');
  await noGrupo(G1, 1, '#pago 99');
  await noGrupo(G1, 1, '#pago 1');
  await noGrupo(G1, 3, '#valor');
  await noGrupo(G1, 3, '#valor 25');
  await noGrupo(G1, 1, '#valor 25,50');
  await noGrupo(G1, 1, '#valorpadrão 30');
  await noGrupo(G1, 1, '#valorpadrao 0');
  await noGrupo(G1, 1, '#valor 0');
  await noGrupo(G1, 1, '#valor 20');
  await noGrupo(G1, 4, '#remover');
  await noGrupo(G1, 4, '#remover');
  await noGrupo(G1, 3, '#remover 1');
  await noGrupo(G1, 5, '#remover Joao Convidado');
  await noGrupo(G1, 3, '#remover Vini');
  await noGrupo(G1, 1, '#remover Ninguem');
  await noGrupo(G1, 1, '#remover 9');
  await noGrupo(G1, 1, '#editarlista 06/10 Pelada Boa');
  await noGrupo(G1, 3, '#editarlista 06/10');

  // ---- mensalistas
  await noGrupo(G1, 2, '#mensalista');
  await comoAdmin('#abrirmensalistasde riachuelo');
  await noGrupo(G1, 2, '#mensalista');
  await noGrupo(G1, 2, '#mensalista');
  await noGrupo(G1, 3, '#mensalista Diego B');
  await noGrupo(G1, 1, '#vagasmensalistas 2');
  await noGrupo(G1, 1, '#vagasmensalistas 0');
  await noGrupo(G1, 8, '#mensalista');
  await noGrupo(G1, 7, '#mensalista');
  await noGrupo(G1, 7, '#mensalistas');
  await noGrupo(G1, 2, '#pagomes 1');
  await noGrupo(G1, 1, '#pagomes 1');
  await noGrupo(G1, 1, '#valormes 53');
  await noGrupo(G1, 1, '#pagomes 2');
  await noGrupo(G1, 1, '#pagomes 3 40');
  await noGrupo(G1, 1, '#naopagomes 3');
  await noGrupo(G1, 1, '#pagomes 9');
  await noGrupo(G1, 1, '#fixo 1');
  await noGrupo(G1, 1, '#fixo 9');
  await noGrupo(G1, 1, '#removermensalista 2');
  await noGrupo(G1, 1, '#removermensalista 9');
  await noGrupo(G1, 1, '#valormes 0');
  await noGrupo(G1, 1, '#valormes 53');

  // ---- inadimplentes
  await noGrupo(G1, 1, '#inadimplente 3 17');
  await noGrupo(G1, 1, '#inadimplente 3');
  await noGrupo(G1, 1, '#inadimplente Fulano de Tal');
  await noGrupo(G1, 1, '#inadimplente 99');
  await noGrupo(G1, 2, '#inadimplente Fulano');
  await noGrupo(G1, 1, '#mostralista');
  await noGrupo(G1, 10, '#lista Fulano de Tal');
  await noGrupo(G1, 1, '#quitado fulano');
  await noGrupo(G1, 1, '#quitado 1');
  await noGrupo(G1, 1, '#quitado ninguem');

  // ---- modo de teste e sintaxe errada
  await noGrupo(G1, 2, '#testarencher 3');
  await noGrupo(G1, 1, '#testarencher 3');
  await noGrupo(G1, 1, '#testarlimpar');
  await noGrupo(G1, 1, '#pago 3 4');
  await noGrupo(G1, 1, '#valor25');
  await noGrupo(G1, 1, '#listaXX');

  await noGrupo(G1, 1, '#encerrarlista');
  await noGrupo(G1, 3, '#encerrarlista');
  await noGrupo(G1, 1, '#encerrarlista');
  await noGrupo(G1, 2, '#lista');
  await noGrupo(G1, 2, '#mostralista');
  await noGrupo(G1, 1, '#pago 1');
  await noGrupo(G1, 3, '#cancelarlista');
  await noGrupo(G1, 1, '#cancelarlista');
  await noGrupo(G1, 1, '#cancelarlista');
  await noGrupo(G1, 1, '#mostralista');

  // ---- remoto (grupo de admins)
  await comoAdmin('#abrirlistade riachuelo 12/10 17 Sexta 3h');
  await comoAdmin('#abrirlistade riachuelo 12/10');
  await comoAdmin('#abrirextrade riachuelo 13/10 15');
  await comoAdmin('#listade riachuelo');
  await comoAdmin('#adicionarde riachuelo Maria Convidada');
  await comoAdmin('#adicionarde riachuelo Maria Convidada');
  await comoAdmin('#adicionarde riachuelo Bianca quieto');
  await comoAdmin('#adicionarde riachuelo');
  await noGrupo(G1, 5, '#lista');
  await noGrupo(G1, 6, '#lista');
  await noGrupo(G1, 7, '#lista');
  await comoAdmin('#adicionarde riachuelo Mais Um');
  await comoAdmin('#renomearde riachuelo 3 Maria Certa');
  await comoAdmin('#renomearde riachuelo 30 Ninguem');
  await comoAdmin('#pagode riachuelo 1,3');
  await comoAdmin('#naopagode riachuelo 1');
  await comoAdmin('#pagode riachuelo 40');
  await comoAdmin('#pagosde riachuelo');
  await comoAdmin('#cobrarde riachuelo');
  await comoAdmin('#removerde riachuelo 2-3');
  await comoAdmin('#removerde riachuelo 40');
  await comoAdmin('#cobrarsubiude riachuelo');
  await comoAdmin('#editarlistade riachuelo 14/10 Sexta Nova');
  await comoAdmin('#encerrarlistade riachuelo quieto');
  await comoAdmin('#encerrarlistade riachuelo');
  await comoAdmin('#reabrirlistade riachuelo');
  await comoAdmin('#reabrirlistade riachuelo quieto');
  await comoAdmin('#abrirextrade riachuelo 15/10 15');
  await comoAdmin('#encerrarlistade riachuelo');
  await comoAdmin('#abrirextrade riachuelo 15/10 15');
  await comoAdmin('#abrirextrade riachuelo 15/10');
  await comoAdmin('#pagosde riachuelo');

  await comoAdmin('#mensalistasde riachuelo');
  await comoAdmin('#mensalistasde riachuelo enviar');
  await comoAdmin('#mensalistade riachuelo Pedro Remoto');
  await comoAdmin('#mensalistade riachuelo Pedro Remoto');
  await comoAdmin('#pagomesde riachuelo 1-2');
  await comoAdmin('#pagomesde riachuelo 3 60 quieto');
  await comoAdmin('#pagomesde riachuelo 1');
  await comoAdmin('#naopagomesde riachuelo 1,9');
  await comoAdmin('#pagomesde riachuelo 30');
  await comoAdmin('#fixode riachuelo 2');
  await comoAdmin('#fixode riachuelo 20');
  await comoAdmin('#removermensalistade riachuelo 1,9');
  await comoAdmin('#valormesde riachuelo 60');
  await comoAdmin('#vagasmensalistasde riachuelo 10');
  await comoAdmin('#vagasmensalistasde riachuelo 0');
  await comoAdmin('#valorde riachuelo 22');
  await comoAdmin('#valorde riachuelo 0');
  await comoAdmin('#valorlistade riachuelo 33');
  await comoAdmin('#valorlistade riachuelo 0');
  await comoAdmin('#valorlistade quadra 25');
  await comoAdmin('#valorde quadra 7');
  await comoAdmin('#pagomesde quadra 7');
  await comoAdmin('#fixode quadra 7');
  await comoAdmin('#adminsde riachuelo');
  await comoAdmin('#fecharmensalistasde riachuelo');
  await comoAdmin('#abrirmensalistasde riachuelo quieto');
  await comoAdmin('#reiniciarmensalistasde riachuelo');

  await comoAdmin('#importarelencode riachuelo');
  await comoAdmin('#importarelencode riachuelo');
  await comoAdmin('#timesde riachuelo 2');
  await comoAdmin('#timesde riachuelo 2 enviar');
  await comoAdmin('#timesde riachuelo 2 refazer');
  await comoAdmin('#timesde riachuelo 6');
  await comoAdmin('#timesde quadra 7');

  await comoAdmin('#anuncio Jogo confirmado!');
  await comoAdmin('#anunciarde riachuelo\n\n📢 Chuva forte,\njogo cancelado');
  await comoAdmin('#anunciode riachuelo');
  await comoAdmin('#anuncio   ');
  await comoAdmin('#listade');
  await comoAdmin('#listade inexistente');
  await comoAdmin('#listade a');
  await comoAdmin('#pago 3');
  await comoAdmin('#ativargrupo x 18 -6');
  await comoAdmin('#ativargrupo naoexiste@g.us');
  await comoAdmin('#ativargrupo x@g.us 0');
  await comoAdmin('#teste');

  // ---- #replay: anota o horário; o corte sai quando o vídeo subir
  await comoAdmin('#replays');
  await comoAdmin('#replay');
  await comoAdmin('#Replay2');
  await comoAdmin('#replay 9');
  await comoAdmin('#replay abc');
  await comoAdmin('#replays');
  await comoAdmin('#listargrupos');
  await comoAdmin(`#grupoadmin ${G1}`, 'privado');
  await comoAdmin('#cancelarlistade riachuelo');
  await comoAdmin('#cancelarlistade quadra');
  await comoAdmin(`#desativargrupo ${G2}`);
  await comoAdmin('#desativargrupo nada@g.us');
  await noGrupo(G2, 3, '#lista');
  await comoAdmin(`#grupoadmin ${ADM} off`, 'privado');
  await comoAdmin('#cobrarde riachuelo');
}

// ---- API do painel, com o mesmo banco que o roteiro deixou
async function painel() {
  const servidor = express();
  const enviados = [];
  app.registrarPainel(servidor, { enviarPara: async (chatId, t) => enviados.push(`[${chatId}] ${t}`) });
  const escuta = await new Promise((resolve) => {
    const s = servidor.listen(0, () => resolve(s));
  });
  const porta = escuta.address().port;

  const chamar = (metodo, caminho, corpo, { token = true } = {}) => new Promise((resolve, reject) => {
    const dados = corpo ? JSON.stringify(corpo) : null;
    const req = http.request({
      host: '127.0.0.1',
      port: porta,
      method: metodo,
      path: caminho,
      headers: {
        ...(token ? { 'x-painel-token': 'token-de-teste' } : {}),
        ...(dados ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(dados) } : {}),
      },
    }, (res) => {
      let texto = '';
      res.on('data', (c) => { texto += c; });
      res.on('end', () => resolve({ status: res.statusCode, texto }));
    });
    req.on('error', reject);
    if (dados) req.write(dados);
    req.end();
  });

  const passo = async (metodo, caminho, corpo, opcoes) => {
    const r = await chamar(metodo, caminho, corpo, opcoes);
    let corpoResposta = r.texto;
    try {
      corpoResposta = JSON.stringify(JSON.parse(r.texto), null, 1);
    } catch {
      corpoResposta = r.texto.length > 300 ? `${r.texto.slice(0, 300)}…` : r.texto;
    }
    log(`\n>>> ${metodo} ${caminho}${corpo ? ` ${JSON.stringify(corpo)}` : ''}\n<<< ${r.status} ${corpoResposta}`);
  };

  const g = encodeURIComponent(G1);
  await passo('GET', '/painel', null, { token: false });
  await passo('GET', '/api/grupos', null, { token: false });
  await passo('GET', '/api/grupos');
  await passo('GET', `/api/elenco?grupo=${g}`);
  await passo('POST', '/api/jogador', { grupo: G1, nome: 'Novato Painel', numero: pessoa(10) });
  await passo('POST', '/api/jogador', { grupo: G1 });
  await passo('POST', '/api/jogador/renomear', { jogador_id: 1, nome: 'Marcel G.' });
  await passo('POST', '/api/jogador/renomear', { jogador_id: 1, nome: 'Fabrício Bahiense' });
  await passo('POST', '/api/apelido', { jogador_id: 2, apelido: 'Fabricio' });
  await passo('DELETE', '/api/apelido?jogador_id=2&apelido=Fabricio');
  await passo('POST', '/api/altura', { jogador_id: 3, altura: 'alto' });
  await passo('POST', '/api/altura', { jogador_id: 4, altura: 'invalida' });
  await passo('POST', '/api/voto', { jogador_id: 3, votante: 'Fabrício', fundamento: 'ataque', nota: 5 });
  await passo('POST', '/api/voto', { jogador_id: 3, votante: 'Fabrício', fundamento: 'chute', nota: 5 });
  await passo('POST', '/api/prelista', { grupo: G1, aberta: true });
  await passo('POST', '/api/prelista', { grupo: 'nada@g.us', aberta: true });
  await passo('POST', '/api/lista/status', { grupo: G1, aberta: false });
  await passo('POST', '/api/lista/status', { grupo: G2, aberta: false });
  await passo('GET', `/api/listas?grupo=${g}`);
  await passo('POST', '/api/notadia', { jogador_id: 3, lista_id: 2, nota: 4.5, observacao: ' bom ' });
  await passo('POST', '/api/notadia', { jogador_id: 3, lista_id: 2, nota: 9 });
  await passo('GET', `/api/evolucao?grupo=${g}`);
  await passo('POST', '/api/times', { grupo: G1, quantidade: 2, nomes: ['Marcel Garcia', 'Diego', 'Aces', 'Vini', 'Kamila Vianna', 'Desconhecido'] });
  await passo('GET', `/api/times/salvos?grupo=${g}`);
  await passo('POST', '/api/times/salvar', { grupo: G1, times: [{ jogadores: [{ nome: 'Diego', nota: 4 }] }, { jogadores: [{ nome: 'Aces' }] }] });
  await passo('POST', '/api/times/anunciar', { grupo: G1, dataJogo: '14/10', times: [{ jogadores: ['Diego'] }, { jogadores: ['Aces'] }] });
  await passo('DELETE', `/api/times/salvos?grupo=${g}`);
  await passo('GET', `/api/elenco?grupo=${g}`);
  await passo('DELETE', '/api/jogador/5');
  log(`\n--- enviados pelo painel:\n${enviados.join('\n')}`);

  await new Promise((resolve) => escuta.close(resolve));
}

function despejarBanco() {
  const banco = new Database(process.env.DB_PATH, { readonly: true });
  const tabelas = banco.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  for (const { name } of tabelas) {
    const colunas = banco.pragma(`table_info(${name})`).map((c) => c.name).sort();
    log(`\n=== ${name} (${colunas.join(', ')})`);
    for (const linha of banco.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()) {
      log(JSON.stringify(Object.fromEntries(colunas.map((c) => [c, linha[c]]))));
    }
  }
  banco.close();
}

(async () => {
  try {
    await roteiro();
    await painel();
    despejarBanco();
  } finally {
    app.fecharBanco?.();
  }
  const texto = saida.join('\n')
    // o tamanho do arquivo do banco depende de quando o WAL faz checkpoint
    .replace(/respondendo · [\d.,]+ (KB|MB)/g, 'respondendo · <tamanho>');
  const esperado = path.join(__dirname, 'comandos.esperado.txt');

  if (process.argv.includes('--gravar')) {
    fs.writeFileSync(esperado, texto);
    console.log(`gravado: ${saida.length} linhas em ${esperado}`);
  } else {
    const anterior = fs.readFileSync(esperado, 'utf8');
    if (anterior === texto) {
      console.log(`ok: comportamento idêntico (${saida.length} linhas)`);
    } else {
      const obtido = path.join(ambiente.pasta, '..', 'comandos.obtido.txt');
      fs.writeFileSync(obtido, texto);
      const a = anterior.split('\n');
      const b = texto.split('\n');
      const i = a.findIndex((linha, k) => linha !== b[k]);
      console.error(`DIFERENTE a partir da linha ${i + 1}:\n  esperado: ${a[i]}\n  obtido:   ${b[i]}\nsaída completa em ${obtido}`);
      process.exitCode = 1;
    }
  }
  ambiente.limpar();
  process.exit(process.exitCode || 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
