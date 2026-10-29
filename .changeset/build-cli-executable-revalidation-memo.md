---
"@smthrs/build-cli": patch
---

A run re-reads a tool's bytes before a target only when the file changed. Each target re-identified every tool it declares by hashing the whole file, so 800 cached targets that name `S.Host.bin("node")` hashed a 150 MB binary 800 times: a warm run took 221 s instead of 23 s. The digest is now reused while the file's device, inode, size, mode, mtime and ctime are unchanged and its last change is more than a second older than the read, so an in-place rewrite, a replacement or a retargeted symlink still refuses with `executable changed since planning`.
