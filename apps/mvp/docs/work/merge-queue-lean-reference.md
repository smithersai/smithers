---
title: A merge queue proved in Lean
status: in-progress
area: sdk
owner: merge-queue (Fable 5.2)
updated: 2026-11-10
links: [packages/smithers/flows/merge-queue/README.md, packages/smithers/flows/merge-queue/lean/INVARIANTS.md]
---

Will asked for a merge queue whose rules are proved correct, to replace VibeLang's `mq.py` (2026-11-10): a Lean
reference implementation, an implementation structured after it, agents that fix failing changes, unmergeable with a
reason, streaming CI results and predicted durations.

Done, on `main`: `@smthrs/merge-queue` (`packages/smithers/flows/merge-queue`). `lean/` is the reference: an
executable Lean 4 model with every invariant in `lean/INVARIANTS.md` proved (the build checks the matrix and audits
axioms). `src/` is the same state machine in TypeScript, one definition per Lean definition, held to the reference by
a differential fuzz test and recorded reference digests. `mutants/` plants 43 bugs in both and shows each one is
caught.

Open: one matrix row (a single decreasing measure for the whole queue). In progress: the driver that runs the queue
as durable flows against CI, fix agents and the target branch. After that: throughput benchmarks, and a cut-over plan
for VibeLang with a shadow run beside `mq.py`, which needs Will's approval.
