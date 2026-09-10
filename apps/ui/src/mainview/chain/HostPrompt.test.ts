import { describe, expect, test } from "bun:test"
import { hostPrompt } from "./HostPrompt"

describe("hostPrompt", () => {
  test("the sub-agent section stops at the worldview: its catalog carries no background door", () => {
    const sub = hostPrompt("sub")
    expect(sub).toContain("`recall`")
    expect(sub).toContain("`remember`")
    expect(sub).not.toContain("`background`")
    expect(sub).not.toContain("`say`")
  })

  test("the concierge section adds the background, agent and chat-surface doors on top", () => {
    const concierge = hostPrompt("concierge")
    expect(concierge.startsWith(hostPrompt("sub"))).toBe(true)
    for (const name of ["`agent`", "`background`", "`say`", "`card.show`"]) expect(concierge).toContain(name)
    expect(concierge).toBe(hostPrompt("concierge"))
  })
})
