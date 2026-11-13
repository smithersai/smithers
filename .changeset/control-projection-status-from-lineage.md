---
"@smthrs/cli": patch
---

A host following a run of many rounds no longer reads every round's row, and its saved state, on every pass to see
whether the run has settled. It takes each round's status from the one lineage read the pass already makes.
