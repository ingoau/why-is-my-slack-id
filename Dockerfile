FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Bolt 5 Socket Mode heartbeats call undici.ping(). Bun's builtin undici
# shim does not export that, so the connection dies on the first ping.
# Runtime matches local `node index.ts`.
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .

USER node
CMD ["node", "index.ts"]
