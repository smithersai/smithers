# Conversation timeline

`ChatTranscript` accepts a `rail` contribution. Pass `ChatTimeline` the conversation's entries, with their transcript anchor ids, kind, recorded state and short summary, and its logical phases. The rail is a slim vertical scrubber left of the chat. It never narrows the transcript.

```tsx
<ChatTranscript rail={<ChatTimeline entries={entries} phases={phases} arcs={arcs} onJump={jump} onRequestHistory={mountHistory} />}>
  {messages}
</ChatTranscript>
```

## Levels

Level 0 is a minimap of the window it shows: one mark per entry (neutral for a question, teal for an answer) at the entry's position in the transcript and as tall as its share, at least 3 px. The driver measures each transcript anchor and keeps the measure after it unmounts; until then `length` gives an estimate. A track on its left carries a thumb over what the transcript shows, and a dot at the reading line.

A one-line label sits at its mark. Crowded labels slide down inside their own message, with a thin leader to the mark. In a window too dense for all of them, failed, waiting and working entries come first, then the longest; the rest show on hover or focus.

Level 1 appears once entries no longer fit, and level 2 once phases no longer fit level 1. `higherLevels` supplies further semantic summary levels, innermost first. Each new level appears only when the previous one overflows; an unsupplied level is visibly pending, never given an invented summary. Every column has a window bounded by a capacity of one entry or block per 34 px, including arcs and higher levels. `phases` and `arcs` are `TimelineMarker`s: a block starts at entry `start` and stops at its recorded inclusive `end` anchor, so sizes follow what happened. A block takes a two-line floor plus a share of the column's free room by what it covers; its strip marks and the lens use the same position scale. A title wraps to its block's height, and the full title is on hover. Entries before, between or after recorded coverage are separate blocks titled with the first entry's label, marked pending. The rail never shows a count in place of a title.

A lens on each outer strip marks the stretch the next level shows, joined to it by funnel lines. Dragging the thumb or a lens scrubs the transcript. When its target is not mounted, the driver requests it through `onRequestHistory`, which only mounts history and never scrolls. It observes mounting and restores the requested message ID plus its fractional offset, even when indices changed while loading. The requested point stays anchored through later layout changes until the reader scrolls or navigates. A newer drag target supersedes an earlier one; `data-navigation="pending"` exposes a history request until mounting completes; `data-reading-row`, `data-reading-y` and `data-reading-scroll` record numeric requested position and applied scroll geometry without content. Each level holds still while the viewport stays inside it and pages when it leaves, so scrolling never drags it along.

Wheel and trackpad input over the rail (including its open phone sheet) scrolls the transcript, with pixel, line and page deltas; horizontal-only input and pinch zoom keep their native behavior.

The position-scale layout recomputes geometry after a render even when a resize observer already recorded the new box dimensions. Numeric `data-layout-width`/`data-layout-height` on the rail and `data-window-start`/`data-window-end` on each clip expose the measured geometry without content.

A level slides in over 240 ms, then its lens fades in and its funnel draws. It leaves in reverse. With reduced motion, these become a 120 ms fade.

## Appearance

The rail stays behind the chat: 11 px muted text (10 px in outer levels), marks at about half strength, soft thumb and lens. Hover or keyboard focus brings it to full contrast in 150 ms. Summaries are always visible; hover adds detail: an entry's actor, time, tokens and cost, and a block's sentence, message count and time span.

A mark pulses teal while working. `Needs you` is gold, a failure is ember and a queued entry is hatched. In level 0 a host-provided `label` stays visible until the model summary arrives. Without one, the transcript's words describe its state: `Working`, `Needs you`, `Couldn't answer`, `Waiting`, `Queued`, `Not sent`. Outer strips show the colors.

The rail needs room beside the transcript: a viewport of at least 1,180 px and a transcript of at least 600 px. It measures the space to the page's left edge, or to an ancestor marked `data-rail-bound`. Below that it is closed behind `Timeline`, which opens the same levels in a sheet over the chat at full contrast; Escape closes it.

Wherever the rail shows beside the chat, the host leaves it `TIMELINE_ROOM` (380 px): a centered chat column whose margin is narrower shifts right into its empty space instead of squeezing the rail. `timelineWidths` gives level 0 its room first (200 px with two levels, about 190 px with three), so a summary's words read on its line, and widens the phase column with what remains, up to 140 px. Hover and focus previews stay within the rail’s right edge and the viewport, so they do not cover the transcript. Labels never hyphenate (`hyphens:none`): a phase title wraps between words, and the full title shows on hover only when its block is too short to hold it. A narrow panel, such as the branch page's conversation, keeps the rail behind `Timeline` at every window width. The sheet is up to 380 px wide; with less than 340 px of rail, as on a phone, the outermost of three columns is a strip of colors so the inner two keep their words.

## Pending and unavailable

`label` carries a distinct short placeholder while a summary is pending, shown in italics; a nonempty `summary` takes precedence, and the accessible name keeps both. Pass `unavailable` when summaries can't be made: entries and blocks missing one are marked, and hover shows that text.

## Keys

Native buttons activate with Enter or Space. Arrow keys and J/K move to the neighbor and jump; Home/End reach the boundaries; Left and Right move between an entry and the blocks that hold it; Escape focuses the transcript entry. Without `onJump`, activation scrolls the anchor into view. `onActivate` is an explicit activation of a single entry, which keyboard traversal never fires.

`timelineKey` and `timelineLabel` are pure helpers, and `timelineZoom.ts`' geometry (`timelineLevelCount`, `timelineBlocks`, `timelineWidths` and more) is exported for hosts that lay out their own.

The transcript releases follow mode when a content resize observes an explicit history read before its native scroll event arrives. This prevents mounting older messages from repinning a lens read to the live edge.

Reference images run on an exclusive fresh local database with `E2E_TIMELINE_VISUAL_FIXTURE=fresh`. The journey checks the complete initial message snapshot is empty, waits for its exact seeded entries and completed real summaries, then asserts all 17 rail references. Shared or deployed fixtures report this prerequisite as unavailable.
