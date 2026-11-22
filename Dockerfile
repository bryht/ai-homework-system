# syntax=docker/dockerfile:1
# AI Homework System: one image that serves the web app and the API.

# ---- 1. Frontend (chat-demo + homework pages) ----
FROM node:22-slim AS web
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter "@hw/web..."
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @hw/web build

# ---- 2. Rust server ----
FROM rust:1.97-slim AS server
WORKDIR /src
# Build dependencies first so code changes do not re-download and re-compile every crate.
COPY apps/server/Cargo.toml apps/server/Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && touch src/lib.rs \
    && cargo build --release && rm -rf src
COPY apps/server/ ./
RUN touch src/main.rs src/lib.rs && cargo build --release

# ---- 3. Runtime ----
FROM debian:trixie-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=server /src/target/release/ai-homework /usr/local/bin/ai-homework
COPY --from=web /src/apps/web/dist /app/web
ENV WEB_DIST=/app/web \
    DATA_DIR=/data \
    APP_ENV=production \
    PORT=8787
VOLUME /data
EXPOSE 8787
CMD ["ai-homework", "serve"]
