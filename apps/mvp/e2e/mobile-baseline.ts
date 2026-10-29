import { expect, type Page, type TestInfo } from "@playwright/test"

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

export const desktopBaseline = async (page: Page, info: TestInfo, name: string, snapshotReady = false) => {
  // Only applied Issues snapshots establish readiness before this comparison.
  // Other pages retain their bounded stable-window retry while late content settles.
  const compare = async () => {
    const content = await page.locator("body").innerText()
    const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }))
    const current = await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true, animations: "disabled" })
    expect({ width: current.readUInt32BE(16), height: current.readUInt32BE(20) }, "the PNG covers the entire document").toEqual(dimensions)
    const removed = await page.evaluate((rules) => {
      const key = (rule: CSSStyleRule) => rule.cssText
      const added = new Set(rules.map((css) => {
        const sheet = new CSSStyleSheet()
        sheet.replaceSync(css)
        return key(sheet.cssRules[0] as CSSStyleRule)
      }))
      const undo: Array<() => void> = []
      const visit = (parent: CSSStyleSheet | CSSGroupingRule) => {
        for (let i = parent.cssRules.length - 1; i >= 0; i--) {
          const rule = parent.cssRules[i]!
          if (rule instanceof CSSStyleRule && added.has(key(rule))) {
            const css = rule.cssText
            parent.deleteRule(i)
            undo.unshift(() => parent.insertRule(css, i))
          } else if (rule instanceof CSSGroupingRule) {
            visit(rule)
          }
        }
      }
      for (const sheet of document.styleSheets) visit(sheet)
      ;(window as unknown as { restoreMobileStyles: () => void }).restoreMobileStyles = () => undo.forEach((restore) => restore())
      return undo.length
    }, [...addedRules])
    try {
      expect(removed, "baseline must remove the sweep's actual CSS rules").toBeGreaterThan(0)
      const baseline = await page.screenshot({ path: info.outputPath(`${name}-baseline.png`), fullPage: true, animations: "disabled" })
      expect({ width: baseline.readUInt32BE(16), height: baseline.readUInt32BE(20) }, "the baseline PNG covers the entire document").toEqual(dimensions)
      expect(current.equals(baseline), "mobile CSS must not change any desktop pixels, including repaired pages").toBe(true)
    } finally {
      await page.evaluate(() => (window as unknown as { restoreMobileStyles: () => void }).restoreMobileStyles())
    }
    expect(await page.locator("body").innerText(), "content must remain stable across the CSS comparison").toBe(content)
  }
  if (snapshotReady) await compare()
  else await expect(compare).toPass({ timeout: 10_000 })
}
