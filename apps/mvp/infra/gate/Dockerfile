# The gate machine's image (decision 0128): the branch sandbox's image (infra/sandbox/Dockerfile, passed as
# SANDBOX_IMAGE) plus what apps/mvp's suite needs in one box with no Docker: Postgres 17 and PgBouncer from trixie,
# Electric 1.8.1 copied from its image, Playwright's Chromium and WebKit, and /workspace holding a shallow checkout of
# COMMIT with `node_modules` installed from its lockfile. A job's checkout fetches only what its own commit adds to
# that one (worker/branch/Checkout.ts), and installs nothing when the lockfile is the image's
# (/etc/smithers-gate/lockfile.sha256); otherwise from the registries. The pnpm store is deleted: Cloudflare refuses an
# image whose layer holds more than 100,000 hard links ("image layer contains more than 100000 hard links", 2026-10-30),
# and the store hard-links every file of node_modules. Build it with infra/gate/build.sh on a linux/amd64 host; its tag is the lockfile's digest.
ARG SANDBOX_IMAGE
FROM docker.io/electricsql/electric:1.8.1 AS electric
FROM ${SANDBOX_IMAGE}
ARG REPOSITORY=https://github.com/smithersai/smithers
ARG COMMIT
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-17 pgbouncer libncurses6 libssl3t64 locales procps util-linux \
  && rm -rf /var/lib/apt/lists/*
COPY --from=electric /app /opt/electric
COPY entry.sh /usr/local/bin/smithers-gate-entry
USER smithers
ENV CI=1 PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN test -n "$COMMIT" \
  && umask 002 \
  && git -C /workspace init --quiet \
  && git -C /workspace remote add origin "$REPOSITORY" \
  && git -C /workspace fetch --quiet --depth 1 origin "$COMMIT" \
  && git -C /workspace -c advice.detachedHead=false checkout --quiet --detach FETCH_HEAD \
  && cd /workspace && pnpm install --frozen-lockfile \
  && sha256sum pnpm-lock.yaml | cut -d' ' -f1 >/tmp/lockfile.sha256 \
  && rm -rf "$(pnpm store path)" /home/smithers/.cache /home/smithers/.local/share/pnpm
USER root
RUN install -d -m 755 /etc/smithers-gate /opt/playwright \
  && mv /tmp/lockfile.sha256 /etc/smithers-gate/lockfile.sha256 \
  && cd /workspace/apps/mvp && pnpm exec playwright install --with-deps chromium webkit \
  && chmod -R a+rX /opt/playwright && rm -rf /var/lib/apt/lists/*
# PID 1 is tini; the entry, as root, mounts the tmpfs and drops to `smithers` to idle (infra/sandbox/Dockerfile).
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/smithers-gate-entry"]
