---
title: Disable remote caching when credentials are absent
status: done
area: build
owner: Claude Opus (lane smithers-cache-no-token, after Codex)
updated: 2026-11-11
links:
  - packages/smithers/build/docs/workspace/remote-caching.md
  - packages/smithers/build/build-cli/docs/guides/share-a-remote-cache.md
---

A declared remote cache with no available credential stays local from the
start: no action-cache or output-CAS request, one `smthrs: remote cache off: no
credentials` notice, and no remote-failure or unconfined-publication warning.
Declared credential names stay withheld from target tools, and a read
credential alone keeps authenticated remote reads.

Done: a real-process loopback test (ported from vl-smithers-bump's VibeLang
acceptance test) and an injected `CacheCredentials` service that has none fail
on the base (two and one requests) and pass with the fix (zero requests).
