import { errors, expect, type Page, type TestInfo } from "@playwright/test"
import { writeFile } from "node:fs/promises"
import { captureState, paintAt, removeMobileStyles, restoreMobileStyles, scrollTo } from "./baseline-dom"

// Mobile additions relative to main a7b2bd8c. Removing these rules keeps the
// approved desktop defect repairs and compares them on the same live DOM.
// Paired screenshots avoid random TODO ids, timestamps and synced data changing
// between two server runs. Both PNGs are retained; no content is masked.
// This guards against widening these indexed mobile rules to desktop. It is
// not a historical golden comparison of the approved desktop repairs.
const addedRules = [
  ".sui-file-tab > button { width:32px; height:var(--ctl-h, 32px); }",
  ".sui-file-tree-file, .sui-file-tree-dir-toggle { min-height:var(--ctl-h, 32px); }",
  ".sui-repo-segment { min-width:32px; min-height:var(--ctl-h, 32px); }",
  ".sui-item-aside-link { display:inline-flex; align-items:center; min-width:32px; min-height:var(--ctl-h, 32px); max-width:100%; }",
  ".sui-item-conv-external { display:inline-flex; align-items:center; min-width:32px; min-height:var(--ctl-h, 32px); }",
  ".sui-chat-transcript:has(> .sui-timeline-disclosure[open]) { z-index:41; }",
  ".app-shell-header { flex-wrap: wrap; }",
  ".app-shell-header [aria-label=\"Account\"] { min-width: 0; flex-wrap: wrap; }",
  ".app-shell-nav { flex-wrap: wrap; }",
  ".app-shell-nav > a { display: inline-flex; align-items: center; min-width: 32px; min-height: 32px; }",
  ".branch-header-views > a { display: inline-flex; align-items: center; min-width: 32px; min-height: 32px; }",
  ".branch-header-presence { flex-wrap: wrap; min-width: 0; }",
  ".terminal-panel-tabs > a { display: inline-flex; align-items: center; min-width: 32px; min-height: 32px; }",
  ".conversations-screen-header > a { display: inline-flex; align-items: center; min-width: 32px; min-height: 32px; }",
  ".conversation-list-row > a { min-height: 32px; flex-wrap: wrap; }",
  ".docs-page-links a { display:flex; align-items:center; min-width:32px; min-height:32px; }",
  ".flows-screen-header > a { display:inline-flex; align-items:center; min-height:32px; min-width:32px; }",
  ".flows-page td a { display:inline-flex; align-items:center; min-height:32px; min-width:32px; max-width:100%; overflow-wrap:anywhere; }",
  ".issues-screen > .sui-button { align-self: flex-start; }",
  ".issues-screen > p > a { display: inline-flex; align-items: center; min-height: 32px; }",
  ".pulls-screen > .sui-button { align-self: flex-start; }",
  ".stack-screen > .sui-button { align-self: flex-start; }",
  ".conversation-view-full-screen { display: inline-flex; align-items: center; min-height: 32px; }",
  ".sui-rh-announce { height:auto; min-height:var(--ctl-h, 32px); }",
  ".sui-rh-more, .sui-rh-release-name, .sui-rh-panel-link { display:inline-flex; align-items:center; min-height:var(--ctl-h, 32px); min-width:32px; }",
  ".plugin-screen-header > a { display:inline-flex; align-items:center; min-height:32px; min-width:32px; }",
  ".repo-header-name a { display: inline-flex; align-items: center; min-height: 32px; }",
  ".runs-screen-header > a { display:inline-flex; align-items:center; min-height:32px; min-width:32px; }",
  ".runs-screen table[aria-label=\"Flows\"] td > a { display:inline-flex; align-items:center; min-height:32px; min-width:32px; }",
  ".secrets-screen-header > a { display: inline-flex; align-items: center; min-width: 32px; min-height: 32px; }",
  ".settings-screen-header > a { display:inline-flex; align-items:center; min-height:32px; min-width:32px; }",
  ".sui-markdown-editor[data-readonly] .ProseMirror a { display:inline-block; min-width:32px; min-height:32px; line-height:32px; max-width:100%; overflow-wrap:anywhere; }",
  ".sui-repo-readme-name { display:inline-flex; align-items:center; min-height:var(--ctl-h, 32px); }",
  ".sui-action-menu-trigger { width:32px; min-height:var(--ctl-h, 32px); height:var(--ctl-h, 32px); }",
  "button.sui-toast-open { min-height:var(--ctl-h, 32px); }",
  ".sui-toast-text, .sui-notification-text { white-space:normal; overflow-wrap:anywhere; }",
  ".sui-notification-bell { flex-shrink:0; }",
  ".sui-notification-count { position:static; flex:none; }",
  ".sui-notification-bell:has(.sui-notification-count) { width:auto; padding-inline:8px; }",
  ".sui-timeline-disclosure>summary {min-width:32px;min-height:var(--ctl-h, 32px);box-sizing:border-box;display:flex;align-items:center}",
  ".sui-segmented { min-height:calc(var(--ctl-h, 32px) + 2px); }",
  ".sui-segmented-item { min-height:var(--ctl-h, 32px); min-width:32px; }",
  ".sui-flow-draft-file-path { min-height:var(--ctl-h, 32px); box-sizing:border-box; }",
  ".sui-flow-graph-tools { position:static; width:max-content; max-width:100%; margin:8px; }",
  ".sui-journal-scrubber input { min-height:var(--ctl-h, 32px); }",
  ".sui-issues-filter { min-height:var(--ctl-h, 32px); min-width:32px; }",
  ".sui-issues-link, .sui-issues-meta-link { display:inline-flex; align-items:center; min-height:var(--ctl-h, 32px); min-width:32px; }",
  ".sui-json-value-summary { min-height:var(--ctl-h, 32px); box-sizing:border-box; }",
  ".sui-breadcrumbs-link { display:inline-flex; align-items:center; min-height:var(--ctl-h, 32px); min-width:32px; }",
  ".sui-repo-about-people a { display:flex; align-items:center; justify-content:center; min-width:32px; min-height:var(--ctl-h, 32px); }",
  ".sui-run-list-flow a { display:inline-flex; align-items:center; min-height:var(--ctl-h, 32px); min-width:32px; }",
  "button.sui-waterfall-track { min-height:var(--ctl-h, 32px); }",
  "button.sui-avatar { min-width:32px; min-height:var(--ctl-h, 32px); }",
  ".sui-avatar-stack { flex-wrap:wrap; gap:4px; }",
  ".sui-avatar-stack > li + li { margin-left:0; }",
  ".sui-button { min-width:32px; min-height:var(--ctl-h, 32px); white-space:normal; }",
  ".sui-chat-composer-input { min-height:var(--ctl-h, 32px); }",
  ".sui-md-link { display:inline-block; min-width:32px; min-height:var(--ctl-h, 32px); line-height:var(--ctl-h, 32px); max-width:100%; overflow-wrap:anywhere; }",
  ".sui-codeblock-action { min-height:var(--ctl-h, 32px); min-width:32px; }"
]

