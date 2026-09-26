// O vídeo do jogo chega pelo Google Drive: quem filmou sobe numa pasta pelo
// app do Drive no celular, e o bot vigia essa pasta.
//
// Por que não direto pro painel: a VPS fica na França, e a rota do provedor
// de casa até lá não passou de ~5 Mbps (26/09/2026 — 2h30 pra 5,4 GB, com a
// página aberta o tempo todo). Pro Drive o celular sobe na velocidade cheia,
// em segundo plano, e o Drive → França é rota de datacenter.
//
// Acesso por conta de serviço do Google Cloud, só leitura, e ela só enxerga
// a pasta que foi compartilhada com ela. A chave (JSON) mora no volume de
// dados da VPS, nunca no git. Sem biblioteca do Google: o token sai de um JWT
// assinado aqui mesmo com o crypto do Node.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const ESCOPO = 'https://www.googleapis.com/auth/drive.readonly';
const API_PADRAO = 'https://www.googleapis.com';

const base64url = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function criarDrive({ credenciais, api = API_PADRAO, fetch = globalThis.fetch }) {
  let token = null; // { valor, expira }

  async function pegarToken() {
    if (token && token.expira > Date.now() + 60_000) return token.valor;
    const agora = Math.floor(Date.now() / 1000);
    const cabecalho = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const corpo = base64url(JSON.stringify({
      iss: credenciais.client_email, scope: ESCOPO, aud: credenciais.token_uri, iat: agora, exp: agora + 3600,
    }));
    const assinatura = base64url(crypto.sign('RSA-SHA256', Buffer.from(`${cabecalho}.${corpo}`), credenciais.private_key));
    const r = await fetch(credenciais.token_uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${cabecalho}.${corpo}.${assinatura}`,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`Google recusou a chave: ${j.error_description || j.error || r.status}`);
    token = { valor: j.access_token, expira: Date.now() + (j.expires_in || 3600) * 1000 };
    return token.valor;
  }

  async function chamar(caminho, opcoes = {}) {
    const r = await fetch(`${api}${caminho}`, {
      ...opcoes,
      headers: { ...(opcoes.headers || {}), authorization: `Bearer ${await pegarToken()}` },
    });
    if (!r.ok && r.status !== 206) {
      const j = await r.json().catch(() => ({}));
      throw new Error(`Drive respondeu ${r.status}: ${j.error?.message || r.statusText}`);
    }
    return r;
  }

  // Vídeos da pasta. O Drive só lista o arquivo depois que ele terminou de
  // subir, então o que aparece aqui já está inteiro.
  async function listarVideos(pastaId) {
    const q = `'${pastaId.replace(/'/g, "\\'")}' in parents and trashed = false and mimeType contains 'video/'`;
    const params = new URLSearchParams({
      q, pageSize: '100', orderBy: 'createdTime',
      fields: 'files(id,name,size,mimeType,createdTime)',
      supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
    });
    const j = await (await chamar(`/drive/v3/files?${params}`)).json();
    return (j.files || []).map((f) => ({ ...f, size: Number(f.size) || 0 }));
  }

  // Baixa pra `destino`. Se a conexão cair no meio, a próxima chamada
  // continua de onde parou (cabeçalho Range) em vez de baixar 5 GB de novo.
  async function baixar(arquivo, destino) {
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    const parcial = `${destino}.parcial`;
    let jaTem = 0;
    try { jaTem = fs.statSync(parcial).size; } catch {}
    if (jaTem < arquivo.size) {
      const r = await chamar(`/drive/v3/files/${encodeURIComponent(arquivo.id)}?alt=media&supportsAllDrives=true`, {
        headers: jaTem ? { range: `bytes=${jaTem}-` } : {},
      });
      // Servidor que ignora o Range devolve o arquivo inteiro: começa do zero
      const continuando = jaTem > 0 && r.status === 206;
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(parcial, { flags: continuando ? 'a' : 'w' }));
    }
    const baixado = fs.statSync(parcial).size;
    if (baixado !== arquivo.size) throw new Error(`baixou ${baixado} de ${arquivo.size} bytes`);
    fs.renameSync(parcial, destino);
    return destino;
  }

  return { listarVideos, baixar, pegarToken };
}

// "https://drive.google.com/drive/folders/1AbC...?usp=sharing" ou só o id
function idDaPasta(texto) {
  const s = String(texto || '').trim();
  const m = s.match(/folders\/([A-Za-z0-9_-]+)/) || s.match(/[?&]id=([A-Za-z0-9_-]+)/);
  return m ? m[1] : (/^[A-Za-z0-9_-]{10,}$/.test(s) ? s : null);
}

function lerCredenciais(caminho) {
  const j = JSON.parse(fs.readFileSync(caminho, 'utf8'));
  if (!j.client_email || !j.private_key) throw new Error(`${caminho} não parece a chave JSON de uma conta de serviço`);
  return { ...j, token_uri: j.token_uri || 'https://oauth2.googleapis.com/token' };
}

module.exports = { criarDrive, idDaPasta, lerCredenciais };
