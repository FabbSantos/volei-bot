// Dado o que o Claude leu no comprovante e o estado da lista, decide:
//   { acao: 'ignorar' }                       não é comprovante (foto, meme...)
//   { acao: 'marcar', alvos: [entrada...] }   tudo bate, dá o ✅ sozinho
//   { acao: 'perguntar', motivo, candidatos, tipo }
//       tipo 'problema': Pix pra outro, repetido, data, valor — só os admins veem
//       tipo 'para_quem': o Pix é bom, só não dá pra saber de quem — o bot
//         pergunta no grupo pra quem enviou (pessoas, doRemetente vão junto)
//
// O que interessa é PRA QUEM é o pagamento, não quem pagou. As pistas, da
// mais forte pra mais fraca: a legenda ("eu e a Duda"), quem paga por quem
// (aprendido), o valor (R$ 24 = duas pessoas) e quem enviou. Sem nada de
// WhatsApp nem de API aqui dentro: dá pra testar caso a caso.
const { normalizarTexto } = require('../../nucleo/texto');
const { formatarReais } = require('../../nucleo/dinheiro');

const DIA_MS = 24 * 60 * 60 * 1000;

// "Paulo Ribeiro (cvd Marcel)" → ['paulo', 'ribeiro']: o que está entre
// parênteses é anotação da lista, não nome
const tokens = (nome) => normalizarTexto(String(nome || '').replace(/\([^)]*\)/g, ' '))
  .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);

const usuario = (numero) => String(numero || '').split('@')[0];

// "Diego" casa com o pagador "Diego Borges Silva"; "Kamila Vianna" não casa
// com "Fabricio Bahiense". Primeiro nome igual e o resto contido.
function nomeCasa(nomeDaLista, outroNome) {
  const a = tokens(nomeDaLista);
  const b = tokens(outroNome);
  return a.length > 0 && b.length > 0 && a[0] === b[0] && a.every((t) => b.includes(t));
}

// Banco escreve o nome de um jeito: "MARCEL GARCIA VON RONDON", "Marcel G V
// Rondon", "MARCEL G*** V** R*****". Exige o primeiro nome e pelo menos um
// sobrenome (ou a inicial dele) — só "Marcel" deixaria passar Pix pra
// qualquer outro Marcel.
function recebedorConfere(recebedorNome, esperado) {
  const lido = tokens(recebedorNome);
  const certo = tokens(esperado);
  if (!lido.length || !certo.length || lido[0] !== certo[0]) return false;
  const sobrenomes = certo.slice(1);
  return lido.slice(1).some((t) =>
    sobrenomes.includes(t) || (t.length === 1 && sobrenomes.some((s) => s[0] === t)));
}

// "Thiago Prata (cvd Vini)" é convidado do Vini? Todas as palavras depois
// do "cvd" têm que estar num nome só de quem enviou (WhatsApp, lista, elenco,
// apelido). Rígido de propósito: "cvd Marcel" NÃO é da Marcelle — foi esse o
// erro de 25/09/2026 nos times.
const PADRAO_CONVIDADO = /\(\s*(?:convidad[oa]|cvd|conv|c\/)\.?\s*(?:d[aoe]\s+)?([^)]+)\)/i;

function convidadoDe(nomeDaLista, nomesDoRemetente) {
  const m = String(nomeDaLista || '').match(PADRAO_CONVIDADO);
  if (!m) return false;
  const anfitriao = tokens(m[1]);
  if (!anfitriao.length) return false;
  return nomesDoRemetente.some((n) => {
    const t = tokens(n);
    return anfitriao.every((p) => t.includes(p));
  });
}

