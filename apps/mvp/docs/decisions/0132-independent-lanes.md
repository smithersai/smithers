# 0132: Independent lanes: a repository runs up to 64 TODOs at once, stacked only by choice

Date: 2026-10-31. Status: accepted. Builds on [0016](0016-todos-and-the-stack.md) (the stack and its one writer) and
its stacked pull requests. Slice S4 of the G1 + G2 design (factory coding agents on smithers.sh,
`~/Desktop/smithers-sh-parity/design-g1g2/FINAL.md` §3.1, §3.2, §7). Will reviews it with the feature (HOST-3).

## Problem

A repository runs one Working TODO (`stacks.lanes` defaults to 1 and takes at most 8), and every TODO stacks on the one
before it: a failed TODO holds every Queued TODO after it (`todos.md`, "Admission after a failed base"). VibeLang's
factory runs 52 lanes of independent work. On smithers.sh that is 52 sequential TODOs, and one failure stops all of
them.

## Decision

1. **`todos.after`.** A TODO names the open TODO it waits for and stacks on, or none. It is always an open TODO before
   it, so the chains have no cycles. A TODO with none starts from the default branch's head at Begin. One with an
   `after` starts on that TODO's branch, and its pull request is a draft into it, as stacked pull requests are today.
2. **`stacks.base`, `stacked` or `independent`.** A commit that names no `after` takes the repository's base:
   `stacked` names the last open TODO, which is what every stack did until now, and `independent` names none. A commit
   may name a TODO number (`after: 3`) or `null` either way. A number that isn't an open TODO is refused
   `409 after_not_open`. Every repository stays `stacked`. VibeLang's Admin sets `independent`, 52 lanes and 200 open
   once this deploys.
3. **The fill rule.** Whenever a lane frees, the writer starts the oldest Queued TODOs whose `after` chain is In review
   all the way down: the TODO it names, and every TODO that one stacks on. It starts no more than `lanes`. A TODO In
   review holds no lane and no runner slot.
4. **A failure holds only the TODOs stacked on it.** A failed TODO keeps its place and holds the TODOs whose chain runs
   through it. Independent TODOs keep starting. A TODO that leaves the stack hands its own `after` to the TODOs stacked
   on it. One that leaves unmerged after publishing (Drop while In review, or a pull request closed on GitHub) fails its
   Queued children `base_closed`. Their children wait behind them. Running children learn it from their run, as before
   (`todo/InvalidateBase`).
5. **Retry** stacks the TODO on the nearest TODO its chain still has, past any whose pull request closed unmerged, or
   on nothing. It no longer escapes the fill rule with a flag (`todos.base_reset` goes). A retried TODO that waits for a
   lane and whose base then closes fails `base_closed` again, like any Queued TODO stacked there, and a person decides
   again.
6. **Settings.** `lanes` takes 1 to 64, `max_open` 1 to 500. An Admin of the repository sets `lanes`, `max_open` and
   `base` in person through the stack route (`op: "configure"`, the protected act `stack/configure`). The writer applies
   it in its one transaction and starts what a raise frees. A lower count stops nothing.
7. **Waiting for a runner.** `todos.waiting` is `runner` while a Working TODO's job waits for a runner to claim it. The
   run reports it (`Stack.report`, event `waiting`), and the writer clears it whenever the TODO leaves Working. The row
   and page read "Waiting for a runner" and don't blink. The agent runner (S1) sets and clears it. Nothing sets it
   before S1 lands.
8. **Fixes #n.** A TODO's pull request says `Fixes #n` only when no other open TODO from the issue remains, except the
   TODOs it stacks on, which merge first. Independent TODOs from one issue each say `Part of #n`, so merging one never
   closes the issue the others still work on.

## Rejected

- **256 lanes** (Fable): nothing needs more than 64, and the load test proves 50 to 52.
- **A per-TODO `stacked` flag**: it can't say which TODO to stack on, and an `after` that isn't the one before it is
  exactly what a person wants when two streams of work share a repository.
- **Keeping `base_reset`**: it existed to let a retried TODO pass the positional block. With `after` there is no
  positional block, and two rules for one wait are one too many.

## Consequences

- Migration `0076_independent_lanes` gives every open TODO the open TODO before it as `after`, so each stack behaves
  as before. It must run after `0074` and `0075`, which other changes hold.
- Under `stacked` with one lane, the rules start what the old rules started. With more lanes, a stacked TODO now waits
  for the TODO before it to be In review instead of starting on whatever was In review. That is what stacking means.
- The stack page shows `After T<n>` on a stacked TODO's row and page. There is no control yet to choose `after` in a
  draft, or to change the settings in Settings: the route takes both, and the browser's commit sends no `after`, so it
  takes the repository's base.
- Observability: `stack.apply` logs `lanes`, `working`, `ready` and `held`; `todo.run.requested` and
  `smithers_todo_lane_starts{base}` count starts on a TODO and on the default branch; `stack.report` records `waiting`.
- Proof: property tests over random independent, stacked and mixed histories (`src/features/todos/stack.test.ts`),
  the writer on real Postgres with ten lanes, one failure, nine publishes and a stacked TODO
  (`worker/stack/Stack.test.ts`), and `e2e/todos-independent.spec.ts`.
