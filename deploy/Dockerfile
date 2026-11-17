# Evora, self-hosted: the collaboration server serving the built app, in one container.
#
# Build from the repository's root (the build context is the whole project):
#
#   docker build -f deploy/Dockerfile -t evora .
#   docker run -d --name evora -p 8787:8787 -v evora-data:/data evora
#
# then open http://localhost:8787. deploy/docker-compose.yml does the same with
# a named volume, and optionally Caddy in front for HTTPS. Every setting is an
# environment variable (docs/self-hosting.md has the table).
#
# deploy/Dockerfile.dockerignore keeps node_modules, builds, data and the
# portable toolchain out of the context (BuildKit, the default builder since
# Docker 23, reads it because it sits next to this file).

# ---------------------------------------------------------------- build stage
# The app is built with Vite; the server needs no build (Node 24 strips the types).
FROM node:24-slim AS build
WORKDIR /src

# The desktop app's Electron binary and Playwright's browsers are not needed to build the web app.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# The production build of the app into dist/ (the type-check runs in CI, not here).
RUN npx vite build

# ---------------------------------------------------------------- final stage
# Only Node, the server's sources, the two shared files it imports from src/, and the built app.
# No node_modules: the server uses only Node's built-ins (node:http, node:sqlite, node:crypto).
FROM node:24-slim
WORKDIR /app

ENV NODE_ENV=production \
    EVORA_HOST=0.0.0.0 \
    EVORA_PORT=8787 \
    EVORA_DATA=/data \
    EVORA_SERVE=/app/dist

# package.json gives the version that /api/health and /api/version report.
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/server ./server
# The files of src/ that the server imports (server/deploy.test.ts checks this list against its imports).
COPY --from=build /src/src/collab/protocol.ts ./src/collab/protocol.ts
COPY --from=build /src/src/plugins/manifest.ts ./src/plugins/manifest.ts
COPY --from=build /src/dist ./dist

# The data (database and uploaded images) lives in a volume, owned by the unprivileged "node" user of the image;
# /backups is a place for `node server/backup.ts --data /data --out /backups/<name>` (a second volume in docker-compose.yml).
RUN rm -f server/*.test.ts server/testing.ts \
 && mkdir -p /data /backups \
 && chown node:node /data /backups
VOLUME ["/data"]
USER node

EXPOSE 8787

# Healthy when the server answers and can read its database (no curl in the slim image: Node's own fetch).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.EVORA_PORT || 8787) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# SIGTERM (docker stop) stops gracefully: live connections are told the server
# is restarting and reconnect, the database is checkpointed and closed.
# Give it longer than EVORA_SHUTDOWN_SECONDS (10 s): docker stop -t 20.
STOPSIGNAL SIGTERM
CMD ["node", "server/main.ts"]
