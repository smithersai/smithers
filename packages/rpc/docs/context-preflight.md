---
title: "Context preflight"
description: "Host-owned context selection and durable replay."
---

`ContextPreflightInputSchema` validates pinned provider candidates and defaults the token budget to 24000. Files and wiki pages require revisions; issues are excluded. `SelectedContextItemSchema` requires a selection reason.

`ContextPreflightFrameSchema` validates journal frames, including numbered pages of a named phase. A page index must be less than its total, and paged frames require a phase. Legacy unpaged frames remain readable. Host timing carries both `at` and `clock` or neither.
