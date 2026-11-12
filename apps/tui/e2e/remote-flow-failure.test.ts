/** Eventual PTY checks over the real control host; native-frame timing is tested separately. */
import { expect, it } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { bunCommand, drawn, key, Tui } from "./tmux.ts"

const app = resolve(import.meta.dir, "..")
it("remote causes stay safe on terminal cards, with Enter details and retry intact", async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-remote-failure-pty-"))
  const project = join(root, "project")
  mkdirSync(project)
  cpSync(join(app, "test/fixtures/remote-failure-project/.smithers/flows"), join(project, ".smithers", "flows"), {
    recursive: true
  })
  symlinkSync(join(app, "node_modules"), join(project, "node_modules"), "dir")
  let tui: Tui | undefined
  const evidence: Record<string, string> = {}
  const cards = (screen: string) => screen.split("\n").filter((line) => /^\s*✗ failure ·/.test(line))
  try {
    tui = await Tui.start({
      cwd: project,
      command: `${bunCommand} ${join(app, "e2e/real-flows-fixture.tsx")}`,
      env: { PATH: process.env.PATH ?? "", SMITHERS_TUI_SESSION_DIR: join(root, "sessions") }
    })
    await tui.until(drawn, 20_000, "first draw")
    await tui.type("/flow failure {\"error\":\"private-fixture\",\"unencodable\":true}")
    await tui.press(key.enter)
    evidence.encoded = await tui.until(
      (screen) => cards(screen).some((card) => card.includes("failed: Flow result could not be encoded.")),
      15_000,
      "encoded failure cause"
    )
    expect(cards(evidence.encoded)).toHaveLength(1)
    expect(cards(evidence.encoded)[0]).not.toMatch(/private|UnencodableResult|Error:|stack/)
    await tui.press(key.tab)
    await tui.press(key.enter)
    evidence.details = await tui.until((screen) => screen.includes("UnencodableResult"), 5_000, "Enter opens details")
    expect(evidence.details).toContain("Resume")
    await tui.type("r")
    await tui.until((screen) => !screen.includes("UnencodableResult"), 5_000, "retry clears old detail")
    await tui.until((screen) => screen.includes("UnencodableResult"), 15_000, "retry actually fails again")
    await tui.press(key.escape) // Existing Chat action from the flow view.
    await tui.type("Chat still works")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Still here."), 5_000, "Chat after retry")
    for (
      const [error, copy] of [
        [{
          _tag: "flows/model/ModelError",
          code: "transport",
          message: "private-fixture https://fixture.invalid token=fixture"
        }, "Model connection failed"],
        [{ message: "Check exited 255" }, "Check exited 255."],
        [{ message: "Command exited 256: private-fixture" }, "The flow failed."]
      ] as const
    ) {
      await tui.type(`/flow failure ${JSON.stringify({ error })}`)
      await tui.press(key.enter)
      const screen = await tui.until(
        (screen) => cards(screen).at(-1)?.includes(`failed: ${copy}`) === true,
        15_000,
        copy
      )
      const card = cards(screen).at(-1)!
      expect(card).not.toMatch(/private|https|token|stack|UnencodableResult|\u001b/)
      evidence[copy] = screen
    }
  } finally {
    if (process.env.SMITHERS_3674_PTY_EVIDENCE) {
      writeFileSync(
        process.env.SMITHERS_3674_PTY_EVIDENCE,
        JSON.stringify({ ...evidence, final: tui?.screen() }, null, 2)
      )
    }
    await tui?.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
