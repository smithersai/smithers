---
title: The VibeLang factory on Smithers, at factory.smithers.sh
status: in-progress
area: factory
owner: smithers-factory (Claude Opus)
updated: 2026-10-30 00:40 PDT
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
- (c) For you with answers
- (d) every remaining view (Failures, Spec reviews, Implementation, Commits, Media, Docs, Queue)
- (e) code review on a VibeLang pull request

**Smithers bugs found:** none yet.

**Only Will can do:** register `https://factory.smithers.sh/api/auth/callback` on the GitHub App; make
`codeplanesmithers` a Maintainer on smithersai/vibelang (or test with his own account).
