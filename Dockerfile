# Build stage: the server (tsc) and the web app (Vite)
FROM node:26-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.server.json vite.config.mts ./
COPY shared/ ./shared/
COPY server/ ./server/
COPY web/ ./web/
RUN npm run build

# Production stage: one Node process serves the API, the event streams and the built web app
FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
USER node
# No EXPOSE and no published ports: cloudflared reaches the service over the
# compose network, and nothing on the host listens for it.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "dist/server/server/index.js"]
