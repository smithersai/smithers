---
"@smthrs/jj": patch
---

The browser reactor's `workspaceAdd` refuses a destination whose symlinked parent resolves into a repository's `.jj` store or a colocated `.git` directory. The `.jj`/`.git` check was lexical, so `/work/link/lane` passed when `/work/link` pointed at `/work/repo/.jj`.