/** Chromium's huge raster is split; WebKit retains the existing full-document capture. */
export const captureHeight = (browserName: string, height: number) => browserName === "chromium" ? 8192 : height

export class CaptureDeadline extends Error {
  constructor() { super("desktop comparison deadline expired") }
}

/** Keep the actual mismatch when a later attempt has no capture budget left. */
export const comparisonFailure = (error: unknown, previous: unknown) => (error instanceof CaptureDeadline || error instanceof errors.TimeoutError) && previous !== undefined ? previous : error

/** A past stable-window deadline refuses further capture work. */
export const captureTimeout = (deadline?: number) => {
  if (deadline === undefined) return undefined
  const timeout = deadline - performance.now()
  if (timeout <= 0) throw new CaptureDeadline()
  return timeout
}

export const desktopBaseline = async (page: Page, info: TestInfo, name: string, snapshotReady = false) => {
  // Only applied Issues snapshots establish readiness before this comparison.
  // Other pages retain their bounded stable-window retry while late content settles.
  const compare = async (deadline?: number) => {
    const remaining = () => captureTimeout(deadline)
    remaining()
    const started = performance.now()
    const settle = async (origin: { x: number; y: number }) => {
      const ready = await page.waitForFunction(paintAt, origin, { timeout: remaining() ?? 0 })
      await ready.dispose()
    }
    const content = await page.locator("body").innerText()
    const { document: dimensions, scroll: origin } = await page.evaluate(captureState)
    const tileHeight = captureHeight(page.context().browser()!.browserType().name(), dimensions.height)
    const tiles: Array<{ x: number; y: number; width: number; height: number }> = []
    for (let y = 0; y < dimensions.height; y += tileHeight) {
      tiles.push({ x: 0, y, width: dimensions.width, height: Math.min(tileHeight, dimensions.height - y) })
    }
    // Chromium omitted raster patches in a 1280×254435 full-document PNG
    // while the affected rows' DOM, geometry and styles stayed identical. Capture
    // bounded Chromium clips instead; WebKit keeps its full-document comparison.
    // Keep the original scroll for both passes: scrolling each clip would repeat
    // fixed/sticky overlays and hide document pixels under them at clip boundaries.
    // Every captured region retains its document bounds.
    let capturedCurrent = 0
    let capturedBaseline = 0
    let compared = 0
    const receipt = () => writeFile(info.outputPath(`${name}-tiles.json`), JSON.stringify({
      ...dimensions, tiles, capturedCurrent, capturedBaseline, compared, durationMs: performance.now() - started,
    }, null, 2))
    await receipt()
    const capture = async (tile: typeof tiles[number], baseline: boolean) => {
      remaining()
      expect((await page.evaluate(captureState)).document, "document dimensions must remain stable across the CSS comparison").toEqual(dimensions)
      const file = tiles.length === 1 ? name : `${name}-${tile.x}-${tile.y}`
      const png = await page.screenshot({ path: info.outputPath(`${file}${baseline ? "-baseline" : ""}.png`), fullPage: true, clip: tile, animations: "disabled", timeout: remaining() })
      expect({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) }, "the PNG covers its entire document tile").toEqual({ width: tile.width, height: tile.height })
      if (baseline) capturedBaseline++
      else capturedCurrent++
      return png
    }
    try {
      await settle(origin)
      const current: Buffer[] = []
      for (const tile of tiles) current.push(await capture(tile, false))
      remaining()
      const removed = await page.evaluate(removeMobileStyles, [...addedRules])
      try {
        expect(removed, "baseline must remove the sweep's actual CSS rules").toBeGreaterThan(0)
        await settle(origin)
        for (const [index, tile] of tiles.entries()) {
          const baseline = await capture(tile, true)
          expect(current[index]!.equals(baseline), `mobile CSS must not change any desktop pixels, including repaired pages (tile ${tile.x},${tile.y})`).toBe(true)
          compared++
        }
      } finally {
        await page.evaluate(restoreMobileStyles)
      }
      expect((await page.evaluate(captureState)).document, "document dimensions must remain stable across the CSS comparison").toEqual(dimensions)
      expect(await page.locator("body").innerText(), "content must remain stable across the CSS comparison").toBe(content)
    } finally {
      await page.evaluate(scrollTo, origin)
      await receipt()
    }
  }
  if (snapshotReady) await compare()
  else {
    const deadline = performance.now() + 10_000
    let active: Promise<void> = Promise.resolve()
    let failure: unknown
    try {
      await expect(() => {
        active = compare(deadline).catch(error => {
          failure = comparisonFailure(error, failure)
          throw failure
        })
        return active
      }).toPass({ timeout: 10_000 })
    } finally {
      // toPass races its deadline without cancelling the callback. Wait for the
      // bounded operation and restoration so no capture can mutate after return.
      await active.catch(() => {})
    }
  }
}
