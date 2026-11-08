---
title: Prove the VibeLang app decisions
status: in-progress
area: vibelang
owner: Codex (vl-proveall)
updated: 2026-11-08
---

Will's VL-29 proof lane: inventory every executable function, extract and prove decisions, reject executable mutations,
and record every tool boundary. [Decision0018](../../../vibelang/wiki/decisions/0018-proofs.md) holds the current
inventory and claims. The app's normal CI includes proof, mutation and inventory gates.

Eight module batches are landed, through `de6d23840628`: thirteen marked proof modules and 567 rejected mutations
at that landing. The landed ninth batch adds exact sandbox admission/refusal/frame clauses and retains the existing
iterative runtime after 20,000-entry regressions reject an unlanded recursive candidate. Current checks: 810 rebased unit/integration passes, 52 workerd passes and 264 browser passes; thirteen-module
positive gate and 652 matched actual mutation rejections. The tenth batch adds startup choices: fourteen modules,
671 matched rejections, 810 unit/integration passes and fifteen focused browser passes. A receiver timeout is excluded and its revised omission
control separately rejects. The inventory contains 2,474 executable items and names unproved logic explicitly.
Prospective root-path issue-link, live dispatcher, reply-usage and theatre kernels pass; none is a production proof until
integrated and gated. Remaining work includes numeric applicability, pure renderer/seed/page logic, whole Model
composition and newly arriving functionality. Codec/regex/Date and backend composition gaps have minimal reproductions.
The host receipt is `~/vl/vl-proveall.REPORT.md`. No deployment is part of this lane.

The eleventh batch adds theatre selectors, speech identity/control and focus wrapping: fifteen modules and 714
matched actual rejections. Saved audio shape validation fixes a failing-first faulty-Window regression; native
speech observers delegate real methods. Typecheck, 826 unit/integration tests and thirty affected browser cases pass.

The twelfth batch threads the proved scan/attempt/done model through the live dispatcher: sixteen modules and
727 matched rejections. Typecheck, 826 unit/integration and 52 local workerd cases pass. Storage observations and
engine outcomes preserve their original order; even a busy first unmarked post stops this invocation.

The thirteenth batch models actual Post/StartTour record/refusal/dispatch order. All previous flow clauses remain;
sixteen modules and 755 current matched rejections, with 826 unit/integration and 52 workerd passes. The full app
proof goal remains in progress; the inventory names supported-but-unproved logic and actual tool boundaries.
