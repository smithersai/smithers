---
"@smthrs/engine-store": patch
---

The `flow.run.claimed` log line names who took the run: `ownerHostId` and `ownerPid`, this engine's incarnation. A steal adds `stolenFromHostId`, `stolenFromPid` and `evidence`, the owner it took the run from and the liveness evidence that admitted it, so two live engines that each judge the other dead show as claims that alternate between their incarnations.
