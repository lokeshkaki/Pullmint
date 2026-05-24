# Raspberry Pi Deployment Guide

Pullmint can run on a Raspberry Pi 4 or 5 with 4 GB RAM minimum (8 GB recommended for comfortable headroom).

## Hardware Requirements

| Component | Minimum | Recommended |
|---|---|---|
| Model | Raspberry Pi 4 | Raspberry Pi 5 |
| RAM | 4 GB | 8 GB |
| Storage | 32 GB microSD or USB SSD | 64 GB+ USB SSD |
| OS | 64-bit Raspberry Pi OS Lite | 64-bit Raspberry Pi OS Lite |

Use a USB SSD rather than microSD for the data volumes - microSD cards degrade quickly under PostgreSQL write load.

## OS Setup

1. Flash 64-bit Raspberry Pi OS Lite (bookworm) using Raspberry Pi Imager.
2. Enable SSH and set hostname/credentials in Imager's advanced options.
3. Boot and SSH in.
4. Update packages:
   ```bash
   sudo apt update && sudo apt upgrade -y
   ```

## Docker Installation

Install Docker via the official convenience script (installs the correct ARM64 packages):

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker
```

Verify:
```bash
docker run --rm --platform linux/arm64 hello-world
```

## Clone and Configure

```bash
git clone https://github.com/YOUR_ORG/pullmint.git
cd pullmint
cp .env.example .env
nano .env
```

Minimum required `.env` values:

```
GITHUB_APP_ID=...
GITHUB_APP_PRIVATE_KEY_PATH=/run/secrets/github_private_key
GITHUB_WEBHOOK_SECRET=...
ANTHROPIC_API_KEY=...
DASHBOARD_AUTH_TOKEN=...
POSTGRES_PASSWORD=changeme
REDIS_PASSWORD=changeme
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=changeme
```

## Start Services

```bash
docker compose -f docker-compose.prod.yml up -d
```

Check status:
```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f api
```

The resource limits defined in `docker-compose.prod.yml` keep total memory usage within ~2.1 GB, leaving headroom for the OS on a 4 GB Pi 4.

## Expose the Webhook

GitHub requires a public HTTPS endpoint to deliver webhooks. Two zero-config options:

### Cloudflare Tunnel (recommended - free, persistent URL)

```bash
# Install cloudflared
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg > /dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared bookworm main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install cloudflared

# Authenticate (opens browser on another machine)
cloudflared tunnel login

# Create and route tunnel
cloudflared tunnel create pullmint
cloudflared tunnel route dns pullmint webhooks.yourdomain.com
cloudflared tunnel run --url http://localhost:3000 pullmint
```

Add to your GitHub App's webhook URL: `https://webhooks.yourdomain.com/webhook`

### ngrok (quick testing)

```bash
# Download ARM64 ngrok from https://ngrok.com/download
ngrok http 3000
```

Use the printed HTTPS URL as your webhook endpoint. Note: free ngrok URLs change on restart.

## Performance Expectations

On a Raspberry Pi 4 (4 GB), expect:

- **PR analysis latency:** 45-90 seconds (vs ~15-30s on x86 cloud) - dominated by LLM API round-trips, not local compute
- **PostgreSQL queries:** <50ms for typical dashboard queries
- **Memory at idle:** ~1.2 GB total across all containers
- **Memory under active analysis:** ~1.8-2.1 GB (within limits)

## Monitoring

```bash
# Live resource usage
docker stats

# Check container health
docker compose -f docker-compose.prod.yml ps

# Tail all logs
docker compose -f docker-compose.prod.yml logs -f

# Postgres disk usage
docker exec pullmint-postgres-1 psql -U pullmint -c "\l+"
```

If a container is OOM-killed (`docker inspect <container> | grep OOMKilled`), increase its memory limit in `docker-compose.prod.yml` and restart.
