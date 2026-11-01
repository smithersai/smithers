import { composeSmithersUiStyles } from "@smthrs/ui"
import { readFileSync } from "node:fs"
import { expect, test } from "vitest"
import { BELL_ROUTES, CONVERSATION_ROUTES, floatsBell, surfaceOf } from "./contract"

// The app's placement contract (decision 0137), which the browser's layout-shift regression (e2e/toast-layout-shift.spec.ts)
// proves on screen: every stack is `anchored`, hung under positioned chrome or the home pin, so a notice never takes page
// space. Each page has exactly one owner of the stack: a conversation screen places its own; a repository page's
// header hangs it; every other page gets it from the root, under the floating bell.
test("every stack has one zero-space owner; the home conversation anchors after its pin", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
  const notices = read("./components/Notices.tsx")
  expect(notices).toContain('placement="anchored"')
  expect(notices).not.toContain("inline")
  // The root places the stack only where the bell floats; other pages supply their own anchor.
  expect(read("./components/PageNotices.tsx")).toContain("floatsBell(routeId) ? (")
  expect(read("../repo/components/RepoHeader.tsx")).toContain('{notices ? <Notices surface="page" /> : null}')
  expect(read("../../screens/branch/BranchScreen.tsx")).toContain("<RepoHeader notices={false} />")
  expect(read("../../screens/app/AppShell.tsx")).toContain('<Conversation notices={<Notices surface="conversation" />} />')
  // The anchors are positioned boxes, and the root's has no height to give the page.
  // The flows and repository pages use PageHeader; the home conversation anchors after its pin.
  expect(read("../../screens/flows/FlowsScreen.tsx")).toMatch(/<PageHeader[\s\S]*>\n[\s\S]*?<Notices surface="page" \/>\n\s*<\/PageHeader>/)
  const conversation = read("../chat/components/Conversation.tsx")
  expect(conversation.indexOf('<PinnedMessage')).toBeLessThan(conversation.indexOf('className="mvp-conversation-notices"'))
  expect(conversation.indexOf('className="mvp-conversation-notices"')).toBeLessThan(conversation.indexOf('<ChatTranscript'))
  expect(read("../pins/pins.css")).toContain('.mvp-conversation-notices { position:relative; flex:0 0 auto; height:0; }')
  expect(read("../../screens/root/root.css")).toMatch(/\.root-notices \{ position: fixed;.* height: 0; \}/)
  expect(read("../../screens/branch/branch-screen.css")).toContain(".branch-screen-notices { position: relative; height: 0; }")
  // The repository header's box is @smthrs/ui PageHeader's positioned row, whose children the stack is.
  expect(read("../repo/components/RepoHeader.tsx")).toMatch(/<PageHeader[\s\S]*>\n\s*\{notices \? <Notices surface="page" \/> : null\}\n\s*<\/PageHeader>/)
  expect(composeSmithersUiStyles().split("\n").find((rule) => rule.startsWith(".sui-page-header-inner {"))).toContain("position:relative")
  // Every conversation route's header holds the bell, so the root never places a second stack over one.
  for (const route of CONVERSATION_ROUTES) {
    expect(BELL_ROUTES.has(route)).toBe(true)
    expect(surfaceOf(route)).toBe("conversation")
    expect(floatsBell(route)).toBe(false)
  }
  expect(floatsBell("/app/runs")).toBe(true)
  expect(floatsBell(undefined)).toBe(false)
})
