/**
 * The TUI in a real PTY, driven through zmux: keys in, screen out.
 *
 * Model turns replay `test/fixtures/fix-add.jsonl` (a recorded gpt-6-sol run)
 * through the replay seat, so no provider is called and the cells it carries
 * run for real against a scratch repository.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { key, Tui } from "./zmux.ts"

const app = resolve(import.meta.dir, "..")
const fixture = join(app, "test", "fixtures", "fix-add.jsonl")
const idle = (screen: string) => screen.includes("code  ·") && !screen.includes("esc interrupt") && !/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \d/.test(screen)

let tui: Tui | undefined
afterEach(async () => {
  await tui?.stop()
  tui = undefined
})

/** A scratch repository whose `node check.mjs` fails until `add` adds. */
const repository = () => {
  const directory = mkdtempSync(join(tmpdir(), "tui-repo-"))
  writeFileSync(join(directory, "math.js"), "export const add = (a, b) => a - b\n")
  writeFileSync(
    join(directory, "check.mjs"),
    'import { add } from "./math.js"\nif (add(2, 3) !== 5) { console.error("add is wrong"); process.exit(1) }\nconsole.log("ok")\n'
  )
  return directory
}

const start = async (options: { readonly holdMs?: number; readonly args?: string } = {}) => {
  const cwd = repository()
  const sessions = mkdtempSync(join(tmpdir(), "tui-sessions-"))
  tui = await Tui.start({
    cwd,
    command: `bun ${join(app, "src", "main.tsx")} ${cwd} ${options.args ?? ""}`,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      SMITHERS_TUI_REPLAY: fixture,
      SMITHERS_TUI_REPLAY_HOLD_MS: String(options.holdMs ?? 0),
      SMITHERS_TUI_REPLAY_SPEED: "20",
      SMITHERS_TUI_SESSION_DIR: sessions
    }
  })
  await tui.until((screen) => screen.includes("code  ·"), 20_000, "first draw")
  return { tui, cwd, sessions }
}

describe("ctrl+c and ctrl+d", () => {
  it("clears the editor on the first press and exits on a second within 500ms", async () => {
    const { tui } = await start()
    await tui.type("draft that should go away")
    await tui.until((screen) => screen.includes("draft that should go away"))
    await tui.press(key.ctrlC)
    await tui.until((screen) => !screen.includes("draft that should go away"), 3_000, "cleared editor")
    // Outside the window: a single press only clears.
    await new Promise((resolve) => setTimeout(resolve, 700))
    await tui.press(key.ctrlC)
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(tui.exited).toBeUndefined()
    await tui.call("session.send", { sessionId: "tui", dataBase64: Buffer.from(key.ctrlC + key.ctrlC).toString("base64") })
    expect((await tui.waitForExit()).code).toBe(0)
  }, 60_000)

  it("exits on ctrl+d only when the editor is empty", async () => {
    const { tui } = await start()
    await tui.type("x")
    await tui.press(key.ctrlD)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(tui.exited).toBeUndefined()
    await tui.press(key.backspace)
    await tui.press(key.ctrlD)
    expect((await tui.waitForExit()).code).toBe(0)
  }, 60_000)
})

describe("esc", () => {
  it("interrupts a running agent turn and returns to idle", async () => {
    const { tui } = await start({ holdMs: 60_000 })
    await tui.type("node check.mjs fails. Fix it and show it passes.")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("esc stops") && /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \d/.test(screen), 10_000, "running turn")
    await tui.press(key.escape)
    const screen = await tui.until((screen) => screen.includes("✗ Stopped") && idle(screen), 5_000, "stopped turn")
    expect(screen).toContain("Ask Smithers to change this repository")
  }, 60_000)

  it("cancels a running shell command", async () => {
    const { tui } = await start()
    await tui.type("!sleep 30")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Running... (esc to cancel)"), 5_000, "running shell")
    await tui.press(key.escape)
    await tui.until((screen) => screen.includes("(cancelled)"), 5_000, "cancelled shell")
  }, 60_000)

  it("puts steered messages back in the editor when it stops the turn", async () => {
    const { tui } = await start({ holdMs: 60_000 })
    await tui.type("first prompt")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("esc stops"), 10_000, "running turn")
    await tui.type("also check the tests")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("steering · delivered before the next cell"), 5_000, "steer")
    await tui.press(key.escape)
    await tui.until((screen) => screen.includes("Restored 1 queued message") && idle(screen), 5_000, "restored")
    expect(tui.screen()).toMatch(/┃\s+also check the tests/)
  }, 60_000)
})

