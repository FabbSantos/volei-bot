# Migração do Railway pra VPS

## Já feito em 26/08/2026

A VPS está montada e esperando. Só não foi pareada — o bot do Railway
continua atendendo o grupo até a virada.

| | |
|---|---|
| máquina | Contabo Cloud VPS 4 (4 vCPU, 8 GB), `169.58.242.224` |
| acesso | chave SSH, senha desligada — atalho `ssh volei` |
| endereço | https://volei-bot.fabbahiense.dev (certificado até 24/11, renova sozinho) |
| base | Docker, nginx, 2 GB de swap, firewall |
| repositório | `/opt/volei-bot`, branch `migracao-vps` |
| `.env` | preenchido com os valores do Railway |
| imagem | construída — o Chrome já está baixado |
| backup | cron às 4h, quieto enquanto o container estiver parado |

O endereço responde **502** de propósito: o nginx está de pé, o bot não.

---

# O dia da virada

Melhor momento: sábado de manhã, com a lista de sexta já encerrada e ninguém
mexendo. A ordem existe por um motivo — o Railway só é desligado no fim,
depois do bot novo responder no grupo.

## 1. Copiar o banco, agora

Pegue uma cópia **fresca** na hora. Não reaproveite backup de dias atrás,
senão perde tudo que entrou no meio.

```bash
curl -o volei.db "https://volei-bot-production.up.railway.app/backup?token=SEU_TOKEN"
scp volei.db volei:/opt/volei-bot/dados/volei.db
```

## 2. Subir

```bash
ssh volei
cd /opt/volei-bot
docker compose up -d
docker compose logs -f volei-bot
```

Espere a linha `Servidor rodando na porta 3000`. Como a imagem já está pronta,
isso leva segundos, não minutos.

## 3. Parear

Abra https://volei-bot.fabbahiense.dev/qr e leia o QR no celular.

**Esse é o ponto sem volta do dia** — o WhatsApp derruba a sessão do Railway
quando a nova assume. Faça quando puder conferir na hora se o novo respondeu.

Confirme:

```bash
curl https://volei-bot.fabbahiense.dev/status
```

Depois manda um `#listade riachuelo` no grupo de admins e vê se responde.

Confira também se os dados vieram: abra o painel em
https://volei-bot.fabbahiense.dev/painel?token=SEU_TOKEN e veja se o elenco,
as notas e os gráficos estão lá.

## 4. Voltar pra main

A branch `migracao-vps` precisa virar `main` — é dela que o deploy automático
vai puxar:

```bash
git checkout main && git merge migracao-vps && git push
```

Faça isso **depois** de configurar os segredos do passo 5, senão o GitHub
Actions falha tentando SSH sem credencial.

## 5. Deploy automático

No GitHub, em Settings → Secrets and variables → Actions:

| segredo | valor |
|---|---|
| `VPS_HOST` | `169.58.242.224` |
| `VPS_USER` | `root` |
| `VPS_SSH_KEY` | conteúdo de `~/.ssh/id_ed25519` (a chave **privada**) |

A partir daí, push na `main` sobe o bot sozinho — igual era no Railway. O
workflow ainda confere se o bot voltou a conectar antes de dar o deploy como
bem-sucedido.

## 6. Só agora, desligar o Railway

Depois de alguns dias vendo o bot novo se comportar:

1. Delete o serviço no Railway — **isso apaga o volume junto**
2. Cancele a assinatura em Account Settings → Billing — apagar o serviço
   **não** cancela o plano de $5
3. Prazo: antes de **03/09**, quando começa o ciclo novo

Enquanto o Railway existir, ele é seu rollback: se algo der errado, leia o QR
de lá e o bot antigo assume no mesmo minuto.

## Manutenção

| pra quê | comando |
|---|---|
| entrar na máquina | `ssh volei` |
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

Com 8 GB e 4 vCPU essa máquina tem muito mais folga que o container do
Railway, então esse problema não deveria aparecer aqui.
