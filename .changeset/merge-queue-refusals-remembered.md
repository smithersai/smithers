---
"@smthrs/merge-queue": patch
---

`JjRepository` remembers a change that could not be applied on the changes before it, so every other run that
contains it is answered at once instead of replaying it, and it takes its lock for one change at a time and reads the
bookmark once per candidate, so a short candidate is not kept waiting behind a long one.
