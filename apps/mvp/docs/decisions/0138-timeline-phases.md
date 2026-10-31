# 0138: Timeline phases: variable spans stored on the messages they start at

Status: accepted (2026-10-31, CL-timeline-fe19). Ruling [FE-19](../rulings.md) requires outer levels to be logical phases with human summaries, not fixed strides, and requires a notification when summaries can't be made. It keeps the 2026-10-25 cost rules from [the feature's Cost section](../features/timeline.md#cost): one call per revision for every device, and a daily cap.

## Decision

1. **A span is a mark on the message it starts at.** `messages.phase` (level 1) and `messages.arc` (level 2) hold JSON: `title`, `summary`, `closed`, `covered`. A span runs from its mark to the next one.
2. **The model segments, in steps.** A conversation is cut by the durable flow `timeline/phases` on the browser engine: one sealed `ModelStep` through `/api/model/summary`. It reads numbered items, each an exchange's question summary and the first 180 characters of its answer, and answers `{ spans: [{ from, title, summary }] }`.
3. **A span closes on evidence.** A call starts at the open span, or after the last closed one, and reads up to 24 exchanges. A span closes once at least three items follow it; the rest stay open and the next call reads them again, so a boundary drawn from too little evidence can still move. A call that reads a full window closes everything, so a span is at most 24 exchanges and a backlog always moves on. The server refuses to rewrite a closed mark.
4. **Calls come in steps of new work.** A call is due once 4 new exchanges follow what the open span covers. Its revision is `(anchor, level, items read)`, and `items read` is a multiple of 4, so every device names the same call and `timeline_phase_claims` lets one of them make it.
5. **Arcs are the same algorithm, one level out.** The items are closed phases: from 12 of them, one call per 6 new ones, 16 at most. They exist before a third column is needed, and the rail shows that column only once phases outgrow level 1's capacity.
6. **Blocks are one height.** Every level-1 block in a column is the same height. Size shows in the block's strip: one mark per exchange, the strip as tall as the block is full.
7. **A claim whose model never answered is released.** `unconfigured`, `credit`, `capped` and `unavailable` free the claim, so a chat summarized while no model was set gets its summaries once one is. So does a segmentation's unusable answer, since a kept claim would freeze the conversation's phases at that point, and a claim left by a closed tab can be taken again after ten minutes. Every attempt counts against the daily cap, released or not, so an outage can't re-claim the same messages for ever. A later span with an unusable title joins the one before it.
8. **Stops say so.** A failure every later call would repeat stops the tab's lane, as before, and now raises one local toast per cause on the shared stack (decision 0009), and marks the rail's pending entries.

## Why

- **On the message, not a new table.** The message shape already syncs to everyone who may read the conversation, with access rules, device storage and deletion all solved. A `timeline_phases` table needs its own shape, access check and device collection for the same reach. Deleting a phase's first message merges it into the previous phase, which is the right reading.
- **Model segmentation, not a heuristic.** FE-19's examples ("Researching issue 450", "Fixing flaky checkout tests") are about goals, which only the text says. Time gaps and message counts produce the stride Will rejected.
- **Short input.** An exchange costs about 70 tokens instead of thousands, so 24 exchanges plus 900 output tokens is one bounded call. Answers stay in their own words because the eval showed sentences built from summaries alone misattributing details.
- **Every 4 exchanges, not every message.** The open phase updating with each message would cost one call per exchange and read the same text again. Four keeps it current within about two screens at no more than one call per 8 entries.
- **Uniform blocks over proportional heights.** A block holds a two-line 10 px title, so a one-exchange phase needs about 28 px, and proportional heights push long phases off the column or make short ones unreadable. Proportional heights also reflow every block as a phase grows, which the mock rules out ("nothing jumps"). The approved mock has uniform blocks with a strip for size, so the rail keeps that reading.

## Costs

```
one conversation of E exchanges, once, for everyone
  entry summaries   2E calls, 32 output tokens each
  phases            about E/4 calls, at most 24 items in, 900 tokens out
  arcs              about E/(6 × average phase size) calls
```

A closed span is never read again, so the total stays linear in the conversation, and another tab, device or person pays nothing. The daily cap counts summaries and spans together.

## Consequences

- A person who reads a very long chat for the first time spends its summaries from their cap, newest first. `TIMELINE_SUMMARY_DAILY_CAP` is still 200, about 90 exchanges a day with their phases. A long backlog finishes over days, and the toast says when the day's are spent.
- A title can only be as good as the model behind `summary`. `evals/timeline.eval.ts` grades it, and is the check to run before changing the role's model.
- Messages gain two columns and the device's `chat-messages` store moves to version 6.
