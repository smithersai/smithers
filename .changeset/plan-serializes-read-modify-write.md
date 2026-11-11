---
"@smthrs/plan": patch
---

`Plan.compile` now serializes two unordered nodes that each read and write the
same path. Both steps editing `package.json`, or two agent steps that declare a
glob read and a glob write, used to fail with `cycle`: the reader-after-writer
pass refused the `serialize` edge the overlap pass had just added. The later
writer now follows the earlier one, and the earlier node reads what the path
held before either write. A reader that also reads a path the later writer
produces and it does not write itself still fails with `cycle`. No plan that
compiled before changes.
