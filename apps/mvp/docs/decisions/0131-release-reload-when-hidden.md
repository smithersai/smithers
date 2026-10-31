# 0131: A new release reloads a tab only when the tab is hidden

Date: 2026-10-31. Status: accepted. Builds on the PWA's update checks ([sw-update](../work/sw-update.md)): a tab checks
for a new service worker when it becomes visible, gets focus, or the router finishes a navigation. Will reviews it with
the fix (HOST-3).

## Problem

Will, 2026-10-31 14:00: clicking a file in the repository tree opens it, "and then for some unknown reason the entire
page refreshes after a second". One way that happens: the click's navigation checks for a release; a deploy since the
tab opened installs, activates, and `vite-plugin-pwa`'s `onNeedReload` reloaded the tab about a second after the click.
The release test (`e2e/pwa-update.spec.ts`) asserted exactly that. A click must never reload the page.

## Decision

When a new release activates, the open tab keeps running on the old one and reloads into the new one:

- the next time the tab is hidden (`visibilitychange` to `hidden`), or at once if it already is;
- or when it needs a module only the old release had (Vite's `vite:preloadError`): the old page can't go on, so the
  reload then is the least bad choice.

The editors' safety gate is unchanged: the reload still waits for every editor write and unsaved input, and an editor
write that failed parks it with the alert. The update checks are unchanged too. Each reload records its reason,
`pwa_update` or `stale_module`, which the next boot logs ([observability](../observability.md#page-reloads)). The
logic is `applyRelease` in `src/pwa.ts`; `main.tsx` only wires the document and the window to it.

## Alternatives

- **Reload at once (before).** A person mid-click sees the page go blank a second later. Rejected.
- **Turn the next in-app navigation into a full document load.** Still a reload under a click.
- **Apply only on the next full load.** A tab left open for days stays on an old build: it can lead the device store's
  collections with an old schema and stall every newer tab (decision 0021, `src/device/olderLeader.ts`), and its lazy
  modules disappear with the old release.

## Consequences

- A tab that is never hidden runs the old release until it needs a missing module.
- A person returning to a tab may find it freshly loaded: same URL, scroll position reset. Drafts survive, as the gate
  holds the reload until they are saved.
- If an unsaved draft holds the reload while hidden and is saved after the person returns, the reload happens then.
