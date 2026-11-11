---
title: A merge queue proved in Lean
status: in-progress
area: sdk
owner: merge-queue (Fable 5.2)
updated: 2026-11-11
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

The queue rebases every change on the tip of the target, only fast-forwards, and never blocks (Will,
2026-11-10). `Driver.round` runs it against the world through four injected services, and `QueueFlow.Queue` runs it
as a durable flow that resumes on another engine after a host dies.

Open: two matrix rows. One is a single decreasing measure for the whole queue. The other is throughput:
`scripts/benchmark.ts` shows the queue lands as fast as CI slots allow when nothing fails, and about 6 changes per CI
duration when 5% of changes fail, because one failing change holds the prefix behind it. Next: speculate past a
suspect. Not built: the real services (CI on `smthrs ci`, a jj target, the inbox command, the fix-agent launcher).
After those: a shadow run beside `mq.py` and the cut-over, which needs Will's approval.
