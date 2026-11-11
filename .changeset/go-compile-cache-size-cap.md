---
"@smthrs/build-cli": minor
"@smthrs/build": minor
---

`cache prune --max-size <size>` caps the local action results plus the Go compile cache, evicting the least recently used entries first. Every tool that can reach the compile cache holds a lease while it runs, and prune never removes an entry used since an hour before the earliest live lease began, so it is safe to run beside builds. The report gains `goBuild` (candidates, removed, in use) and `size` (limit, before, after). `CacheAdmin.remove` accepts `maxSizeBytes` and `CacheAdmin.parseSize` reads sizes such as `40GiB`.
