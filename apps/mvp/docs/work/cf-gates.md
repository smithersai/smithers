---
title: Gates on Cloudflare job machines (Smithers' merge queue)
status: in-progress
area: ci
owner: cfg-build
updated: 2026-10-30 PDT
links: [../decisions/0145-gates-on-cloudflare-job-machines.md, ../features/ci.md, ci-parity-artifacts.md, ci-parity-machine-sizes.md]
---

FLOW-14: the apps/mvp suite as the repository flow `gate`, 16 shards and a coverage job on Cloudflare job machines.
Done when the stage `smithers-gates-*` passes it with 0 failures in under 400 s, twice in a row, on per-commit
checkouts with merged coverage at 100%. Design: decision 0145. The 4 timing tests that fail on 4-vCPU boxes are the
`cfg-reds` lane's.
