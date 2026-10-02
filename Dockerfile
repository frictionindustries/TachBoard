##############################################
# Stage 1: Build API server
##############################################
FROM node:22-slim AS api-builder
WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json tsconfig.json ./
COPY lib/ lib/
COPY artifacts/api-server/ artifacts/api-server/

RUN pnpm install --frozen-lockfile
# Release version + repo slug stamped by the release workflow (empty in local
# builds → server falls back to APP_VERSION/APP_REPO env vars or "dev").
ARG APP_VERSION=""
ARG APP_REPO=""
ENV APP_VERSION=$APP_VERSION
ENV APP_REPO=$APP_REPO
RUN pnpm --filter @workspace/api-server run build

##############################################
# Stage 2: Build frontend
##############################################
FROM node:22-slim AS frontend-builder
WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json tsconfig.json ./
COPY lib/ lib/
COPY artifacts/homelab-dashboard/ artifacts/homelab-dashboard/

RUN pnpm install --frozen-lockfile

# BASE_PATH defaults to "/" (root); PORT is unused during build but must be valid
ENV BASE_PATH=/
ENV NODE_ENV=production

RUN pnpm --filter @workspace/homelab-dashboard run build

##############################################
# Stage 3: Production image
##############################################
FROM node:22-slim AS production
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10

# Copy package files for production deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json tsconfig.json ./
COPY lib/ lib/
COPY artifacts/api-server/package.json artifacts/api-server/

RUN pnpm install --filter @workspace/api-server --prod

# Copy built API server
COPY --from=api-builder /build/artifacts/api-server/dist ./artifacts/api-server/dist

# Copy built frontend to /frontend-dist (served by Express in production)
COPY --from=frontend-builder /build/artifacts/homelab-dashboard/dist/public ./frontend-dist

# Create data directory
RUN mkdir -p /data/uploads

# Environment defaults
ENV NODE_ENV=production
ENV PORT=20028
ENV DATA_DIR=/data
ENV JWT_SECRET=""
ENV FRONTEND_DIST=/app/frontend-dist

EXPOSE 20028

# Entrypoint: validate JWT_SECRET and start the server
CMD ["node", "--enable-source-maps", "./artifacts/api-server/dist/index.mjs"]
