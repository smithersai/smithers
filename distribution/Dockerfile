# syntax=docker/dockerfile:1.8
# The committed WebAssembly artifact is reproducible only on this host triple.
FROM --platform=linux/amd64 rust:1.89.0-bookworm AS flows-jj
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates crates
COPY packages/smithers/flows/jj/wasm/flows_jj.wasm packages/smithers/flows/jj/wasm/flows_jj.wasm
RUN rustup target add wasm32-wasip1 \
  && CARGO_BUILD_JOBS=2 node crates/flows-jj/build-wasm.mjs --verify

FROM rust:1.98.0-bookworm AS smithers-ffi
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
RUN CARGO_BUILD_JOBS=2 cargo build --locked --release --package smithers-ffi

FROM oven/bun:1.4.0-debian AS bun-buildchain

FROM node:22.22.0-bookworm AS web
COPY --from=bun-buildchain /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .pnpmfile.mjs tsconfig.json tsconfig.base.json ./
COPY patches patches
COPY packages packages
COPY flows flows
COPY apps apps
COPY scripts scripts
COPY distribution/flow-host-manifest.mjs distribution/flow-host-manifest.mjs
COPY --from=flows-jj /src/packages/smithers/flows/jj/wasm/flows_jj.wasm packages/smithers/flows/jj/wasm/flows_jj.wasm
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate \
  && node --version && pnpm --version && bun --version \
  && pnpm install --frozen-lockfile
RUN pnpm --dir apps/app run build:web
RUN node flows/coding/build.mjs /out/flow-hosts/smithers-coding-host \
  && node flows/librarian/build.mjs /out/flow-hosts/smithers-librarian-host \
  && node distribution/flow-host-manifest.mjs \
    /out/flow-hosts/flow-hosts.json \
    /out/flow-hosts/smithers-coding-host \
    /out/flow-hosts/smithers-librarian-host

FROM golang:1.26.8-bookworm AS backend
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY apps/backend apps/backend
COPY apps/smithers apps/smithers
COPY packages/backend packages/backend
RUN GOMAXPROCS=2 CGO_ENABLED=1 go build -trimpath -ldflags='-s -w' -o /out/smithers-backend ./apps/backend
RUN GOMAXPROCS=2 CGO_ENABLED=1 go build -trimpath -ldflags='-s -w' -o /out/smithers ./apps/smithers

# Debian/glibc is required by libsmithers_ffi; Alpine/musl is ABI-incompatible.
# This base supplies PostgreSQL 18 pg_dump/pg_restore/psql for maintenance.
FROM postgres:18.6-bookworm
ARG SMITHERS_DISTRIBUTION_VERSION=0.1.0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tini util-linux && rm -rf /var/lib/apt/lists/* \
  && groupadd --system smithers && useradd --system --gid smithers --home-dir /var/lib/smithers --shell /usr/sbin/nologin smithers \
  && install -d -o smithers -g smithers -m 0700 /var/lib/smithers \
  && install -d -o root -g root -m 0755 /opt/smithers /opt/smithers/bin /opt/smithers/lib /opt/smithers/web /opt/smithers/migrations /opt/smithers/licenses
COPY --from=backend /out/smithers-backend /opt/smithers/bin/smithers-backend
COPY --from=backend /out/smithers /opt/smithers/bin/smithers
COPY --from=web /usr/local/bin/node /opt/smithers/bin/node
COPY --from=web /out/flow-hosts/ /opt/smithers/bin/
COPY --from=web /usr/local/LICENSE /opt/smithers/licenses/node-LICENSE
COPY --from=smithers-ffi /src/target/release/smithers-jj-export /opt/smithers/bin/smithers-jj-export
COPY --from=web /src/apps/app/dist /opt/smithers/web
COPY --from=smithers-ffi /src/target/release/libsmithers_ffi.so /opt/smithers/lib/libsmithers_ffi.so
COPY packages/backend/db/product/migrations /opt/smithers/migrations
COPY distribution/lib.sh distribution/entrypoint.sh distribution/backup.sh distribution/restore.sh distribution/upgrade.sh distribution/version.env /opt/smithers/
COPY LICENSE THIRD_PARTY_NOTICES.md /opt/smithers/licenses/
RUN schema_version="$(find /opt/smithers/migrations -maxdepth 1 -type f -name '[0-9][0-9][0-9][0-9]_*.sql' -printf '%f\n' | sort | tail -n 1 | cut -c 1-4 | sed 's/^0*//')" \
  && test -n "$schema_version" \
  && sed -i "s/^SMITHERS_DISTRIBUTION_VERSION=.*/SMITHERS_DISTRIBUTION_VERSION=${SMITHERS_DISTRIBUTION_VERSION}/; s/^SMITHERS_SCHEMA_VERSION=.*/SMITHERS_SCHEMA_VERSION=${schema_version}/" /opt/smithers/version.env \
  && chmod 0555 /opt/smithers/*.sh /opt/smithers/bin/node /opt/smithers/bin/smithers /opt/smithers/bin/smithers-backend /opt/smithers/bin/smithers-coding-host /opt/smithers/bin/smithers-librarian-host /opt/smithers/bin/smithers-jj-export \
  && chmod 0444 /opt/smithers/bin/flow-hosts.json /opt/smithers/bin/*.sha256 \
  && cd /opt/smithers/bin \
  && sha256sum -c smithers-coding-host.sha256 smithers-librarian-host.sha256 \
  && ./node --version | grep -Eq '^v22\.' \
  && PATH=/opt/smithers/bin:$PATH ./smithers-coding-host --help >/dev/null \
  && PATH=/opt/smithers/bin:$PATH ./smithers-librarian-host --help >/dev/null \
  && chown -R root:root /opt/smithers && chown smithers:smithers /var/lib/smithers
ENV SMITHERS_DATA_ROOT=/var/lib/smithers \
    SMITHERS_AUTH_MODE=selfhost \
    SMITHERS_FLOW_HOST_MANIFEST=/opt/smithers/bin/flow-hosts.json \
    SMITHERS_WORKSPACE_CODING_HOST_BINARY=/opt/smithers/bin/smithers-coding-host \
    SMITHERS_WORKSPACE_LIBRARIAN_HOST_BINARY=/opt/smithers/bin/smithers-librarian-host \
    SMITHERS_WORKSPACE_JJ_EXPORT_BINARY=/opt/smithers/bin/smithers-jj-export \
    SMITHERS_FFI_LIBRARY_PATH=/opt/smithers/lib/libsmithers_ffi.so \
    PATH=/opt/smithers/bin:/usr/lib/postgresql/18/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER smithers
EXPOSE 4000
VOLUME ["/var/lib/smithers"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=6 CMD curl --fail --silent "http://127.0.0.1:$${PORT:-4000}/readyz" >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/smithers/entrypoint.sh"]
CMD []
