FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ─── Production image ────────────────────────────────────────────────────

FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

# Railway injects PORT automatically
ENV NODE_ENV=production
EXPOSE 3000

# Persistent data directory — mount a Railway volume here at /data
RUN mkdir -p /data
ENV DATA_DIR=/data

CMD ["node", "dist/index.js"]
