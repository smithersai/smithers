---
title: Keep maintainer file reads bound to the checked file
status: done
area: process
owner: Codex
updated: 2026-11-12
links: [../../../../apps/maintainer-site/README.md]
---

The file, Markdown and outline endpoints must read the same file that passed the
root, secret-name, file-type and size checks. A concurrent path replacement must
not disclose another file.

The stale-card answer finding is already covered by the server's version check
and the queue's conflict recovery. This change covers file descriptor ownership,
path replacement, byte ranges and outline cache identity with real files and HTTP
requests.

Validation: all 105 maintainer-site unit and browser-review tests passed, as did
the keyboard queue and code-tools end-to-end checks. The descriptor, Markdown
and outline-cache regressions failed on the unmodified server. Real worker
threads exercise file, ancestor-directory and secret-directory replacement
through both file URL forms, Markdown and outlines (1,800 requests).

Linux validates the opened inode's kernel path before reading. macOS uses
the kernel's whole-path no-symlink open flag; that host-specific branch has not
been executed in this validation. File reads fail closed elsewhere.
