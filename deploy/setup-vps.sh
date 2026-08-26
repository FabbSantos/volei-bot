#!/usr/bin/env bash
# Preparação da VPS zerada (Ubuntu 22.04/24.04). Roda UMA vez, como root:
#   bash deploy/setup-vps.sh volei.seudominio.com.br
# Depois disso o deploy é só `docker compose up -d` (ou o push no GitHub).
set -euo pipefail

DOMINIO="${1:-}"
APP_DIR=/opt/volei-bot

if [ -z "$DOMINIO" ]; then
  echo "uso: bash deploy/setup-vps.sh volei.seudominio.com.br" >&2
  exit 1
fi

echo "==> pacotes base"
apt-get update
apt-get install -y ca-certificates curl git ufw nginx certbot python3-certbot-nginx

echo "==> docker"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

# Swap salva a máquina de 2 GB quando o Chrome dá um pico durante a conversão
# de figurinha animada. Numa de 8 GB é só rede de segurança.
echo "==> swap"
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> firewall"
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo "==> pastas"
mkdir -p "$APP_DIR" /var/backups/volei-bot

echo "==> nginx"
sed "s/SEU.DOMINIO.COM.BR/$DOMINIO/" "$(dirname "$0")/nginx/volei-bot.conf" \
  > /etc/nginx/sites-available/volei-bot
ln -sf /etc/nginx/sites-available/volei-bot /etc/nginx/sites-enabled/volei-bot
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "==> certificado (precisa do DNS de $DOMINIO já apontando pra cá)"
certbot --nginx -d "$DOMINIO" --non-interactive --agree-tos --register-unsafely-without-email --redirect

echo "==> backup diário do banco às 4h"
install -m 0755 "$(dirname "$0")/backup-diario.sh" /usr/local/bin/volei-backup
cat > /etc/cron.d/volei-backup <<'CRON'
0 4 * * * root /usr/local/bin/volei-backup >> /var/log/volei-backup.log 2>&1
CRON

echo
echo "Pronto. Falta:"
echo "  1. clonar o repo em $APP_DIR"
echo "  2. criar o .env lá (use .env.exemplo como base)"
echo "  3. copiar o backup do banco pra $APP_DIR/dados/volei.db"
echo "  4. docker compose up -d --build"
echo "  5. abrir https://$DOMINIO/qr e ler o QR no celular"
