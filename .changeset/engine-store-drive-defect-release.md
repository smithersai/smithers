---
"@smthrs/engine-store": minor
---

A drive that dies, for example on a storage error after it claimed or
activated a run, now releases the run with the new release cause
`{ kind: "defect" }` instead of leaving it claimed or `running` under a process
that still lives. A stale lease or claim held by the same engine incarnation is
reclaimed without a liveness check, so a run whose release also failed is
driven again in the same process. Before, a pid liveness check reported the
claimant's own pid alive and the run was refused on every sweep.
