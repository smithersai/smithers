---
"@smthrs/sandbox": minor
---

Adds `SandboxTools.rebaseCall`, `rebased`, `rebasePaths` and `REBASE_PATHS`: a `run` call that plans, then applies, moving a working copy onto a commit fetched from `origin` with every change it holds merged on top by git's own merge base, a conflict listed and nothing changed.
