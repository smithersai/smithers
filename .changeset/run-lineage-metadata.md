---
"@smthrs/run-store": patch
"@smthrs/engine-store": patch
---

Long-running flows no longer load every historical round's executable state for lifecycle decisions. These reads use validated lineage metadata; state is still checked whenever it is written or read as executable data. The default full-state lineage API remains unchanged.
