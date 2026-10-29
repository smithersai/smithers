---
"@smthrs/engine-store": patch
"@smthrs/flow": patch
"@smthrs/engine": patch
"@smthrs/patterns": patch
---

Add an explicit flush option to node recording. Burndown flushes per-item
progress before returning so a completed landing stays visible while other
items continue running. Ordinary interpreter records retain write batching.
