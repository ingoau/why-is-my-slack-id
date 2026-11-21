FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Bolt 5 Socket Mode heartbeats call undici.ping(). Bun's builtin undici
# shim does not export that, so the connection dies on the first ping.
# Runtime matches local `node index.ts`.
# Pinned to >= 24.22.1 for CVE-2026-111497 (Node2Shell, Brotli decoder RCE).
FROM node:24.22.3-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .

USER node
CMD ["node", "index.ts"]