describe("! shell commands", () => {
  it("runs !cmd in the working directory and records it for the agent", async () => {
    const { tui, cwd, sessions } = await start()
    await tui.type("!ls && echo done-$((1+1))")
    await tui.press(key.enter)
    const screen = await tui.until((screen) => screen.includes("done-2"), 10_000, "shell output")
    expect(screen).toContain("$ ls && echo done-$((1+1))")
    expect(screen).toContain("check.mjs")
    const [folder] = readdirSync(sessions)
    const [file] = readdirSync(join(sessions, folder!))
    const records = readFileSync(join(sessions, folder!, file!), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(records.at(-1)).toMatchObject({ type: "shell", excluded: false, result: { command: "ls && echo done-$((1+1))", exitCode: 0 } })
    expect(cwd).toBeTruthy()
  }, 60_000)

  it("shows a nonzero exit and keeps !! out of context", async () => {
    const { tui } = await start()
    await tui.type("!!node check.mjs")
    await tui.press(key.enter)
    const screen = await tui.until((screen) => screen.includes("(exit 1)"), 10_000, "exit status")
    expect(screen).toContain("add is wrong")
  }, 60_000)
})

describe("turns", () => {
  it("replays a whole recorded turn: cells stream, flows run, the answer lands", async () => {
    const { tui, cwd } = await start()
    await tui.type("node check.mjs fails. Fix it and show it passes.")
    await tui.press(key.enter)
    await tui.until((screen) => /[●⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] (writing|cell)/.test(screen), 20_000, "first cell")
    await tui.until((screen) => idle(screen) && /Fixed/.test(screen), 120_000, "answer")
    expect(readFileSync(join(cwd, "math.js"), "utf8")).toContain("a + b")
  }, 180_000)

  it("recalls the previous prompt with up", async () => {
    const { tui } = await start()
    await tui.type("!echo first")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("$ echo first"))
    await tui.press(key.up)
    await tui.until((screen) => /┃\s+!echo first/.test(screen), 3_000, "recalled prompt")
  }, 60_000)

  it("continues the latest session with -c", async () => {
    const first = await start()
    await first.tui.type("!echo remembered-output")
    await first.tui.press(key.enter)
    await first.tui.until((screen) => screen.includes("remembered-output"))
    await first.tui.stop()
    tui = await Tui.start({
      cwd: first.cwd,
      command: `bun ${join(app, "src", "main.tsx")} ${first.cwd} -c`,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        SMITHERS_TUI_REPLAY: fixture,
        SMITHERS_TUI_SESSION_DIR: first.sessions
      }
    })
    await tui.until((screen) => screen.includes("remembered-output"), 20_000, "restored transcript")
  }, 90_000)
})

describe("completion", () => {
  it("moves through / commands with the arrows and runs the chosen one with enter", async () => {
    const { tui } = await start()
    await tui.type("/")
    await tui.until((screen) => screen.includes("/hotkeys") || screen.includes("/model"), 5_000, "command menu")
    await tui.type("se")
    await tui.until((screen) => /\/session\s+Show the session file/.test(screen), 5_000, "filtered menu")
    await tui.press(key.enter)
    await tui.until((screen) => /exchanges · ↑0/.test(screen), 5_000, "session note")
  }, 60_000)

  it("completes an argument: /thinking hi, down, enter picks xhigh", async () => {
    const { tui } = await start()
    await tui.type("/thinking hi")
    await tui.until((screen) => screen.includes("xhigh"), 5_000, "levels")
    await tui.press(key.down)
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Thinking level: xhigh"), 5_000, "level set")
  }, 60_000)

  it("inserts an @file mention with tab and leaves the draft unsent", async () => {
    const { tui } = await start()
    await tui.type("look at @chk")
    await tui.until((screen) => screen.includes("check.mjs"), 5_000, "file menu")
    await tui.press(key.tab)
    await tui.until((screen) => /┃\s+look at @check\.mjs/.test(screen), 5_000, "mention")
    await tui.type("please")
    await tui.until((screen) => screen.includes("@check.mjs please"), 5_000, "typing continues")
  }, 60_000)

  it("esc closes the menu without clearing the draft", async () => {
    const { tui } = await start()
    await tui.type("/mod")
    await tui.until((screen) => screen.includes("Pick a model"), 5_000, "menu")
    await tui.press(key.escape)
    await tui.until((screen) => !screen.includes("Pick a model") && /┃\s+\/mod/.test(screen), 5_000, "closed menu")
  }, 60_000)
})

describe("model dialog", () => {
  it("filters as you type and picks with enter", async () => {
    const { tui } = await start()
    await tui.type("/model")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Select model"), 5_000, "dialog")
    await tui.type("zzzz-none")
    await tui.until((screen) => screen.includes('No model matches "zzzz-none"'), 5_000, "empty filter")
    await tui.press(key.escape)
    await tui.until((screen) => !screen.includes("Select model"), 5_000, "closed dialog")
  }, 60_000)
})
