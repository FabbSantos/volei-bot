// Teste de comportamento da camada do WhatsApp: sobe o bot INTEIRO com um
// wppconnect de mentira (sem Chrome, sem sessão real), entrega mensagens como
// o WhatsApp entregaria e registra tudo que o bot manda de volta — permissões,
// @lid, grupo de admins, lembrete diário, teste de vida e as rotas HTTP.
//
//   node test/golden/whatsapp.js            compara com whatsapp.esperado.txt
//   node test/golden/whatsapp.js --gravar   regrava o esperado
const ambiente = require('./ambiente');
const fs = require('fs');
const path = require('path');
const http = require('http');

process.env.PORT = '0';
process.env.ADMIN_NUMBER = '5521999999999@c.us';

const saida = [];
const log = (linha) => saida.push(ambiente.limparCaminho(linha));

// ---- relógios: os setInterval do bot ficam guardados pra disparar na mão
const intervalos = [];
global.setInterval = (fn, ms) => {
  intervalos.push({ fn, ms });
  return { unref() {}, ref() {} };
};

// ---- o WhatsApp de mentira
const LID = {
  '111@lid': '5521999999999@c.us', // dono do bot
  '222@lid': '5521900000001@c.us', // admin do grupo da pelada
  '333@lid': '5521900000002@c.us', // gente comum
  '444@lid': '5521900000003@c.us', // membro do grupo de admins
};
const mensagensGuardadas = new Map();
let aoReceber = null;
let falharEnvio = null;

const pagina = {
  evaluate: async (_fn, jid) => (LID[jid] ? { phoneNumber: { _serialized: LID[jid] } } : null),
  browser: () => ({ pages: async () => [pagina] }),
  target: () => 'alvo-principal',
};

const cliente = {
  page: pagina,
  onMessage: (fn) => { aoReceber = fn; },
  onStateChange: () => {},
  getConnectionState: async () => 'CONNECTED',
  close: async () => {},
  sendText: async (para, texto, opcoes) => {
    if (falharEnvio) throw new Error(falharEnvio);
    log(`--> [${para}]${opcoes ? ` ${JSON.stringify(opcoes)}` : ''} ${texto}`);
  },
  sendImageAsSticker: async (para, caminho) => log(`--> [${para}] [figurinha] ${caminho}`),
  sendImageAsStickerGif: async (para, caminho) => log(`--> [${para}] [figurinha animada] ${caminho}`),
  getGroupAdmins: async (chatId) => (chatId === 'g1@g.us' ? [{ _serialized: '222@lid' }] : []),
  getGroupMembers: async (chatId) => (chatId === 'adm@g.us'
    ? [{ id: { _serialized: '444@lid' } }, { id: { user: '5521900000009', server: 'c.us' } }]
    : [{ id: '222@lid' }, { id: '333@lid' }]),
  getChatById: async (chatId) => ({ name: { 'g1@g.us': 'Vôlei Riachuelo', 'adm@g.us': 'Admins' }[chatId] || null }),
  getMessageById: async (id) => mensagensGuardadas.get(id) || null,
};

const caminhoWpp = require.resolve('@wppconnect-team/wppconnect');
require.cache[caminhoWpp] = {
  id: caminhoWpp,
  filename: caminhoWpp,
  loaded: true,
  exports: {
    create: async (opcoes) => {
      opcoes.catchQR('data:image/png;base64,QR', 'qr', 1);
      opcoes.statusFind('isLogged');
      opcoes.statusFind('inChat');
      return cliente;
    },
  },
};

let contador = 0;
async function chega({ de, autor = null, corpo, nomeChat, citando = null, t = undefined }) {
  const id = `msg-${++contador}`;
  const mensagem = {
    id,
    body: corpo,
    from: de,
    author: autor,
    isGroupMsg: de.endsWith('@g.us'),
    notifyName: { '222@lid': 'Fabricio', '333@lid': 'Marcel', '444@lid': 'Diego' }[autor] || 'Alguém',
    chat: nomeChat ? { name: nomeChat } : undefined,
    t: t ?? Math.floor(Date.now() / 1000),
    quotedMsgId: citando,
  };
  mensagensGuardadas.set(id, mensagem);
  log(`\n>>> [${de}${autor ? ` / ${autor}` : ''}] ${JSON.stringify(corpo)}`);
  await aoReceber(mensagem);
  return id;
}

function pedir(porta, caminho) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: porta, path: caminho }, (res) => {
      let texto = '';
      res.on('data', (c) => { texto += c; });
      res.on('end', () => resolve(`${res.statusCode} ${res.headers.location || ''}${texto.slice(0, 200)}`));
    }).on('error', reject);
  });
}

