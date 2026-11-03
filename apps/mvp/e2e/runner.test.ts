import { describe, expect, it, vi } from "vitest"
import { cleanUp, runnerEnv } from "./runner"

describe("a spec's runner", () => {
  it("is retired whichever cleanup step fails: a closed page's drop must not leave it claiming jobs", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const ran: Array<string> = []
    await cleanUp(
      async () => {
        ran.push("drop")
        throw new Error("Target page, context or browser has been closed")
      },
      async () => void ran.push("configure"),
      async () => void ran.push("stop"),
    )
    expect(ran).toEqual(["drop", "configure", "stop"])
    expect(said).toHaveBeenCalledWith(expect.stringContaining("Target page"))
    said.mockRestore()
  })

  it("runs in this machine's environment, without what Playwright gives its workers", () => {
    const env = runnerEnv({ PATH: "/bin", HOME: "/home/me", NODE_OPTIONS: "--import=vibelang/register", NODE_PATH: "/x", PLAYWRIGHT_TEST: "1" })
    expect(env.PATH).toBe("/bin")
    expect(env.HOME).toBe("/home/me")
    expect(env).not.toHaveProperty("NODE_OPTIONS")
    expect(env).not.toHaveProperty("NODE_PATH")
    expect(env).not.toHaveProperty("PLAYWRIGHT_TEST")
  })

  it("off this machine, never hands on the switch that skips TLS checks", () => {
    expect(runnerEnv({ NODE_TLS_REJECT_UNAUTHORIZED: "0" }, "https://smithers.sh").NODE_TLS_REJECT_UNAUTHORIZED).toBe("1")
  })
})
