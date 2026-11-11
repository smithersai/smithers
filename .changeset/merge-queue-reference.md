---
"@smthrs/merge-queue": minor
---

New package: a merge queue whose rules are proved in Lean. `step` is the queue and `plan` its policy; the target moves
only onto a tree whose every required check passed, results stream in, a failing change goes to a fix agent at its
first failure, failing batches bisect, an unfixable change leaves with a written reason, and check durations are
predicted from past runs. The Lean reference in `lean/` proves the invariants, and a differential fuzz test holds the
TypeScript kernel to the reference line for line.
