# 0137: Toasts overlay the page under its header

Date: 2026-10-31. Status: accepted. Ruling [FE-21](../rulings.md#5-frontend): Will, 2026-10-31 about 14:20, on
smithers.sh: "when we get notifications it pushes the rest of the content on teh page down which is janky". Changes
[0036](0036-toasts-reserve-page-space.md) (page notices reserved space) and the `inline` placement [0015](0015-agent-status.md)
chose; keeps [0009](0009-notifications-and-live-work.md) §4's stack. Will reviews it with the feature (HOST-3).

## Problem

The stack sat in the page's flow: `ToastStack`'s `inline` placement, under `/app`'s header, in a row of the branch
page's grid, and in a strip above every other page's screen. Each toast that arrived took its height from the page, so
the conversation, the composer and the page's content jumped down, and jumped back when it left.

## Decision

1. **Every stack is an overlay.** `@smthrs/ui` `ToastStack` gains `placement="anchored"`: `position:absolute`, hung
   under its positioned parent at the parent's end edge, with no height in the flow. `inline` is deleted; `fixed`
   stays for hosts without a header to hang from.
2. **Under the header, at its end.** 0015's reason stands: the open composer docks over the column's foot, so the
   window's foot would hide a toast. The stack hangs under the header, at its end edge, under the bell the notices
   belong to, at most 380px wide (full width on a phone). It overlays the top of the conversation or the page, the
   part least in use: the newest messages and the composer are at the foot, and the header's controls stay clear.
3. **One component, one owner per page.** `Notices` (`src/features/attention/components/Notices.tsx`) is the stack;
   `src/screens/app/Toasts.tsx`, a copy of it with the placement fixed, is gone. The owner is the page's header box:
   `/app`'s header, the flows page's and `RepoHeader`, all `@smthrs/ui` `PageHeader`, whose children hang under its
   positioned row at the bell's end; the branch page's chrome, in a zero-height box across the top of its body; and, where the bell
   floats, a fixed zero-height box under it
   (`PageNotices`, which now renders only there). A repository page's header no longer shares the page with the
   root's stack, so a blob page shows one stack, not two.
4. **Motion is opacity and transform only.** A toast fades and slides in over 120 ms; a `delayed` toast first waits
   its 300 ms, named in `--motion-hold` so the wait holds under reduced motion as the other holds do. A toast leaves
   at once: a leave animation would keep a gone row on screen, against the 300 ms no-flash rule, the three-card cap
   and focus hand-off, and the overlay already removes the jump.
5. **Kept:** stacking, the three-card cap, `+N`, Hide on every row, Alt+T and the roving keys, the live region.

```
 header ─────────────────────────────── 🔔 ─┐        header ─────────────────────────────── 🔔 ─┐
 ┌ toast (took a row) ──────────────────────┐   ─▶                     ┌ toast (hangs under) ──┐
 │ conversation (pushed down)               │        │ conversation    │ ◆ Needs you  [Answer] ×│
 ...                                                 ...               └───────────────────────┘
 [ composer ]                                        [ composer ]        (nothing below moved)
```

## Proof

`apps/mvp/e2e/toast-layout-shift.spec.ts`: on `/app` and a branch page, at 1280px and 390px, a run in a conversation
the person isn't looking at (their own in a branch they track; a teammate's on `main`, which they follow) reports
through the real runs route; the toast arrives and Hide removes it while the headers, the conversation, the composer
and the view keep their boxes, the stack hangs under the header, and `PerformanceObserver`'s `layout-shift` entries
name nothing outside the conversation's messages and the header's status. It failed on the inline stack.
`@smthrs/ui` `tests/agent-status.test.tsx` pins the sheet; `src/features/attention/page-notices.test.ts` the owners.

## Pinned-message clearance (2026-10-31)

The header anchor let **Add your model** cover the home conversation's pin controls
at laptop and phone widths. On `/app`, pass the existing `Notices` into
`Conversation` and anchor it in a zero-height box immediately after the pinned
message, before the transcript. The stack follows the pin's real height, including
collapse and expand, rather than estimating an offset or reserving notice space.
Without a pin it stays at the conversation's top under the header. It aligns with
the conversation's end and overlays its messages; the header, pin and composer
keep their controls. Other pages retain their existing header anchors.

This is core page layout using the catalog's `@smthrs/ui` ToastStack/Toast, with
no new plugin behavior. The three-card cap, overflow, Hide, keyboard shortcuts,
live region and reduced-motion behavior stay in that shared component.

`e2e/toast-pin-clearance.spec.ts` uses the real API and a model-off session at
1190×785, 1440×900 and 390×844. It checks `elementFromPoint` at both pin buttons,
clicks collapse, expand and unpin, checks the complete toast and its controls,
and uses Alt+T/H to Hide without changing the pin, conversation or composer
bounds. The phone uses reduced motion. `e2e/model-toast.spec.ts` covers Settings
and model resolution; `e2e/toast-layout-shift.spec.ts` keeps the no-pin overlay
and branch layout-shift checks.

## Page-action clearance (2026-10-31)

A toast never covers a page's primary action or any control in the header rows
it hangs under. This includes the second row of a repository page: the stack's
New TODO, list filters and tabs, not only RepoHeader. The existing after-pin
anchor remains the preferred start on the home conversation.

The catalog's @smthrs/ui ToastStack accepts an `avoid` selector for page chrome
and primary actions. It uses their actual visible bounds, including wrapped
phone rows and controls added by plugins. Starting at its existing anchor, it
uses the first free gap that fits; if the viewport is crowded, the largest free
gap scrolls the overlay. Resize, relevant DOM changes and scrolling remeasure clearance once per frame.
Conversation-message controls are content, not page chrome: they never move the
after-pin anchor as the transcript scrolls. The stack keeps its shadow and
entrance slide unclipped unless it needs internal scrolling; its narrow scroll
region accepts pointer and keyboard scrolling. An anchor outside the viewport
falls back to visible free space. Alt+T never focuses a zero-room stack.
Only the absolute overlay moves: no page space is reserved. The shared cap,
+N, Hide, focus keys, live region and reduced motion remain unchanged.

The real-browser regression `e2e/toast-action-clearance.spec.ts` opens New TODO
with Add your model still showing and checks every visible header button/link
and primary action for both rectangle intersection and center pointer delivery
on the main pages at 1190x785, 1440x900 and 390x844. The modelNotice hiding
workaround is removed; dedicated Hide behavior tests remain.
