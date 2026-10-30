---
title: The VibeLang factory on Smithers, at factory.smithers.sh
status: in-progress
area: factory
owner: smithers-factory (Claude Opus)
updated: 2026-10-30 02:20 PDT
links: [../decisions/0126-repository-feeds.md, vibelang-coding-factory.md, prelaunch-custom-domains.md]
---

**What:** Will, 2026-10-30: "get Smithers working with our Vibelang repo and deployed to factory.smithers.sh. It should
have feature parity with the current factory but be built on top of Smithers". The old factory is
`~/Desktop/vibelang-monitor/` (factory.vibelang.sh).

**Design:** [decision 0126](../decisions/0126-repository-feeds.md): the collector pushes repository feeds; the factory
is the `factory` plugin on repository-scoped plugin views; `APP_ALIASES` serves it at factory.smithers.sh.

**Milestones:**
- (a) deployed at factory.smithers.sh, signed in to the VibeLang repository
- (b) Now and Agents with live data
- (c) For you with answers: done locally (`core/feed-items`, the strip's Accept and Change; e2e on the dev server)
- (d) every remaining view (Failures, Spec reviews, Implementation, Commits, Media, Docs, Queue)
- (e) code review on a VibeLang pull request

**Smithers bugs found:** in this stack only, each fixed with its test: the registry's and built-ins' test lists
missed `feed/answer` and the factory; `pull-review.spec.ts` skipped without a declared need; the factory spec looked
for a `banner` the repository header isn't; migration pass rates drew as progress bars, which the e2e reads as
loading.

**Only Will can do:** register `https://factory.smithers.sh/api/auth/callback` on the GitHub App; make
`codeplanesmithers` a Maintainer on smithersai/vibelang (or test with his own account).
