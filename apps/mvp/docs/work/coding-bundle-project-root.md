---
title: Use the flows project to compile coding host modules
status: done
area: infra
owner: Codex
updated: 2026-11-23
links: ["https://github.com/smithersai/smithers/issues/4442"]
---

Both coding host build passes now use the flows project. Cloudflare run
`dff04d4e21d2d63bf67dd7b2` confirmed that the old build tried
`coding/tsconfig.json` before recovering, and that the fixed build compiled the
native fixture using only the owning `tsconfig.json`. All five bundle and size
tests passed. The packaged host measured 54,417,076 bytes against the
134,217,728-byte limit.
