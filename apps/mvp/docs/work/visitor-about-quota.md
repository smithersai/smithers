---
title: Visitor About reads off GitHub's anonymous quota
status: done
area: app
owner: Codex GPT-6.1 Sol
updated: 2026-11-02
links:
  - ../features/repo.md
  - ../decisions/0079-roles-per-repository.md
  - production-bug-bash-2026-10-23.md
  - prelaunch-vibelang-on-smithers.md
---

**What:** A signed-out visitor's first look at a public repository (its home before a clone, the Docs tab, the code
root) uses the repository's allowed authenticated quota. Only fresh About content may be returned.

**Why:** Will, 2026-10-19 12:36: "are we sure this works iwthout risk of rate limit and stuff?" His bug bash on
2026-10-23 saw a visitor get 503 where a Member got 200 for the same repository. One About read cost 11 GitHub calls
from the anonymous quota (60 an hour per address, shared by every Worker), and the answer was cached per data center.

**Change:**
- A repository the Smithers App is installed on (and `GITHUB_ALLOWED_REPOSITORIES` doesn't leave out) is read with that
  repository's installation token for everyone; elsewhere a Member uses the deployment's token and anyone else reads
  anonymously.
- With a token, one GraphQL query plus the contributors (2 to 3 calls); anonymously, a slimmer REST read (10 calls for a
  typical repository). A part GitHub can't give now is left out and the answer is fresh for 5 minutes at most.
- The answer is kept in Postgres (`repo_about`, migration 0060) for every data center, with one claimed read when it
  expires. A kept answer at or past `freshUntil` is never served, including during a held read or GitHub outage;
  requests get the same refusal and retry behavior as when no answer is kept. GitHub's refusal is kept until its wait passes.
- The browser says "GitHub isn't answering. Repositories already cloned keep working." when GitHub is down.

**Original proof (2026-10-25):** `worker/about/*.test.ts`, `worker/RepoAbout.test.ts` (fifty concurrent visitors cause one read, in one
isolate and across two), `worker/RepoApi.test.ts`: typecheck, importRules and the focused suites (262 tests) pass on
Latitude, every changed file at 100% coverage. Not yet run: `e2e/vibelang-visitor.spec.ts` "a crowd of visitors"
(the mini's dev server didn't build on 2026-10-25), and the same spec against smithers.sh after a deploy.

**Privacy hotfix (2026-11-02):** Removed the seven-day fallback and its browser cache age. No visibility check added;
the existing fresh cache TTL is the bound. The public client maps GitHub's 503 refusal to its existing failure message
and Try again; a held-read timeout keeps its retry delay. `aboutProps` supplies no content on failure. Navigation and
cloned Code remain usable; the visitor About panel being empty during a GitHub outage is accepted. Catalog: existing
`@smthrs/integrations` GitHub reader and `@smthrs/ui` About panel; no new library.

**Hotfix validation:** Latitude, exit 0: `pnpm typecheck` and `pnpm exec vitest run worker/RepoAbout.test.ts worker/RepoAbout.workerd.test.ts worker/about/ worker/RepoApi.test.ts src/features/repo/view.test.ts src/features/repo/reader.test.ts src/features/repo/repo.test.ts --coverage.enabled=false` (202 tests, 8 files). A separate `pnpm exec vitest run worker/RepoAbout.test.ts --coverage.include=worker/RepoAbout.ts --silent` passed all 34 tests with 100% statements, branches, functions and lines for `RepoAbout.ts`. Its first farm attempt stopped before tests during service setup; the rerun on the passing slot succeeded. Regressions cover an expired kept answer with GitHub failing, a held concurrent refresh returning a retryable refusal without content, and the public client's empty About/retry and cloned-file views. Existing client integration tests confirm refusal and manual recovery. No production E2E run or browser session was used for this hotfix.
