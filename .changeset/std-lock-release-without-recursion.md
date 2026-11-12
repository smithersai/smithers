---
"@smthrs/std": patch
---

`edit`, `write` and `apply_patch` release their lock on a kernel-guarded host
whose rules restrict content under every directory, such as the
`deny fs:* <root>/**/.env*` a migration runs under. The release removed the
empty `.smithers-*.lock` directory recursively, which `@smthrs/kernel` refuses
when a deny or ask rule may select anything under the directory, so the call
died after its change and left the lock behind. The release now removes the
directory without recursion, and recursively only on a host such as Node's that
removes a directory no other way.
