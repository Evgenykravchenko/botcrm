# syntax=docker/dockerfile:1.7
FROM node:22.20.0-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY services/api/package.json services/api/package.json
COPY services/worker/package.json services/worker/package.json
COPY packages/sdk-ts/package.json packages/sdk-ts/package.json
RUN npm ci

COPY . .
RUN npm run build \
 && npm run api:build \
 && npm run worker:build \
 && npm run build --workspace @botcrm/sdk

FROM node:22.20.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
USER node

FROM runtime AS web
ENV PORT=3000
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public ./public
EXPOSE 3000
CMD ["node", "node_modules/vinext/dist/cli.js", "start", "--port", "3000", "--hostname", "0.0.0.0"]

FROM runtime AS api
ENV PORT=4100
COPY --from=build --chown=node:node /app/services/api/dist ./services/api/dist
COPY --from=build --chown=node:node /app/services/api/package.json ./services/api/package.json
EXPOSE 4100
CMD ["node", "services/api/dist/main.js"]

FROM runtime AS worker
COPY --from=build --chown=node:node /app/services/worker/dist ./services/worker/dist
COPY --from=build --chown=node:node /app/services/worker/package.json ./services/worker/package.json
CMD ["node", "services/worker/dist/main.js"]

FROM runtime AS migrate
COPY --from=build --chown=node:node /app/infra ./infra
CMD ["node", "infra/scripts/migrate.mjs"]