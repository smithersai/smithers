---
title: Visitor About reads off GitHub's anonymous quota
status: in-progress
area: app
owner: Claude builder about-quota
updated: 2026-10-25 15:21 PDT
links:
  - ../features/repo.md
  - ../decisions/0079-roles-per-repository.md
  - production-bug-bash-2026-10-23.md
  - prelaunch-vibelang-on-smithers.md
---

**What:** A signed-out visitor's first look at a public repository (its home before a clone, the Docs tab, the code
root) must not fail when GitHub's anonymous quota is spent.

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
  goes stale, the stale answer served meanwhile and for up to 7 days while GitHub can't answer, and GitHub's refusal
  kept until its wait passes.
- The browser says "GitHub isn't answering. Repositories already cloned keep working." when GitHub is down.

**Proof:** `worker/about/*.test.ts`, `worker/RepoAbout.test.ts` (fifty concurrent visitors cause one read, in one
isolate and across two), `worker/RepoApi.test.ts`: typecheck, importRules and the focused suites (262 tests) pass on
Latitude, every changed file at 100% coverage. Not yet run: `e2e/vibelang-visitor.spec.ts` "a crowd of visitors"
(the mini's dev server didn't build on 2026-10-25), and the same spec against smithers.sh after a deploy.
