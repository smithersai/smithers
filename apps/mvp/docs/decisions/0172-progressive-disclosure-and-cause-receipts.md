# 0172: Gestures replace the developer mode, and every output carries a cause receipt

Date: 2026-11-24. Status: accepted (Gate 3, approved by Will 2026-11-24, recommended options 1A and 2A).
Nothing in this record is built yet.

## Context

The developer tools setting hides shipped features behind a toggle, breaks links shared between people with different
settings, and doubles the end-to-end matrix. Header links grow with every plugin. No output records the plan node that
produced it, so a link from an artifact to its cause has to guess from timestamps or headings.

## Decision

1. Three tiers, reached by gestures on objects, with no mode toggle. Tier 0 is chat with inline result cards. Tier 1 is
   one inspector drawer (Enter or `.`). Tier 2 is a workbench of at most three regions (Shift+Enter). Esc steps back.
2. The URL holds the layout: path, `sel`, `peek`, `at` and `as`. TanStack DB holds drafts, scroll anchors and focus.
3. The flow engine writes a `CauseReceipt` with every output in the same transaction: output ref, run, node, attempt,
   journal sequence, plan revision or typed origin, and prompt hash. A cause chip or Cmd+. opens it, and MCP `ref/cause`
   returns the same receipt.
4. The quiet launch ships a read-only canvas over `.vibe` workflows with a per-node IO inspector, a replay scrubber and
   an accessible ordered list. Editing the graph waits.
5. A visitor meets the waitlist when they try to add their own repository, not before.

## Rejected

- A Beginner and Pro toggle: same reasons as the developer mode.
- An editable node graph: it is a second workflow model beside `.vibe` code.
- Free tiling: unbounded layout state does not fit in a URL.
- Trace links rebuilt from timestamps or headings: they break under parallel retries and renamed headings.
