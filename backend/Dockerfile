# Build context = workspace root (set via azure.yaml context: ../)
# ── Stage 0: build frontend ──────────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ── Stage 1: build backend ───────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY backend/package*.json ./
RUN npm ci

COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

# ── Stage 2: runtime ────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY backend/package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Compiled JS and DB schema
COPY --from=builder /app/dist ./dist
COPY db/schema.sql ./schema.sql

# React SPA (served as static files from /public)
COPY --from=frontend-builder /app/dist ./public

EXPOSE 3001

CMD ["node", "dist/index.js"]
