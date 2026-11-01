---
title: Every page up to the mock look (FE-20)
status: done
area: frontend
owner: Claude Opus ui-polish
updated: 2026-10-31
links: [apps/mvp/docs/rulings.md, apps/mvp/e2e/look.spec.ts]
---
Every apps/mvp route now uses the `.specs/design/mock/` look (FE-20). Shared
pieces live in `@smthrs/ui`: brand links at zero specificity, card-framed
`Table` (`variant="plain"` for prose), `PageHeader` and `PageBody` with
matching `width`, phone-fit `RunList`, solid primary actions. Pages were
restyled by four Kimi K3 lanes and reviewed by screenshot, then by Fable.

Decisions:
- One solid primary action per page; everything else outline or ghost.
- Every repository page uses the wide header and column, so moving between
  Home, Code and Issues never shifts the header; forms keep a narrow card.
- Issues, pull requests, the stack, runs, secrets and settings drop the
  Home/Code tab row: the header's title goes home.
- The repository's top level keeps the About aside and the folder's README
  (docs/features/repo.md, e2e/repo-browse.spec.ts).
- Flow editor routes show a pending frame while `beforeLoad` opens them.

Proof: `e2e/look.spec.ts` (computed styles) fails 8 of 10 Runs checks on the
2026-10-31 production build and passes 8 of 8 on the deployed one. Before and
after shots: `~/Desktop/smithers-ui-audit/index.html`.

Open: a pull request's Files tab was only seen in its syncing state; an
unknown repository shows GitHub limit reached while the shared GitHub quota is
spent; `CodeFileView` wraps code mid-token on a phone (`overflow: "wrap"`).