// "2026-10-09T20:31" no horário de Brasília → Date
function lerDataHora(texto) {
  const m = String(texto || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00-03:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const nomes = (entradas) => entradas.map((e) => e.nome).join(', ');
const unicos = (entradas) => [...new Map(entradas.map((e) => [e.id, e])).values()];

function decidir({
  leitura, lista, entradas, remetente, recebedorEsperado, usado, dependentes = [],
  ehDoRemetente = () => false, valorMes = 0, agora = new Date(), nomesDoRemetente = [],
}) {
  if (!leitura.eh_comprovante_pix) return { acao: 'ignorar' };
  const perguntar = (motivo, candidatos = []) => ({ acao: 'perguntar', tipo: 'problema', motivo, candidatos });

  // Só transferência que já saiu. Agendado não vale: o dinheiro pode nunca
  // sair. Duas travas: a classificação do Claude e, sem depender dele, a
  // palavra no título que ele copiou ("Pix agendado", "programado")
  const agendadoNoTitulo = /agend|program|recorr/i.test(leitura.titulo || '');
  if (leitura.situacao === 'agendado' || agendadoNoTitulo) return perguntar('é um Pix AGENDADO, não pago ainda');
  if (leitura.situacao !== 'concluido') return perguntar('não dá pra ver se o Pix foi concluído');
  if (!recebedorConfere(leitura.recebedor_nome, recebedorEsperado)) {
    return perguntar(leitura.recebedor_nome
      ? `o Pix foi pra "${leitura.recebedor_nome}", não pro ${recebedorEsperado}`
      : 'não deu pra ler pra quem foi o Pix');
  }
  if (usado) {
    const quando = new Date(usado.criado_em).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
    return perguntar(`esse comprovante já foi usado em ${quando}${usado.remetente_nome ? ` (enviado por ${usado.remetente_nome})` : ''}`);
  }

  const quando = lerDataHora(leitura.data_hora);
  if (!quando) return perguntar('não deu pra ler a data do Pix');
  const desde = new Date(new Date(lista.criada_em).getTime() - 2 * DIA_MS);
  if (quando < desde) return perguntar(`o Pix é de ${quando.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}, antes dessa lista abrir`);
  if (quando.getTime() > agora.getTime() + 15 * 60_000) return perguntar('a data do Pix está no futuro');

  const valor = lista.valor_centavos;
  if (!valor) return perguntar('a lista não tem valor definido');
  if (!leitura.valor_centavos || leitura.valor_centavos % valor !== 0) {
    const mensal = valorMes && leitura.valor_centavos === valorMes ? ' (parece a mensalidade — marca com #pagomesde)' : '';
    return perguntar(`${formatarReais(leitura.valor_centavos || 0)} não fecha com ${formatarReais(valor)} por pessoa${mensal}`);
  }
  const pessoas = leitura.valor_centavos / valor;
  // Dúvida só de PRA QUEM é: quem enviou sabe responder melhor que os admins
  const paraQuem = (motivo, candidatos = []) => ({
    acao: 'perguntar', tipo: 'para_quem', motivo, candidatos, pessoas, doRemetente: [],
  });

  // Quem ainda deve a LISTA. Mensalista paga pelo mês, não aqui — na extra,
  // os fixos já entram como avulsos e aparecem
  const pendentes = entradas.filter((e) => !e.pago && !e.mensalista);
  const doRemetente = pendentes.filter((e) =>
    (e.numero && usuario(e.numero) === usuario(remetente))
    || ehDoRemetente(e)
    || (leitura.pagador_nome && nomeCasa(e.nome, leitura.pagador_nome)));
  // Quem é o próprio remetente, pra entender "meu" na resposta dele
  const comRemetente = (d) => ({ ...d, doRemetente: doRemetente.map((e) => e.id) });
  // "Thiago Prata (cvd Vini)" é convidado de quem enviou, se o Vini é ele
  const convidados = pendentes.filter((e) => convidadoDe(e.nome, nomesDoRemetente));
  const dosDependentes = [...convidados, ...pendentes.filter((e) => dependentes.some((d) =>
    (d.dependente_numero && usuario(d.dependente_numero) === usuario(e.numero))
    || normalizarTexto(d.dependente_nome) === normalizarTexto(e.nome)
    // "Bento" ensinado com #pagapor casa com "Bento (cvd Ana)" da lista
    || nomeCasa(d.dependente_nome, e.nome)))];

  // 1) A legenda manda: "eu e a Duda", "da Kamila"
  if (leitura.legenda_para.length || leitura.legenda_inclui_remetente) {
    const citados = leitura.legenda_para
      .map((n) => entradas.find((e) => normalizarTexto(e.nome) === normalizarTexto(n)))
      .filter(Boolean);
    const jaPagos = citados.filter((e) => e.pago);
    if (jaPagos.length) return perguntar(`a legenda cita ${nomes(jaPagos)}, que já está pago`);
    const alvos = unicos([...(leitura.legenda_inclui_remetente ? doRemetente : []), ...citados]);
    if (alvos.length === pessoas) return { acao: 'marcar', alvos };
    return comRemetente(paraQuem(
      `${formatarReais(leitura.valor_centavos)} é pra ${pessoas} pessoa(s), mas pela legenda achei ${alvos.length ? nomes(alvos) : 'ninguém devendo'}`,
      alvos,
    ));
  }

  // 2) Sem legenda: quem enviou + quem ele costuma pagar. A lista PRINCIPAL
  // primeiro: quem está na espera não deve nada até subir (pelada de 16/10:
  // o Thiago pagou o dele com a Duda na espera — era dele, óbvio). A espera
  // só entra se o valor cobrir mais gente do que tem na principal (R$ 24 do
  // Thiago com a Duda ainda esperando = os dois)
  const todos = unicos([...doRemetente, ...dosDependentes]);
  const naPrincipal = todos.filter((e) => e.tipo === 'principal');
  const candidatos = naPrincipal.length >= pessoas ? naPrincipal : todos;
  if (candidatos.length === pessoas) return { acao: 'marcar', alvos: candidatos };
  if (candidatos.length === 0) {
    return comRemetente(paraQuem('quem enviou não está devendo na lista e não tem ninguém ligado a ele — é pra quem?'));
  }
  if (candidatos.length > pessoas) {
    return comRemetente(paraQuem(`${formatarReais(leitura.valor_centavos)} cobre ${pessoas}, mas pode ser de ${nomes(candidatos)}`, candidatos));
  }
  return comRemetente(paraQuem(
    `${formatarReais(leitura.valor_centavos)} é pra ${pessoas} pessoas, mas só achei ${nomes(candidatos)} — quem são os outros?`,
    candidatos,
  ));
}

// O texto diz "é de quem enviou"? "meu" e "pra mim" sempre; "eu"
// só sem nome junto ("eu paguei pra Duda" é da Duda) — ou em "eu e a Duda".
// Vale pra legenda e pra resposta à pergunta do bot. Regra fixa, de
// propósito: em 20/10/2026 o Claude leu a mesma legenda "é meu" certo numa
// rodada e errado na seguinte.
const PALAVRAS_PROPRIO = ['meu', 'mim', 'proprio', 'propria'];
// ("minha" ficou de fora: "minha filha" é da filha, não de quem enviou)
const PALAVRAS_PROPRIO_FRACAS = ['eu'];

function falaDoRemetente(texto, temNome) {
  const palavras = tokens(texto);
  const euEOutro = palavras.some((p, i) => p === 'eu' && (palavras[i + 1] === 'e' || palavras[i - 1] === 'e'));
  return palavras.some((p) => PALAVRAS_PROPRIO.includes(p)) || euEOutro
    || (!temNome && palavras.some((p) => PALAVRAS_PROPRIO_FRACAS.includes(p)));
}

module.exports = { decidir, recebedorConfere, nomeCasa, lerDataHora, tokens, falaDoRemetente, convidadoDe };
