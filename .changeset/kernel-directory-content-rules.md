---
"@smthrs/kernel": patch
---

`FileSystem.layer` no longer lets `rename`, a recursive `remove` or `copy` reach content a rule restricts. `rename` now also requires `fs:read` on its source, so a read deny cannot be renamed away. When the operand is a directory, the three operations fail with `permission_denied` if a `deny` or `ask` rule may select anything under it, unless a later `allow` covers the whole directory. Before, only the directory's own name was checked, so `deny fs:read /workspace/secrets/**` did not stop `rename("/workspace/secrets", "/workspace/pub")`.
