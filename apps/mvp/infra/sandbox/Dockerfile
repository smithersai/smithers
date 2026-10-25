# The branch sandbox's image (decision 0013 §9): Debian trixie with git, tmux, bash and CA certificates, the Node and
# pnpm the repository pins (.node-version, package.json's packageManager), Go, Python with pip and venv, and a C and C++
# toolchain for native packages, so most repositories install and build in a branch's, a TODO's or a check job's box
# (ruling ARCH-15). It holds no credentials: the forge proxy (worker/BranchSandboxes.ts) adds the read token outside the
# box, and the box reaches only the package registries, through its egress (worker/branch/RegistryEgress.ts), whose
# HTTPS is signed by the container's CA the wake trusts (worker/secrets/SandboxEgress.ts `TRUST`). No Rust: rustup's
# host isn't among the registries.
#
# Users: `smithers` checks the branch out; each person's shell runs as their own user, made on first use in the
# `workspace` group (worker/branch/Users.ts), so one person's tmux server is closed to another's shell. The checkout is
# shared through the group: /workspace is group-owned and setgid, every shell's umask is 002, and git trusts the
# checkout whoever owns it. The ids are fixed (`smithers` 1000, `workspace` 2000; worker/branch/Users.ts): a deployed
# container runs a command as a numeric uid:gid, never a name.
#
# Pins: the base by digest; Node from nodejs.org's release tarball for the build's architecture, checked against the
# release's SHASUMS256.txt; Go from go.dev's release tarball, checked against the sha256 go.dev publishes for it; pnpm by
# exact version from npm, whose registry checks its integrity; Python, pip and the C toolchain are trixie's. Node 26
# ships without corepack, and a container's exec passes only PATH, so a corepack cache keyed by each user's HOME would
# download pnpm on first use: pnpm is installed globally instead. For the same reason `go` and `gofmt` are linked into
# /usr/local/bin, on the default PATH. Alchemy pins the built image by its own digest.
FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f
ARG TARGETARCH
ARG NODE_VERSION=26.5.0
ARG NODE_SHA256_AMD64=22b5f47ad6ae78837e4c2b846019965ce1a06ba143de176102294a1bf44fc677
ARG NODE_SHA256_ARM64=308e5fe89a82461ba5a6cf15ff5221b2cdbd7ae87600aa72bb3c3fbdc66412d1
ARG PNPM_VERSION=11.25.0
ARG GO_VERSION=1.27.3
ARG GO_SHA256_AMD64=65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40
ARG GO_SHA256_ARM64=a06e99309dbcbdca1a8ccd2282c3ee146e55930886e26b4f1193269587165f49
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash build-essential ca-certificates curl git less libatomic1 \
       python3 python3-pip python3-venv tini tmux \
  && rm -rf /var/lib/apt/lists/* \
  && case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
       amd64) arch=x64; sum=$NODE_SHA256_AMD64; goarch=amd64; gosum=$GO_SHA256_AMD64 ;; \
       arm64) arch=arm64; sum=$NODE_SHA256_ARM64; goarch=arm64; gosum=$GO_SHA256_ARM64 ;; \
       *) echo "no Node or Go build for this architecture" >&2; exit 1 ;; \
     esac \
  && curl -fsSLo /tmp/node.tar.gz "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$arch.tar.gz" \
  && echo "$sum  /tmp/node.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1 --no-same-owner \
  && rm /tmp/node.tar.gz \
  && curl -fsSLo /tmp/go.tar.gz "https://go.dev/dl/go$GO_VERSION.linux-$goarch.tar.gz" \
  && echo "$gosum  /tmp/go.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/go.tar.gz -C /usr/local --no-same-owner \
  && rm /tmp/go.tar.gz \
  && ln -s /usr/local/go/bin/go /usr/local/go/bin/gofmt /usr/local/bin/ \
  && npm install -g "pnpm@$PNPM_VERSION" \
  && npm cache clean --force \
  && groupadd --gid 2000 workspace \
  && useradd --create-home --shell /bin/bash --uid 1000 --gid workspace smithers \
  && install -d -o smithers -g workspace -m 2775 /workspace \
  && git config --system safe.directory '*' \
  && git config --system core.sharedRepository group \
  && echo 'umask 002' >> /etc/bash.bashrc \
  && echo 'umask 002' >> /etc/profile \
  && ln -s /bin/sleep /usr/local/bin/smithers-idle
COPY tmux.conf /etc/tmux.conf
ENV LANG=C.UTF-8 TERM=xterm-256color
USER smithers
WORKDIR /workspace
# PID 1 is tini, which reaps every orphan reparented to it: with `sleep infinity` as PID 1, a person's background
# `git` that exited stayed a zombie forever. Under it the box idles as `smithers-idle` (`sleep` by another name), which
# the idle probe (worker/branch/Machine.ts) knows is the box's own and not a person's work. A shell ignores whatever
# arguments the runtime appends.
ENTRYPOINT ["/usr/bin/tini", "--", "/bin/sh", "-c", "exec smithers-idle infinity", "sandbox"]
