# Bot de Lista de Vôlei

Bot de WhatsApp (via WPPConnect) que organiza lista de presença pro vôlei,
com lista principal de 18 vagas + 1 lista de espera de 4 pessoas,
com histórico persistente em SQLite.

## Comandos

| Comando | O que faz |
|---|---|
| `#listaDD/MM` | Abre a lista pro dia (ex: `#lista05/07`) |
| `#lista` | Entra na lista ativa (pega seu nome do WhatsApp automaticamente) |
| `#mostralista` | Mostra o estado atual da lista e das esperas |
| `#remover N` | Remove quem está na posição N (ex: `#remover 5`). Se for da principal, promove automaticamente o primeiro da espera |
| `#encerrarlista` | Fecha a lista, para de aceitar novos nomes |
| `#comandos` | Mostra a ajuda com todos os comandos |

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

Pra saber se o bot cair (sessão desconectada, erro fatal etc.):

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
