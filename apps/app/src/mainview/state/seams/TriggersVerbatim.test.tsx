import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { Markdown } from "@smthrs/ui"
import { afterAll, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { verbatim } from "./TriggersSeam"

GlobalRegistrator.register()
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 0)); await GlobalRegistrator.unregister() })

/*
 * The preview a person approves, through the renderer that draws it: the
 * transcript appends the message and TranscriptMessage.tsx hands it to
 * `Markdown` (packages/smithers/ui). That renderer knows one code span — a
 * single backtick around at least one non-backtick byte — so a value wrapped
 * in anything else is drawn as the markup instead of as the bytes (R98 F3),
 * which is the defect D3-N3 was: `0 9 * * 1-5` read `0 9 1-5` on screen.
 */
const rendered = (content: string): string => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() => root.render(<Markdown content={content} />))
  const text = host.textContent ?? ""
  flushSync(() => root.unmount())
  host.remove()
  return text
}

test("a schedule and a capability reach the screen as the bytes they are", () => {
  expect(rendered(`nightly-lint · ${verbatim("0 9 * * 1-5")} UTC`)).toBe("nightly-lint · 0 9 * * 1-5 UTC")
  expect(rendered(verbatim("*"))).toBe("*")
  expect(rendered(verbatim("fs:read:**"))).toBe("fs:read:**")
  expect(rendered(verbatim("*/5 * * * *"))).toBe("*/5 * * * *")
})

/* A value carrying a backtick is the case the grown fence promised and this renderer cannot read. */
test("a backtick inside a value is drawn, not swallowed by the span it would close", () => {
  expect(rendered(verbatim("a`b"))).toBe("a`b")
  expect(rendered(verbatim("`lead"))).toBe("`lead")
  expect(rendered(verbatim("trail`"))).toBe("trail`")
  expect(rendered(verbatim("a``b"))).toBe("a``b")
})
