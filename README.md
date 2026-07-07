# Bot de Lista de Vôlei

Bot de WhatsApp (via WPPConnect) que organiza lista de presença pro vôlei,
com lista principal de 18 vagas + 1 lista de espera de 4 pessoas,
com histórico persistente em SQLite.

## Comandos

| Comando | O que faz |
|---|---|
| `#listaDD/MM` | Abre a lista pro dia (ex: `#lista05/07`) |
| `#lista` | Entra na lista ativa (pega seu nome do WhatsApp automaticamente) |
| `#lista Nome` | Entra na lista com um nome específico, em vez do nome do WhatsApp |
| `#mostralista` | Mostra o estado atual da lista e das esperas |
| `#remover N` | Remove quem está na posição N (ex: `#remover 5`). Se for da principal, promove automaticamente o primeiro da espera |
| `#encerrarlista` | Fecha a lista, para de aceitar novos nomes |
| `#comandos` | Mostra a ajuda com todos os comandos |

## Modo de teste (feature flag)

Com só 2 pessoas testando, não dá pra validar o fluxo de lotação (18 +
espera de 4) organicamente. Ligando `TEST_MODE=true` no Railway (aba
Variables), dois comandos extras ficam disponíveis dentro do grupo:

| Comando | O que faz |
|---|---|
| `#testarencher N` | Adiciona N pessoas fake na lista ativa (ex: `#testarencher 15` pra ver o aviso de lista cheia, ou `#testarencher 22` pra lotar tudo incluindo a espera) |
| `#testarlimpar` | Apaga todo mundo da lista ativa, sem precisar recriar com `#listaDD/MM` de novo |

Os fakes entram com nomes `Teste 1`, `Teste 2`... e números únicos gerados
na hora, então não colidem com entradas reais nem com testes anteriores.

**Importante:** desliga `TEST_MODE` (ou apaga a variável) antes de liberar
o bot pra outros grupos de verdade — como é uma flag global do serviço,
ela valeria pra todos os grupos ativos ao mesmo tempo, não só o seu.

## Multi-grupo e ativação (admin)

O bot pode participar de vários grupos ao mesmo tempo — cada grupo tem sua
própria lista, isolada por `chat_id` (o JID do grupo no WhatsApp).

**Todo grupo novo começa desativado.** Assim que o bot recebe a primeira
mensagem num grupo, ele se auto-cadastra, mas não responde a nenhum comando
de lista até ser liberado manualmente.

Pra liberar, você manda um comando **no privado, direto pro número do bot**
(não precisa estar dentro do grupo alvo). Configura seu número em
`ADMIN_NUMBER` no `.env` (formato `5521999999999@c.us`) — só esse número
tem permissão de rodar comandos de admin.

Comandos de admin (só funcionam em DM com o bot):

| Comando | O que faz |
|---|---|
| `#listargrupos` | Lista todos os grupos cadastrados, com status e `chat_id` |
| `#ativargrupo <chat_id>` | Libera um grupo pra usar o bot |
| `#desativargrupo <chat_id>` | Bloqueia um grupo (ex: inadimplência) |
| `#admin` | Mostra a ajuda dos comandos de admin |

Fluxo típico pra um grupo novo:
1. Alguém no grupo manda qualquer mensagem com `#` (o bot avisa que não
   tá liberado)
2. Você manda `#listargrupos` no privado, copia o `chat_id` do grupo
3. Manda `#ativargrupo <chat_id>` — pronto, o grupo já pode usar

## Como funciona a fila

1. Alguém manda `#lista05/07` → cria a lista pro dia 05/07 (fica "aberta")
2. Cada `#lista` subsequente entra na fila, na ordem que a mensagem chegou
3. Ao bater 18 pessoas → bot avisa que a lista encheu e começa a lista de espera
4. Espera bate 4 → bot avisa que lotou tudo e para de aceitar
5. `#encerrarlista` a qualquer momento fecha pra novos nomes (útil se não lotar)
6. As listas antigas ficam salvas no banco (histórico), nada é resetado sozinho

## Instalação local

```bash
cd volei-bot
npm install
cp .env.example .env
# edite o .env com seu token do Telegram (opcional, mas recomendado)
npm start
```

Na primeira execução, acesse `http://localhost:3000` no navegador pra escanear
o QR code com o WhatsApp do chip.

## Hospedagem

**Importante:** Vercel, Netlify e Cloudflare Pages **não funcionam** aqui —
são serverless (a função morre depois de rodar) e o WPPConnect precisa manter
uma sessão de navegador (Puppeteer) viva o tempo todo. Você precisa de um
processo persistente.

### Recomendado: Railway

1. Suba o projeto num repositório Git (GitHub)
2. Crie um projeto no Railway e aponte pro repo — ele detecta o `Dockerfile`
   automaticamente (já incluído neste projeto, com Chromium instalado)
3. Configure as variáveis de ambiente (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`)
   na aba de Variables do Railway
4. Crie um **Volume** no Railway e monte em `/app/data` — é onde o SQLite
   salva o histórico (`DB_PATH=/app/data/volei.db`, já configurado no
   Dockerfile). Sem isso, o banco some a cada redeploy
5. Depois do deploy, acesse a URL pública gerada pelo Railway pra escanear
   o QR code

O free tier do Railway soma poucas horas de uso por mês — pra um bot que
roda o tempo todo, o plano pago (Hobby, ~$5/mês) é o que garante ele ficar
sempre ativo sem hibernar.

### Alternativa: DigitalOcean Droplet

Mais controle manual, mas exige você mesmo cuidar do PM2/Nginx/Chromium.
Só compensa se o Railway não atender.

## Alertas de falha (Telegram)

O bot tenta reconectar sozinho quando a sessão do WhatsApp cai (estados tipo
`CONFLICT`, `CLOSED`, `DISCONNECTED`, `UNPAIRED`), com um retry a cada 15s.
Se **2 tentativas seguidas falharem**, ele dispara um alerta no Telegram —
não fica tentando pra sempre em silêncio.

Pra configurar o alerta:

1. Fale com o [@BotFather](https://t.me/BotFather) no Telegram e crie um bot
   → ele te dá um `TELEGRAM_BOT_TOKEN`
2. Mande uma mensagem qualquer pro seu novo bot
3. Acesse `https://api.telegram.org/bot<SEU_TOKEN>/getUpdates` no navegador
   pra pegar o `chat.id` da conversa → esse é seu `TELEGRAM_CHAT_ID`
4. Coloque os dois no `.env`

Quando a sessão do WhatsApp cair ou der erro fatal, o bot manda uma mensagem
automática pro seu Telegram.

## Variáveis de ambiente (`.env`)

```
PORT=3000
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
NOME_GRUPO_ALVO=
```

`NOME_GRUPO_ALVO` é opcional — se quiser restringir o bot a só responder
dentro de um grupo específico (recomendado pra não pegar mensagem de DM),
edite `src/bot.js` e descomente a linha de filtro por nome do grupo.
