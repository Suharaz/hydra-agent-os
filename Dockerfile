# HYDRA - Two-speed autonomous trading system (Binance Agent OS)
# Suitable for local execution or Cloudflare Containers (Public Beta)

FROM oven/bun:1-slim AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source code and config
COPY config ./config
COPY fixtures ./fixtures
COPY src ./src
COPY hydra-demo.html hydra-overview.html ./

# Set environment defaults
ENV HYDRA_MODE=demo \
    DASHBOARD_PORT=8787 \
    X402_PORT=8788

EXPOSE 8787 8788

# Launch HYDRA autonomous engine
CMD ["bun", "run", "src/main.ts"]
