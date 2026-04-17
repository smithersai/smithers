FROM oven/bun:1.3 AS base

RUN sed -i \
    -e 's|URIs: http://deb.debian.org/debian$|URIs: http://snapshot.debian.org/archive/debian/20260406T000000Z|' \
    -e 's|URIs: http://deb.debian.org/debian-security$|URIs: http://snapshot.debian.org/archive/debian-security/20260406T000000Z|' \
    /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y git curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock ./
COPY apps ./apps
COPY packages ./packages
COPY .smithers ./.smithers
COPY examples/kubernetes ./examples/kubernetes
RUN bun install --frozen-lockfile

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
