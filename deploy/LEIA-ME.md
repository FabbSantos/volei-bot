# Migração do Railway pra VPS

Roteiro do dia da mudança. A ordem existe por um motivo: o Railway só é
desligado no fim, quando o bot novo já estiver respondendo no grupo.

## Antes de começar

- VPS criada, Ubuntu 22.04 ou 24.04, acesso root por SSH
- Registro **A** do subdomínio (ex: `volei.seudominio.com.br`) apontando pro IP,
  já propagado — `nslookup volei.seudominio.com.br` tem que devolver o IP
- Backup do banco em mãos. Enquanto o Railway estiver de pé, pega o mais novo:
  `curl -o volei.db "https://volei-bot-production.up.railway.app/backup?token=SEU_TOKEN"`
- As variáveis atuais: `railway variables` (guarde o `PAINEL_TOKEN` — é o mesmo
  que abre o painel novo, então os links salvos continuam funcionando)

## 1. Preparar a máquina

```bash
ssh root@IP_DA_VPS
git clone https://github.com/FabbSantos/volei-bot.git /opt/volei-bot
cd /opt/volei-bot
bash deploy/setup-vps.sh volei.seudominio.com.br
```

Instala Docker, nginx, certbot e ufw; cria 2 GB de swap; emite o certificado
HTTPS; e agenda o backup diário às 4h.

## 2. Configurar

```bash
cd /opt/volei-bot
cp .env.exemplo .env
nano .env          # preencher ADMIN_NUMBER e PAINEL_TOKEN, no mínimo
```

## 3. Restaurar o banco

Da sua máquina:

```bash
scp volei.db root@IP_DA_VPS:/opt/volei-bot/dados/volei.db
```

Se a pasta não existir ainda: `mkdir -p /opt/volei-bot/dados` antes.

## 4. Subir

```bash
cd /opt/volei-bot
docker compose up -d --build
docker compose logs -f volei-bot
```

O primeiro build demora uns minutos (baixa o Chrome). Espere a linha
`Servidor rodando na porta 3000`.

## 5. Parear

Abre `https://volei.seudominio.com.br/qr` e lê o QR no celular.

**Isso desconecta o bot do Railway** — o WhatsApp só aceita uma sessão por
aparelho vinculado. É o ponto sem volta, então faça quando puder conferir na
hora se o novo respondeu.

Confirme:

```bash
curl https://volei.seudominio.com.br/status
```

Depois manda um `#listade riachuelo` no grupo de admins e vê se responde.

## 6. Deploy automático (opcional, mas vale)

No GitHub, em Settings → Secrets and variables → Actions, crie:

| segredo | valor |
|---|---|
| `VPS_HOST` | IP da VPS |
| `VPS_USER` | `root` |
| `VPS_SSH_KEY` | a chave **privada** que tem acesso à VPS |

A partir daí, push na `main` sobe o bot sozinho — igual era no Railway. O
workflow ainda confere se o bot voltou a conectar antes de dar o deploy como
bem-sucedido.

## 7. Só agora, desligar o Railway

Depois de ver o bot responder no grupo:

1. Baixe um último backup, se passou tempo entre o passo 3 e agora
2. Delete o serviço no Railway (**isso apaga o volume junto**)
3. Cancele a assinatura em Account Settings → Billing — apagar o serviço
   **não** cancela o plano de $5

## Manutenção

| pra quê | comando |
|---|---|
| ver o log | `docker compose logs -f volei-bot` |
| reiniciar | `docker compose restart volei-bot` |
| atualizar na mão | `git pull && docker compose up -d --build` |
| backup na hora | `volei-backup` |
| backups guardados | `ls -lh /var/backups/volei-bot` (14 dias, .gz) |
| uso de memória | `docker stats volei-bot` |

## Se o Chrome não abrir

Sintomas no log: `pthread_create: Resource temporarily unavailable`,
`Zygote could not fork` ou `spawn ... EAGAIN`. É teto de processos.

1. `docker compose restart volei-bot` resolve na maioria das vezes
2. Se voltar, sobe o `pids_limit` no `docker-compose.yml`
3. Perfil corrompido (`database is locked` no log) é o único caso de
   `RESET_SESSAO=1` no `.env` — reinicie, leia o QR de novo e **volte pra 0**
