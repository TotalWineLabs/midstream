# syntax=docker/dockerfile:1
# The console: a Node backend-for-frontend and a React client in one process (docs/13 §13.1).
# The first stage builds the client with every dependency; the image keeps only what the server
# needs at run time and runs as the unprivileged node user. server/ and shared/ ship as TypeScript:
# Node 24 strips the types itself, so there is no server build step.
#
# Debian, not Alpine: DuckDB's glibc build allocates through jemalloc, which hands memory back once a
# statement's sandbox closes. On musl, every statement left what it had used with the process, and
# the console's memory climbed with each one.
FROM node:24.22.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24.22.1-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    CONSOLE_DATA_DIR=/var/lib/midstream-console
WORKDIR /app
RUN mkdir -p /var/lib/midstream-console && chown node:node /var/lib/midstream-console
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/package.json ./package.json
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server/main.ts"]
