import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { Reel } from "./Reel.tsx"
import { REEL_STAGES } from "./reel.ts"

test("Reel is a standalone projection with a keyboard exit and real profile fields", () => {
  const index = REEL_STAGES.findIndex(stage => stage.demo === "profile")
  const html = renderToStaticMarkup(<Reel index={index} demo="profile" dispatch={() => {}} />)
  expect(html).toContain('data-reel-stage="3"')
  expect(html).toContain('aria-label="Optional profile example"')
  expect(html).toContain('<input')
  expect(html).toContain('<textarea')
  expect(html).toContain('Back ')
  expect(html).toContain('tabindex="-1"')
})

test("examples have explicit Next and the last example has Finish, including reduced motion", () => {
  expect(renderToStaticMarkup(<Reel index={0} dispatch={() => {}} reducedMotion />)).toContain('Next ')
  const last = renderToStaticMarkup(<Reel index={REEL_STAGES.length - 1} dispatch={() => {}} />)
  expect(last).toContain('Finish ')
  expect(last).toContain('aria-keyshortcuts="ArrowRight"')
})
