---
title: W8 mobile recording and layout regressions
status: blocked
area: mobile
owner: Codex mobile-w8
updated: 2026-10-26
links: []
---

Rebased onto W10 (3a56f5a6). Saved W10 production receipts pass the persisted
page and Your model at all three sizes; no new production requests authorized.
Investigating recording failures and retaining narrow pending-page coverage.
Library catalog: @smthrs/ui (existing public WebPageView and theme tokens).

Saved production W10 receipts pass both named failures at 390, 768 and 1280px.
The newer targeted run also produced six passing videos/GIFs. The persisted-page
browser regression passes without CSS changes. Your model already renders for a
signed-in Member with no saved model; its four existing view tests pass. The
Settings shell alone cannot distinguish an unconfirmed session from a missing
role; no evidence supports bypassing that authorization gate or extending its
five-second expectation.

One saved flashing GIF shows a compressed full-document capture with a gray
right margin between matching viewport frames. A real browser recording
reproduces the screenshot compositor resize. Full-document PNGs and original
videos remain intact; declared capture intervals are excluded before scene and
chapter holds, with a regression preserving a chapter ending in a capture.
Unmarked flashes and blank recordings still fail. Paint acknowledgments span
two recording sample slots, retaining a distinct final screen on short audits.
The real recording-to-GIF pipeline and its unchanged validators pass locally on
Latitude. This is test infrastructure, not a new product feature or plugin.

The eight original blank-build failures lack their raw failed recordings in the
supplied evidence. An available saved unavailable-page video contains Not Found
and the bell, rather than an empty page. Retaining final paints addresses short
recordings, but this does not establish the cause of every original blank-build
failure. Those cases need a new authorized deployment run to verify.

No production request, push or deployment was made. The Mac mini was skipped
because it is unreachable. No new dependency, SDK API, migration or decision
number was introduced. Astra's chapter-hold review finding is fixed.

Latitude validation: all four app typecheck projects, importRules and lint pass.
The 72 focused tests pass, including real WebPageView geometry, empty-model
Settings, renderer paint timing, recorded production frame measurements, chapter
holds and the real recording-to-GIF pipeline. Both changed media helper modules
have 100% statements, branches, functions and lines. The shared UI suite passes
2,661 tests with its coverage configuration; no thresholds were changed.
Linux headless Chromium did not reproduce every macOS screenshot artifact with
the old media path; the saved production measurements retain the flash regression.
Astra has no remaining blocking findings. Fable could not review: Latitude's
Claude session is signed out. The temporary review environment was removed.
