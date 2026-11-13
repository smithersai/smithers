---
title: Desktop test builds and captured folder access
status: done
area: vibelang-desktop
owner: codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/5018
---

Stable builds refuse test mode before packaging, including when Electrobun catches configuration import errors. Native screenshots use Playwright output paths and retain explicit path overrides.

Folder tests use captured selections and `read`/`replace` for traversal, symlink, size, stale-original and revocation checks. Remove the unused unbound folder operations and implicit model-selection state.

Validation: all 25 targeted tests pass after rebasing. The new stable-build and capability checks fail against the original configuration and services. The shipped Electrobun CLI check and three isolated real-browser screenshot checks pass. The full package executes 27 passing tests, with three unchanged suite import failures. Typecheck reports the same 11 diagnostics before and after the fix; package lint also reports existing API and declaration errors. Full native conversation testing remains unavailable while the unrelated host and view imports fail typechecking.
