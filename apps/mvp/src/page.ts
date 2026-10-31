import { Context, Effect, Layer, Metric } from "effect"
import type { AppReloadReason } from "./reloadReason"

// The page the app runs in, as an action may change it. main.tsx's start gives the window's; a test gives its own.

export class Page extends Context.Service<Page, { readonly reload: (reason: AppReloadReason) => Effect.Effect<void> }>()(
  "@smthrs/mvp/Page",
) {
  /**
   * The page whose `reload` calls `reload` with its reason: in the browser, main.tsx's, which keeps the reason for the
   * next boot (src/reloadReason.ts), then reloads.
   */
  static readonly layer = (reload: (reason: AppReloadReason) => void) =>
    Layer.succeed(Page, Page.of({ reload: (reason) => Effect.sync(() => reload(reason)) }))
}

/** Boots that were reloads, by reason (src/reloadReason.ts), counted by the boot after the reload. */
export const pageReloads = Metric.counter("smithers_web_page_reloads", {
  description: "Boots that were reloads, by reason",
  incremental: true,
})

/**
 * Reloads the page for `reason`, which starts everything over: a page restored from the back/forward cache has lost
 * its device store's connections (`bfcache`), and the pill's Reload starts a stopped engine again (`engine_stopped`).
 * The next boot logs `page reloaded` with the reason and counts it, so the record never races the page unloading.
 */
export const reload = (reason: AppReloadReason) =>
  Effect.flatMap(Page, (page) => page.reload(reason)).pipe(Effect.annotateLogs({ feature: "app" }))
