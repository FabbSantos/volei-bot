// Zoeiras do "mensalão": sorteia a piada, mas nunca a informação. Posição,
// total de vagas, prazo e o que confirma a vaga (o ✅) saem em todas as versões.

// Entrou no mensalão
const ENTROU_NO_MENSALAO = [
  (nome, pos, limite) =>
    `💸 *${nome} entrou no mensalão!* Vaga ${pos}/${limite}.\n\n` +
    `Agora acerta o pagamento com os admins — o ✅ é o que confirma. Sem ✅, sem vaga.`,
  (nome, pos, limite) =>
    `🧾 *${nome} assinou o contrato.* Vaga ${pos}/${limite} da Mensa-Lista.\n\n` +
    `Falta a parte chata: pagar com os admins. O ✅ é o carimbo.`,
  (nome, pos, limite) =>
    `🤝 *Propina aceita: ${nome} está dentro.* Vaga ${pos}/${limite}.\n\n` +
    `Brincadeira — aqui o pagamento é legal e vai pros admins. O ✅ confirma.`,
  (nome, pos, limite) =>
    `🏛 *${nome} tomou posse na vaga ${pos}/${limite}.*\n\n` +
    `Mandato de um mês, sem reeleição automática. Acerta com os admins que o ✅ sai.`,
  (nome, pos, limite) =>
    `💰 *${nome} entrou no esquema.* Vaga ${pos}/${limite}.\n\n` +
    `Agora é acertar com os admins. Enquanto não vier o ✅, você é só um candidato.`,
];

// Ficou na fila: mesma ideia, e sempre dizendo a posição e que pode subir
const ESPERA_MENSALISTA = [
  (nome, pos) =>
    `⏳ *Mensalão lotado.* ${nome} entrou na fila, posição ${pos}.\n\n` +
    `Se alguém não pagar até o 5º dia útil, a vaga é sua.`,
  (nome, pos) =>
    `📋 *${nome} está na lista de espera do mensalão* (posição ${pos}).\n\n` +
    `Fica de olho: quem não pagar no prazo devolve a vaga, e ela cai pra fila.`,
  (nome, pos) =>
    `🪑 *Acabaram as cadeiras.* ${nome}, você é o ${pos}º da fila.\n\n` +
    `Calouro sobe quando um titular não paga. Acontece todo mês.`,
];

// Abertura das inscrições: uma versão sorteada por mês. O miolo é sempre
// igual (vagas, #mensalista, prazo do 5º dia útil, ✅ confirma).
const ABERTURAS_MENSALISTAS = [
  (vagas) =>
    `💸 *ABRIU O MENSALÃO* 💸\n\n${vagas} vaga(s) + fila de espera.\n\n` +
    `Manda *#mensalista* pra entrar no esquema. Diferente do original, aqui tem ` +
    `que pagar de verdade: até o *5º dia útil* com os admins. O ✅ é o que confirma a vaga.`,
  (vagas) =>
    `🧠 *MENSA-LISTA ABERTA* 🏐\n\n${vagas} vaga(s) + fila de espera.\n\n` +
    `Não é concurso de inteligência, é de velocidade: manda *#mensalista* e garante a tua. ` +
    `Pagamento até o *5º dia útil* com os admins — o ✅ confirma.`,
  (vagas) =>
    `💰 *MENSALÃO DO VÔLEI, NOVA EDIÇÃO*\n\n${vagas} vaga(s) + fila de espera.\n\n` +
    `Manda *#mensalista* pra se candidatar. Pagamento até o *5º dia útil*, e aqui ` +
    `ninguém tem foro privilegiado. O ✅ é o que vale.`,
  (vagas) =>
    `🧾 *Mensa-Lista: caixa aberto*\n\n${vagas} vaga(s) + fila de espera.\n\n` +
    `*#mensalista* pra entrar. Quem não pagar até o *5º dia útil* devolve a vaga ` +
    `pro primeiro da fila — sem CPI, sem recurso. O ✅ é o comprovante.`,
];

const sortear = (opcoes) => opcoes[Math.floor(Math.random() * opcoes.length)];

function zoeiraEntrouNoMensalao(nome, posicao, limite) {
  return sortear(ENTROU_NO_MENSALAO)(nome, posicao, limite);
}

function zoeiraEsperaMensalista(nome, posicao) {
  return sortear(ESPERA_MENSALISTA)(nome, posicao);
}

function anuncioAberturaMensalistas(vagas) {
  return sortear(ABERTURAS_MENSALISTAS)(vagas);
}

module.exports = { zoeiraEntrouNoMensalao, zoeiraEsperaMensalista, anuncioAberturaMensalistas };
