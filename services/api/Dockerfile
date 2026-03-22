FROM node:20-alpine AS builder

WORKDIR /app

# Copy root package files for workspace resolution
COPY package.json package-lock.json ./
COPY services/shared/package.json services/shared/
COPY services/api/package.json services/api/

# Install all dependencies
RUN npm ci --workspace=@pullmint/shared --workspace=@pullmint/api

# Copy source
COPY tsconfig.json ./
COPY services/shared/ services/shared/
COPY services/api/ services/api/

# Build
RUN npm run build --workspace=@pullmint/shared --workspace=@pullmint/api

FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY services/shared/package.json services/shared/
COPY services/api/package.json services/api/

RUN npm ci --workspace=@pullmint/shared --workspace=@pullmint/api --omit=dev

COPY --from=builder /app/services/shared/dist services/shared/dist
COPY --from=builder /app/services/api/dist services/api/dist
COPY --from=builder /app/services/shared/drizzle services/shared/drizzle

EXPOSE 3000

CMD ["node", "services/api/dist/server.js"]
