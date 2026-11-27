# syntax=docker/dockerfile:1
# keihi のコンテナイメージ（手順は DEPLOYMENT.md）。
# サーバーと worker は Node の型ストリップで .ts をそのまま実行するので、ビルドするのは PWA だけ。
ARG NODE_IMAGE=node:24.20.0-bookworm-slim

# --- PWA のビルド（dev 依存込み） ---
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY tools/dev ./tools/dev
# PWA は src/ の一部（税率の表など）を import する
COPY src ./src
COPY pwa ./pwa
RUN npm run build

# --- 実行時の依存だけ（sharp のネイティブバイナリを含む） ---
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# --- 実行イメージ ---
FROM ${NODE_IMAGE} AS runtime
# curl は Coolify の画面で設定するヘルスチェック用（コンテナの中で実行される）
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    APP_ENV=production \
    LOG_FORMAT=json \
    LOG_LEVEL=info \
    KEIHI_CONFIG_DIR=/config \
    KEIHI_DATA_DIR=/data \
    KEIHI_BIND_HOST=0.0.0.0 \
    KEIHI_WORKER_MODE=spawn \
    KEIHI_MIGRATE_ON_START=1
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY --from=build /app/pwa/dist ./pwa/dist
# /data が永続化の対象（SQLite・原本・OAuth のトークン）。名前付きボリュームは最初のマウントでこの所有者を引き継ぐ。
RUN mkdir -p /data /config && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8795
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${KEIHI_WEB_PORT:-8795}/health/ready" || exit 1
# シェルを挟まない（node が PID 1 で SIGTERM を受ける）
CMD ["node", "src/web/main.ts"]
