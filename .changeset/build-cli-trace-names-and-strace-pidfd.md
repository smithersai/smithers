---
"@smthrs/build-cli": patch
---

A step whose tests make a directory named with a newline (click's do) is stored: `smthrs-observe` writes the path of a listed directory escaped, as strace does, and the reader decodes it under either recorder. Under strace, a program that waits for its children through pidfds, as tokio and so uv do, no longer fails while recorded: strace answers `pidfd_open` as a kernel without pidfds does.
