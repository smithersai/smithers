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

for (const [theme, accent] of [["light", "#994cc3"], ["dark", "#c792ea"]]) {
  test(`chrome sign-in inherits the ${theme} brand color shared with card sign-in without a guide shell`, () => {
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


test("home links stay underlined even with the host page anchor reset", () => {
  style("./cards.css")
  const reset = document.createElement("style")
  reset.textContent = "a { color: inherit; text-decoration: none; }"
  document.head.append(reset)
  document.body.innerHTML = '<div style="--brand:#994cc3"><a class="repo-home-link" href="/docs/">Read more</a></div>'
  expect(getComputedStyle(document.querySelector("a")!).textDecorationLine).toBe("underline")
  expect(getComputedStyle(document.querySelector("a")!).color).toBe("#994cc3")
})

test("account sections share a stable label column without changing other tables", () => {
  style("./cards.css")
  document.body.innerHTML = '<section class="smithers-card" data-kind="account"><table class="secrets-table"><tbody><tr><th>read:user</th><td>See your GitHub profile.</td></tr></tbody></table></section>'
  expect(getComputedStyle(document.querySelector("table")!).tableLayout).toBe("fixed")
  expect(getComputedStyle(document.querySelector("th")!).width).toBe("35%")
})

test("message copy control stays 22px when the shared kit loads last", () => {
  style("./cards.css")
  const kit = document.createElement("style")
  kit.textContent = ".sui-button-icon-size { min-height: 36px; width: 32px; padding: 0; }"
  document.head.append(kit)
  document.body.innerHTML = '<span class="message-actions"><button class="message-action sui-button-icon-size">Copy</button></span>'
  const button = getComputedStyle(document.querySelector("button")!)
  expect(button.minHeight).toBe("22px")
  expect(button.width).toBe("22px")
})

test("tutorial chat text starts at the reading edge and an unknown repo starts at the top", () => {
  style("./chat.css")
  document.body.innerHTML = '<div style="text-align:center"><div class="guide-transcript"><article class="smithers-chat-message">Answer</article></div></div><div class="app-shell"><div class="smithers-transcript" data-repository-missing><div class="sui-chat-messages"><article>Missing</article></div></div></div>'
  expect(getComputedStyle(document.querySelector(".smithers-chat-message")!).textAlign).toBe("start")
  expect(getComputedStyle(document.querySelector(".sui-chat-messages > article")!).marginTop).toBe("0px")
})

test("help uses an opaque surface even when the guide panel is translucent", () => {
  style("../HelpBubble.css")
  document.body.innerHTML = '<div style="--g-bg:#f7f6f1;--g-panel:rgba(255,255,252,0.73)"><div class="help-bubble">Help</div></div>'
  expect(getComputedStyle(document.querySelector(".help-bubble")!).backgroundColor).toBe("#f7f6f1")
})

test("capacity messages use the waiting tone and run receipts can shrink before footer controls", () => {
  style("./cards.css")
  style("../onboarding/guide.css")
  document.body.innerHTML = '<div style="--warning:#826601"><p class="live-tutorial-limit">Paused</p></div><footer class="guide-footer"><span class="guide-run-chips"><span class="guide-run-chip">Wiki started on a long repository</span></span><div class="guide-chat-controls"><button>Chat</button></div></footer>'
  expect(getComputedStyle(document.querySelector("p")!).color).toBe("#826601")
  expect(parseFloat(getComputedStyle(document.querySelector(".guide-run-chips")!).minWidth)).toBe(0)
  expect(getComputedStyle(document.querySelector(".guide-run-chip")!).textOverflow).toBe("ellipsis")
  expect(getComputedStyle(document.querySelector(".guide-chat-controls")!).flexShrink).toBe("0")
})