async function esperar(condicao) {
  for (let i = 0; i < 200; i++) {
    if (condicao()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('o bot não chegou no estado esperado');
}

(async () => {
  const servidores = [];
  const listenOriginal = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    servidores.push(this);
    return listenOriginal.apply(this, args);
  };

  require(require('./app').entrada);
  await esperar(() => aoReceber && servidores[0]?.address());
  const porta = servidores[0].address().port;

  log(`GET /status → ${await pedir(porta, '/status')}`);
  log(`GET /qr → ${await pedir(porta, '/qr')}`);
  log(`GET /painel.html → ${await pedir(porta, '/painel.html')}`);

  // privado: só o dono do bot manda (e o @lid dele precisa ser resolvido)
  await chega({ de: '111@lid', corpo: '#listargrupos' });
  await chega({ de: '333@lid', corpo: '#listargrupos' });
  await chega({ de: '111@lid', corpo: '' });

  // grupo novo nasce inativo; o nome vem do getChatById
  await chega({ de: 'g1@g.us', autor: '222@lid', corpo: '#lista' });
  await chega({ de: 'adm@g.us', autor: '444@lid', corpo: 'oi' });
  await chega({ de: '111@lid', corpo: '#ativargrupo g1@g.us 3 --1' });
  await chega({ de: '111@lid', corpo: '#grupoadmin adm@g.us' });

  // permissões no grupo da pelada: admin do WhatsApp, membro do grupo de
  // admins e gente comum
  await chega({ de: 'g1@g.us', autor: '333@lid', corpo: '#lista10/10 20' });
  await chega({ de: 'g1@g.us', autor: '222@lid', corpo: '#lista10/10 20 Sexta' });
  await chega({ de: 'g1@g.us', autor: '222@lid', corpo: '#lista' });
  const comprovante = await chega({ de: 'g1@g.us', autor: '333@lid', corpo: '#lista' });
  await chega({ de: 'g1@g.us', autor: '444@lid', corpo: '#lista' });
  await chega({ de: 'g1@g.us', autor: '333@lid', corpo: '#pago', citando: comprovante });
  await chega({ de: 'g1@g.us', autor: '444@lid', corpo: '#pago', citando: comprovante });
  await chega({ de: 'g1@g.us', autor: '222@lid', corpo: '#pago 3' });
  await chega({ de: 'g1@g.us', autor: '222@lid', corpo: '#mostralista', t: 1000 }); // histórico da reconexão

  // grupo de admins: comandos remotos + #anuncio marcando todo mundo
  await chega({ de: 'adm@g.us', autor: '444@lid', corpo: '#pagosde riachuelo' });
  await chega({ de: 'adm@g.us', autor: '444@lid', corpo: '#adminsde riachuelo' });
  await chega({ de: 'adm@g.us', autor: '444@lid', corpo: '#anuncio Bora!' });
  await chega({ de: 'adm@g.us', autor: '444@lid', corpo: '#cobrarde riachuelo' });
  await chega({ de: 'adm@g.us', autor: '444@lid', corpo: '#teste' });

  // relógios: teste de vida e lembrete diário (sexta, 12h — já passou das 10h)
  log(`\n--- intervalos registrados: ${intervalos.map((i) => i.ms).join(', ')}`);
  for (const { fn } of intervalos) await fn();
  await new Promise((r) => setTimeout(r, 20));
  log('--- de novo (o lembrete é um por dia)');
  for (const { fn } of intervalos) await fn();
  await new Promise((r) => setTimeout(r, 20));

  // página travada no meio de um comando: vira reconexão, não erro de comando
  falharEnvio = 'Protocol error: Target closed';
  await chega({ de: 'g1@g.us', autor: '222@lid', corpo: '#mostralista' });
  falharEnvio = null;
  log(`GET /status → ${await pedir(porta, '/status')}`);

  const texto = saida.join('\n')
    .replace(/respondendo · [\d.,]+ (KB|MB)/g, 'respondendo · <tamanho>')
    .replace(/No ar há:\* [^\n]*/g, 'No ar há:* <tempo>');
  const esperado = path.join(__dirname, 'whatsapp.esperado.txt');
  if (process.argv.includes('--gravar')) {
    fs.writeFileSync(esperado, texto);
    console.log(`gravado: ${saida.length} linhas em ${esperado}`);
  } else {
    const anterior = fs.readFileSync(esperado, 'utf8');
    if (anterior === texto) {
      console.log(`ok: comportamento idêntico (${saida.length} linhas)`);
    } else {
      const obtido = path.join(ambiente.pasta, '..', 'whatsapp.obtido.txt');
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
