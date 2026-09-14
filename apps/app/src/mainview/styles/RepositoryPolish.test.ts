import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

GlobalRegistrator.register()
afterEach(() => { document.head.innerHTML = ""; document.body.innerHTML = ""; document.documentElement.removeAttribute("data-theme") })
afterAll(() => GlobalRegistrator.unregister())
const style = (path: string) => {
  const sheet = document.createElement("style")
  sheet.textContent = readFileSync(new URL(path, import.meta.url), "utf8")
  document.head.append(sheet)
}

for (const [theme, accent] of [["light", "#3a756b"], ["dark", "#9bd5c6"]]) {
  test(`chrome sign-in inherits the ${theme} action color without a guide shell`, () => {
    style("./tokens.css")
    style("./base.css")
    style("./chrome.css")
    document.documentElement.dataset.theme = theme
    document.body.innerHTML = '<div class="session-shell"><button class="chrome-action" data-flow="auth.sign-in">Sign in with GitHub</button></div>'
    expect(getComputedStyle(document.querySelector("button")!).color).toBe(accent)
  })
}

test("workspace preparation is neutral while failed launches remain danger-colored and separate lines", () => {
  style("../onboarding/guide.css")
  document.body.innerHTML = '<div class="guide-shell" data-stage="12" style="--g-muted-strong:#667777;--danger:#ff0000"><div class="guide-notice"><p>Preparing your workspace…</p></div></div>'
  const notice = document.querySelector(".guide-notice")!
  expect(getComputedStyle(notice).color).toBe("#667777")
  notice.innerHTML = "<p>Wiki couldn't start.\nMythical history couldn't start.</p><details><summary>Technical details</summary>Failed</details>"
  expect(getComputedStyle(notice).color).toBe("#ff0000")
  expect(getComputedStyle(notice).whiteSpace).toBe("pre-line")
})
