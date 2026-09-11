import { expect, test } from "bun:test"
import { createReelController } from "./reelController"
import { initialGuide, type GuideState } from "../state/AppState"
import type { ControllerContext } from "../state/controller/context"
import { REEL_STAGES, type ReelState } from "./reel.ts"

const setup = () => {
  const session: { theme: "light" | "dark"; guide: GuideState & ReelState } = { theme: "light", guide: { ...initialGuide(), step: 9 } }
  const events: Record<string, unknown>[] = []
  let wait = () => {}, dispose = () => {}
  const ctx = { store: { session: () => session, dispatch: (event: Record<string, unknown>) => {
    events.push(event)
    if (event.type === "guide.changed") session.guide = event.guide as GuideState & ReelState
    if (event.type === "theme.changed") session.theme = event.theme as "light" | "dark"
    return { isPersisted: { promise: Promise.resolve() } }
  } }, onDispose: (fn: () => void) => { dispose = fn } } as unknown as ControllerContext
  const act = createReelController(ctx, { setTimeout: fn => { wait = fn; return 1 }, clearTimeout: () => { wait = () => {} } })
  return { session, events, act, tick: () => wait(), dispose: () => dispose() }
}
test("all agent demos persist through guide.changed; real theme, notification, composer and wait transitions", async () => {
  const h = setup()
  await h.act("reel-start", "")
  expect(h.session.guide.reelSeen).toBe(true)
  for (const [index, card] of REEL_STAGES.entries()) {
    await h.act("reel-demo", card.demo)
    expect(h.session.guide.reelDemo).toBe(card.demo)
    if (card.demo === "theme") expect(h.session.theme).toBe("dark")
    if (card.demo === "notify") expect(h.events.some(e => e.type === "toast.resolved" && e.title === "You can keep working")).toBe(true)
    if (card.demo === "composer") expect(h.session.guide.conversationOpen).toBe(true)
    if (card.demo === "wait") {
      expect(h.session.guide.demoRun?.status).toBe("running")
      h.tick(); expect(h.session.guide.demoRun?.status).toBe("succeeded")
      expect(h.events.some(e => e.title === "Done")).toBe(true)
    }
    await h.act("reel-next", `1:${index}`)
    expect(h.session.theme).toBe("light")
    expect(h.session.guide.conversationOpen).toBe(false)
  }
  expect(h.session.guide.reelIndex).toBeUndefined()
  expect(h.session.guide.step).toBe(9)
  expect(h.events.filter(e => e.type === "guide.changed").every(e => e.actor === "smithers")).toBe(true)
  h.dispose()
})
test("exit restores the theme, preserves profile, and stale tokens cannot affect a replay", async () => {
  const h = setup(); h.session.guide.heard = "A friend"
  await h.act("reel-start", ""); await h.act("reel-demo", "theme")
  await h.act("reel-exit", "")
  expect(h.session.theme).toBe("light")
  await h.act("reel-start", ""); await h.act("reel-next", "1:0")
  expect(h.session.guide.reelIndex).toBe(0)
  expect(h.session.guide.heard).toBe("A friend")
  h.dispose()
})
test("serialized instant advance cannot overwrite a pending theme restore", async () => {
  const h = setup()
  await h.act("reel-start", "")
  await Promise.all([h.act("reel-demo", "theme"), h.act("reel-next", "1:0"), h.act("reel-exit", "")])
  expect(h.session.theme).toBe("light")
  expect(h.session.guide.reelIndex).toBeUndefined()
  h.dispose()
})
