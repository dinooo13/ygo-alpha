# syntax=docker/dockerfile:1

# ---- Base -------------------------------------------------------------
# node:22-bookworm-slim (glibc) is used for both build and runtime stages
# so the better-sqlite3 native addon (compiled during install) is ABI
# compatible in both. Alpine/musl would require a separate rebuild step.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# ---- Dependencies (with build tools for better-sqlite3) ----------------
FROM base AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile

# ---- Build --------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY . .
RUN pnpm build

# ---- Runtime ------------------------------------------------------------
FROM base AS runtime
# Links the image published to GHCR (.github/workflows/docker.yml) to this
# repository.
LABEL org.opencontainers.image.source="https://github.com/dinooo13/ygo-alpha" \
  org.opencontainers.image.description="A card collection, deck builder, format checker and tournament organizer for the Yu-Gi-Oh! trading card game"
ENV NODE_ENV=production
ENV NUXT_DB_FILE_PATH=/app/data/app.db
WORKDIR /app

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nuxt

# Runtime server output (includes its own bundled node_modules).
COPY --from=build /app/.output ./.output
# Drizzle migrations are read from the filesystem at startup
# (server/plugins/migrate.ts -> migrationsFolder: './server/db/migrations'),
# they are not bundled into .output, so ship them alongside it.
COPY --from=build /app/server/db/migrations ./server/db/migrations

RUN mkdir -p /app/data && chown -R nuxt:nodejs /app/data

USER nuxt

EXPOSE 3000

CMD ["node", ".output/server/index.mjs"]
