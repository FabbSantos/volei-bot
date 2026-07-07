FROM node:20-slim

# Bibliotecas que o Chrome for Testing (baixado pelo Puppeteer) precisa em runtime
RUN apt-get update && apt-get install -y \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    ca-certificates \
    wget \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# NÃO usamos o chromium do apt: a versão do Debian trixie/sid costuma bater
# com "Trace/breakpoint trap" no isolamento de syscalls do Railway (o filtro
# seccomp interno do Chromium falha mesmo com --no-sandbox). Deixamos o
# Puppeteer baixar o Chrome for Testing dele, que é validado contra a versão
# exata do puppeteer-core usada aqui e costuma ser mais estável nesses PaaS.

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Pasta onde o SQLite salva o histórico — monte um Volume do Railway aqui
# apontando pra /app/data pra não perder o banco em cada redeploy
ENV DB_PATH=/app/data/volei.db
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "src/bot.js"]
