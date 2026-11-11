# The machine behind every sandbox instance type.
#
# The base is the Cloudflare Sandbox SDK's image, whose entrypoint is the
# control server the SDK talks to; its tag must equal the `@cloudflare/sandbox`
# version in ../package.json, and the entrypoint must not be overridden.
# On top of it go the tools VibeLang's post-merge checks run: Node 26,
# pnpm, Bun, Go, git, jj, tar and base64. Every download is pinned by version
# and SHA-256, and the last step fails the build if any tool answers with
# another version.
FROM docker.io/cloudflare/sandbox:0.12.14

ARG NODE_VERSION=26.10.0
ARG NODE_SHA256=ca70e9e349de048b9522abb3adc05b3bd6f43c5ffd3ec57916c7da292f59f022
ARG PNPM_VERSION=11.25.0
ARG BUN_VERSION=1.4.4
ARG BUN_SHA256=bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c
ARG GO_VERSION=1.26.8
ARG GO_SHA256=d0f743b33e8d8945e6b1f432edd15785c70507121d6e2a723b21285eddf8b57b
ARG JJ_VERSION=0.45.1
ARG JJ_SHA256=f35438350b5d61963aac5dd74ede510b31d6b9690769d1a6268cf058cc825f72

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates coreutils curl git libatomic1 tar unzip xz-utils \
  && rm -rf /var/lib/apt/lists/*

# The base image's Node 22 lives in /usr/local too. Its npm and corepack are
# removed first: extracted over them, the leftover files break npm.
RUN curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
  && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/include/node \
  && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
  && rm /tmp/node.tar.xz \
  && npm install -g "pnpm@${PNPM_VERSION}"

RUN curl -fsSLo /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
  && echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c - \
  && unzip -q /tmp/bun.zip -d /tmp/bun \
  && install -m 0755 /tmp/bun/bun-linux-x64/bun /usr/local/bin/bun \
  && rm -rf /tmp/bun /tmp/bun.zip

RUN curl -fsSLo /tmp/go.tar.gz "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" \
  && echo "${GO_SHA256}  /tmp/go.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/go.tar.gz -C /usr/local \
  && rm /tmp/go.tar.gz

RUN curl -fsSLo /tmp/jj.tar.gz \
    "https://github.com/jj-vcs/jj/releases/download/v${JJ_VERSION}/jj-v${JJ_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
  && echo "${JJ_SHA256}  /tmp/jj.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/jj.tar.gz -C /usr/local/bin ./jj \
  && rm /tmp/jj.tar.gz

ENV PATH=/usr/local/go/bin:/usr/local/bin:${PATH}

RUN test "$(node --version)" = "v${NODE_VERSION}" \
  && test "$(pnpm --version)" = "${PNPM_VERSION}" \
  && test "$(bun --version)" = "${BUN_VERSION}" \
  && go version | grep -q " go${GO_VERSION} " \
  && jj --version | grep -q "^jj ${JJ_VERSION}" \
  && git --version && tar --version && base64 --version
