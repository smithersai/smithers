# Admitting outside stacks

`coding/AppendOutsideStack` (`outside-stack.ts`) appends jj stacks that other
authors built to the mythical history as Changes. It is the operation a merge
queue needs when many independent agents each produce their own jj stack and
enqueue it: apply each stack to the tip, run its fast checks, and move the tip
only over stacks that passed.

## Input

```ts
AppendOutsideStack.execute({
  target: "vibe", // the bookmark that names the mythical tip
  expected: "<40-hex>", // optional: the tip the caller saw
  stacks: [{ id: "lane-a-17", title: "fix(parser): …", base: "<40-hex>", head: "<40-hex>" }],
  checks: [/* the repository's Check rows; only `tier: "fast"` gate admission */]
})
```

An outside stack is the author's linear commits `base..head`: the root's sole
parent is `base`, and every later commit's sole parent is the one before it.
`stacks` holds 1 to 64 stacks, each at most 256 commits, in queue order.
Stack ids and check ids must each be unique; a repeated id is
`invalid_request` before any stack moves.

## What happens

```
ReadTip(target, expected?)                 tip moved since `expected` -> evicted, nothing applied
for each stack, in order:
  ApplyStack(stack, parent)                jj rebase -s <root change> -d <parent>
    empty / not linear                     -> refused
    rewritten, reshaped or gone since it was enqueued -> refused (stale), never moved
    base's change not on the tip's line    -> refused (base_not_on_tip), never moved
    a change already on the tip            -> refused (already_applied), never moved
    conflicted after the rebase            -> rebased back onto `base`, refused (conflict)
  RunCheck(head, check)  every fast check  receipts bind the exact commit and tree
    a check delegate fails                 -> the run fails (below)
  GateStack                                all required fast checks passed -> admitted
                                           red -> rebased back onto `base`, refused (fast_gate)
                                           outage or bad receipt -> rebased back, the run fails
  parent := admitted head, or the unchanged parent when refused
AdvanceTip(target, expected tip, last head)  jj bookmark set, fast-forward only
  target moved, or the head was rewritten after its checks -> every admitted stack
                                           back onto its base, newest first; evicted
```

When the run fails for any other reason (a check delegate or the host fails, a
receipt is invalid, or an admitted head was rewritten before the next stack
applies), every stack it moved above the starting tip goes back onto its own
base, newest first, before the failure is recorded. A failed run moves nothing
it does not have to: a stack the target bookmark now sits on (someone landed
it, or set the tip onto it) is never moved back, and the run reports
`evicted`. An author's own bookmarks on a stack move back with it.

"Back onto `base`" means onto the visible commit of the base's change. The
enqueued base commit may be hidden (an amend in place, or the rebase of the
stack it was built on); rebasing onto it would make it visible again beside its
rewrite and leave a divergent change on the tip.

- **Change ids survive.** The stack is rebased by change id, so each admitted
  Change's atoms are the author's own jj changes.
- **A refused stack never blocks the next one.** The next stack applies onto
  the last admitted head. A refused stack is back on its own `base` with its
  change ids, so its author fixes it and enqueues it again.
- **Only fast checks gate admission.** Slow and delivery checks belong to the
  stack's later checking of its tip.
- **The tip only moves forward, onto what was checked.** `AdvanceTip`
  refuses a target that moved during admission, or a head rewritten since its
  checks ran (`evicted`), and first rebases every admitted stack back onto its
  own base, newest first; jj refuses a move that is not a fast-forward.
- **A stack built on refused work is refused.** The base's change must be on
  the tip's line. A stack built on an admitted stack is admissible, and when
  it is refused it stays on that stack, its own base. The base's change, not its commit: an amend in place below
  the base keeps the stack admissible.
- **Only enqueued content is admitted.** An author who amends, reshapes or
  abandons a stack after enqueueing it gets `stale`; enqueue the new head.

## Result

`AppendResult` has the target's new commit (`tip`) and one `StackOutcome` per
stack: `admitted` with its `ValidatedChange` (the implementation and fast
receipts, the same shape `ImplementPlan` returns), or `refused` with a
`reason` (`empty`, `not_linear`, `stale`, `base_not_on_tip`,
`already_applied`, `conflict`, `fast_gate`), a
message, and the failing checks' findings.

## Recovery

Every write reconciles before it repeats. A replayed `ApplyStack` finds the
stack already on its parent, a replayed restore finds it on its base, and a
replayed `AdvanceTip` finds the target at the head. A completed run answers
from its journal: nothing is rebased, checked or moved again.

## Host

A coding host serves the flow only when it lands locally
(`.smithers/coding-project.json` `landing`), never beside the backend's
landing adapter and never as an installed host (`outsideStacksServed` in
`host.ts`). The host binds `OutsideStacks.layer` to its repository and the
landing environment; checks run through the host's `coding/check` delegate.
