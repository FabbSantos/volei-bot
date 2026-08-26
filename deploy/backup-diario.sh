#!/usr/bin/env bash
# Backup do banco. Instalado pelo setup-vps.sh em /usr/local/bin/volei-backup
# e chamado pelo cron às 4h. Guarda 14 dias.
#
# Usa VACUUM INTO por dentro do container: copiar o volei.db na mão perderia
# o que ainda está no WAL, e o VACUUM não trava quem estiver usando o bot.
set -euo pipefail

# Sem container de pé não há o que copiar — sai quieto em vez de encher o
# log de erro (vale pro período antes da migração e pra qualquer manutenção).
if ! docker ps --format '{{.Names}}' | grep -qx volei-bot; then
  echo "$(date '+%F %T') container parado, backup pulado"
  exit 0
fi

DESTINO=/var/backups/volei-bot
DIA=$(date +%F)
mkdir -p "$DESTINO"

docker exec volei-bot node -e "
  process.env.DB_PATH = '/app/data/volei.db';
  require('/app/src/db').snapshotBanco('/app/data/backup-tmp.db');
"
docker cp volei-bot:/app/data/backup-tmp.db "$DESTINO/volei-$DIA.db"
docker exec volei-bot rm -f /app/data/backup-tmp.db

gzip -f "$DESTINO/volei-$DIA.db"
find "$DESTINO" -name 'volei-*.db.gz' -mtime +14 -delete

echo "$(date '+%F %T') backup ok: $DESTINO/volei-$DIA.db.gz ($(du -h "$DESTINO/volei-$DIA.db.gz" | cut -f1))"
