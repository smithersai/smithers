---
"@smthrs/build-cli": minor
"@smthrs/build": minor
---

`SMITHERS_GO_CACHE` names one Go compile cache directory for every checkout on a host. Planning and unconfined tools use it instead of the workspace's `go-build`, and `cache status` and `cache prune --max-size` measure and cap it. A confined tool keeps the workspace's own directory.
