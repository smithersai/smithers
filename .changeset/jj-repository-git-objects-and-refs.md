---
"@smthrs/jj": minor
"@smthrs/integrations": minor
---

Add `Repository` to `@smthrs/jj`'s root entry: git blob, tree and commit I/O under git's own object ids, `readRefs`,
and `updateRefs`, one compare-and-swap over several refs that checks every old value. No `git` CLI, notes included.
`Repository.layerMemory()` holds a repository in memory. `@smthrs/integrations` adds `GitHub.GitDatabase`, the same
service on GitHub's Git database API and GraphQL `updateRefs`; without an atomic ref update it fails `unsupported`
rather than moving refs one at a time. Import it as `import { Repository } from "@smthrs/jj"`.
