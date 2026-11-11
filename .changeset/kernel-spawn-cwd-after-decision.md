---
"@smthrs/kernel": patch
---

`ChildProcessSpawner.layer` resolves each stage's working directory again after the grant decision. A directory replaced by a symlink while an attended request waits is refused instead of followed, and an approved child starts in the real directory that was judged.
