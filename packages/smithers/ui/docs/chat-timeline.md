# Conversation timeline

`ChatTranscript` accepts a `rail` contribution. Pass `ChatTimeline` the conversation's entries, with their transcript anchor ids, kind, recorded state and short summary, and its logical phases. The rail is a slim vertical scrubber left of the chat. It never narrows the transcript.

```tsx
<ChatTranscript rail={<ChatTimeline entries={entries} phases={phases} arcs={arcs} onJump={jump} />}>
  {messages}
</ChatTranscript>
```

## Levels

Level 0 holds one 34 px row per entry: a mark whose height follows `length` (neutral for a question, teal for an answer) and up to two lines of summary. A track on its left carries a thumb over what the transcript shows, and a dot at the reading line.

Level 1 appears once entries no longer fit, and level 2 once phases no longer fit level 1. `higherLevels` supplies further semantic summary levels, innermost first. Each new level appears only when the previous one overflows; an unsupplied level is visibly pending, never given an invented summary. Every column has a capacity-bounded window, including arcs and higher levels. `phases` and `arcs` are `TimelineMarker`s: a block starts at entry `start` and stops at its recorded inclusive `end` anchor, so sizes follow what happened. Blocks in a column are one height; a strip of marks shows each block's size. Entries before, between or after recorded coverage are separate blocks titled with the first entry's label, marked pending. The rail never shows a count in place of a title.

A lens on each outer strip marks the stretch the next level shows, joined to it by funnel lines. Dragging the thumb or a lens scrubs the transcript. When its target is not mounted, the driver requests it through `onJump`, observes its mount, and restores the requested fractional message position. A newer drag target supersedes an earlier one; `data-navigation="pending"` exposes a history request until mounting completes. Each level holds still while the viewport stays inside it and pages when it leaves, so scrolling never drags it along.

Wheel and trackpad input over the rail (including its open phone sheet) scrolls the transcript, with pixel, line and page deltas; horizontal-only input and pinch zoom keep their native behavior.

A level slides in over 240 ms, then its lens fades in and its funnel draws. It leaves in reverse. With reduced motion, these become a 120 ms fade.

## Appearance

The rail stays behind the chat: 11 px muted text (10 px in outer levels), marks at about half strength, soft thumb and lens. Hover or keyboard focus brings it to full contrast in 150 ms. Summaries are always visible; hover adds detail: an entry's actor, time, tokens and cost, and a block's sentence, message count and time span.

A mark pulses teal while working. `Needs you` is gold, a failure is ember and a queued entry is hatched. In level 0 a host-provided `label` stays visible until the model summary arrives. Without one, the transcript's words describe its state: `Working`, `Needs you`, `Couldn't answer`, `Waiting`, `Queued`, `Not sent`. Outer strips show the colors.

The rail needs room beside the transcript: a viewport of at least 1,180 px and a transcript of at least 600 px. It measures the space to the page's left edge, or to an ancestor marked `data-rail-bound`. Below that it is closed behind `Timeline`, which opens the same levels in a sheet over the chat at full contrast; Escape closes it.

## Pending and unavailable

`label` carries a distinct short placeholder while a summary is pending, shown in italics; a nonempty `summary` takes precedence, and the accessible name keeps both. Pass `unavailable` when summaries can't be made: entries and blocks missing one are marked, and hover shows that text.

## Keys

Native buttons activate with Enter or Space. Arrow keys and J/K move to the neighbor and jump; Home/End reach the boundaries; Left and Right move between an entry and the blocks that hold it; Escape focuses the transcript entry. Without `onJump`, activation scrolls the anchor into view. `onActivate` is an explicit activation of a single entry, which keyboard traversal never fires.

`timelineKey` and `timelineLabel` are pure helpers, and `timelineZoom.ts`' geometry (`timelineLevelCount`, `timelineBlocks`, `timelineWidths` and more) is exported for hosts that lay out their own.
