---
"@smthrs/cli": minor
---

`runner.json` gains `idleExitSeconds`: `smthrs runner serve` ends once it has served no job for that long, so a
Cloudflare overflow box sleeps when the overflow is gone (decision 0144). `admission.loadPerCpu` now goes up to 1000,
which turns load admission off in practice.
