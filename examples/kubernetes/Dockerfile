FROM oven/bun:1.3 AS base

RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY . .

# --- Orchestrator ---
FROM base AS orchestrator
ENV SMITHERS_ROLE=orchestrator
EXPOSE 3000 3001
CMD ["bun", "run", "smithers", "serve", "--gateway"]

# --- Worker ---
FROM base AS worker
ENV SMITHERS_ROLE=worker
EXPOSE 3002
CMD ["bun", "run", "smithers", "worker"]
