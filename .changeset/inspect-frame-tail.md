---
"@smthrs/time-travel": patch
---

Return not_found when inspect or replay addresses a frame past the committed
journal tail. Keep bounded paging and existing lineage validation.
