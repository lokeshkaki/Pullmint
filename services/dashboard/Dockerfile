# Stage 1: Build React app
FROM node:20-alpine AS builder
WORKDIR /app

# Copy root package files for workspace resolution
COPY package.json package-lock.json ./
COPY services/dashboard-ui/package.json services/dashboard-ui/

# Install dependencies
RUN npm ci --workspace=@pullmint/dashboard-ui

# Copy source
COPY services/dashboard-ui/ services/dashboard-ui/

# Build
RUN npm run build --workspace=@pullmint/dashboard-ui

# Stage 2: Nginx
FROM nginx:alpine

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Copy custom config
COPY services/dashboard/nginx.conf /etc/nginx/conf.d/default.conf

# Copy built React app
COPY --from=builder /app/services/dashboard-ui/dist /usr/share/nginx/html

EXPOSE 80
