FROM node:20-alpine AS builder

WORKDIR /app

# Copy root package files for workspace resolution
COPY package.json package-lock.json ./
COPY services/shared/package.json services/shared/
COPY services/repo-indexer/package.json services/repo-indexer/
COPY services/llm-agents/architecture-agent/package.json services/llm-agents/architecture-agent/
COPY services/workers/package.json services/workers/

# Install all dependencies
RUN npm ci \
  --workspace=@pullmint/shared \
  --workspace=@pullmint/repo-indexer \
  --workspace=@pullmint/architecture-agent \
  --workspace=@pullmint/workers

# Copy source files
COPY tsconfig.json ./
COPY services/shared/ services/shared/
COPY services/repo-indexer/ services/repo-indexer/
COPY services/llm-agents/architecture-agent/ services/llm-agents/architecture-agent/
COPY services/workers/ services/workers/

# Build
RUN npm run build --workspace=@pullmint/shared
RUN npm run build --workspace=@pullmint/workers

# --- Production image ---
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY services/shared/package.json services/shared/
COPY services/repo-indexer/package.json services/repo-indexer/
COPY services/llm-agents/architecture-agent/package.json services/llm-agents/architecture-agent/
COPY services/workers/package.json services/workers/

RUN npm ci \
  --workspace=@pullmint/shared \
  --workspace=@pullmint/repo-indexer \
  --workspace=@pullmint/architecture-agent \
  --workspace=@pullmint/workers \
  --omit=dev

COPY --from=builder /app/services/shared services/shared
COPY --from=builder /app/services/workers/dist services/workers/dist

CMD ["node", "services/workers/dist/services/workers/src/main.js"]
