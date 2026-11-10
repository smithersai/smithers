---
title: Prove the VibeLang app decisions
status: in-progress
area: vibelang
owner: Codex (vl-proveall)
updated: 2026-11-08
---

Will's VL-29 proof lane: inventory every executable function, extract and prove decisions, reject executable mutations,
and record every tool boundary. [Decision 0018](../../../vibelang/wiki/decisions/0018-proofs.md) holds the current
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

Fourteenth batch: the unchanged iterative issue-link guard now proves an exact bounded first-match ancestor path
reaches the root without the child. The full conversation proof runs in 19,896 isolated batches; fifteen new mutants.
All 770 current mutations match actual Dafny failures; an equivalent early-self-check deletion is excluded and
replaced. Global graph preservation and acceptance completeness remain explicit gaps. Rebased on `6db1ba51` (HTTP
tests); required gates rerun. A new optional-union-default tool reproduction retains the exact contract.

Fifteenth batch: Reply accounting preserves prior valid spend after negative, fractional, NaN, infinite and unsafe
settlements, latches invalidity and refuses successful completion with invalid accounting. Seven numeric regressions
fail first; the eight-case integrity suite passes afterward. Nine production proof functions (ten units), 47 new
mutants; all 17 module hashes and 817 mutants match actual receipts. Typecheck exit 0, 835 unit, 52 workerd, 9 reply
fuzz targets (139,674 executions, 1 retained replay) and 2 affected benchmarks pass. Native safe-integer emission is
a minimal exact-contract tool gap; event routing and SDK replay are not claimed proved.

Sixteenth batch: twelve shared history-page decisions reuse the existing ranking. Role/status, Plan operation and
fields, open-epic membership and opening prefix, signature and label policies are called by the HTTP, flow and browser
hosts. 23 proof units; 61/61 module mutants reject (45 new); 17 sources and 862 mutants match receipts. Typecheck 0,
835 unit, 52 workerd and 21 history browser cases pass on port 4504. Page merging and model admission remain open.

Seventeenth batch: Reply event dispatch runs through the proved reducer: ignored and non-text identity, requested and
retried resets, exact settled charges, latched invalidity and failure frames. The SDK host only projects payloads.
13 units; 61/61 mutants reject (14 new); 17 sources and 876 mutations match receipts. Typecheck 0, 835 unit,
52 workerd, 9 fuzz targets (119,738 executions, 1 replay) and 2 benchmarks pass. The optional-member-default
reproduction keeps the emitter failure; present and undefined postconditions stay as implications.

Eighteenth batch: the Reply body threads the verified start receipt, composition and settlement order. Eight new
methods bound counters to 0..1, admit only done, require composition before settlement and keep terminal and refused
states immutable. 21 flow units; 102/102 mutants reject (59 new); 17 sources and 935 mutations match receipts.
Typecheck 0, 835 unit and 52 workerd pass. Engine and logger order tests fail first, then pass with count-only
annotations and no post text or names. Retry attempts and SDK replay are explicit boundaries.

Nineteenth batch: the Tour active, ready, one-speaker and terminal model and EndTour's record-before-wake order are
threaded through the real bodies. Six new functions, 27 flow units, 129/129 mutants reject (27 new); 17 sources and
962 inputs match receipts. Typecheck 0, 835 unit, 52 workerd, 15 targeted and 33 browser cases pass on 4504.
Rebased on `1b5decf5`: 838 unit cases in 127 files, 52 workerd and 33 browser cases pass. Inventory 2,508.

Twentieth batch: the walkthrough's counter, wait, seek and clock choices move into proved `flowDecision` functions.
Private visit and turn counters use BigInt; step names are unchanged. Five functions, 33 flow units, 12 new mutants.

Twenty-first batch: 19 inline `update` guards move to `src/web/modelDecision.vibe` and are proved; 23 units and 49 new
mutations reject. `update` itself, its Model frames and command dispatch remain unproved.
