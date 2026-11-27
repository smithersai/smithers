# apps

The applications in this repository, as pnpm workspace members (`apps/*` in
`pnpm-workspace.yaml`). Libraries live under `packages/`; see
[the library catalog](../docs/libraries.md).

| Path | Name | What it is |
| --- | --- | --- |
| [`apps/mvp/`](mvp/AGENTS.md) | `@smthrs/mvp` | The Smithers app, hosted on Cloudflare. |
| [`apps/site/`](site/docs/UI-DOCS.md) | `@smithers/site` | The smithers.sh landing page and docs. `apps/site/docs-redirect/` is the Worker that redirects the retired `<slug>.smithers.sh` library docs sites. |
| [`apps/tui/`](tui/README.md) | `smithers-tui` | The terminal coding agent. |
| `apps/maintainer-site/` | `@smthrs/maintainer-site` | The maintainers' local site: the decision queue and the e2e GIFs. |
| [`apps/bug-worker/`](bug-worker/README.md) | `@smthrs/bug-worker` | The bug.smithers.sh intake that `smthrs bug` posts to. |
| `apps/patterns-site/` | — | The static patterns.smithers.sh page. |
| `apps/vibelang/` | `@smthrs/vibelang-site` | The VibeLang coding factory app (`vibelang.smithers.sh`) with Lean 4 reference specs. |
| [`apps/vibelang-desktop/`](vibelang-desktop/README.md) | `@smthrs/vibelang-desktop` | Electrobun desktop wrapper for the VibeLang coding factory. |

The old app (`apps/app`), its edge Worker (`apps/server`) and the Go backend
were removed on 2026-10-21. Read them with
`jj file show -r 78407fce59dd <path>`.
