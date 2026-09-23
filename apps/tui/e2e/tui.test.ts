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
const idle = (screen: string) =>
  screen.includes("code  ·") && !screen.includes("esc interrupt") && !/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \d/.test(screen)

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
    "import { add } from \"./math.js\"\nif (add(2, 3) !== 5) { console.error(\"add is wrong\"); process.exit(1) }\nconsole.log(\"ok\")\n"
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
    await tui.call("session.send", {
      sessionId: "tui",
      dataBase64: Buffer.from(key.ctrlC + key.ctrlC).toString("base64")
    })
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
    await tui.until((screen) => screen.includes("esc interrupt") && /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \d/.test(screen), 10_000, "running turn")
    await tui.press(key.escape)
    const screen = await tui.until((screen) => screen.includes("✗ Stopped") && idle(screen), 5_000, "stopped turn")
    expect(screen).toContain("Ask Smithers to change this repository")
  }, 60_000)

  it("cancels a running shell command", async () => {
    const { tui } = await start()
    await tui.type("!sleep 30")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Running… (esc to cancel)"), 5_000, "running shell")
    await tui.press(key.escape)
    await tui.until((screen) => screen.includes("(cancelled)"), 5_000, "cancelled shell")
  }, 60_000)

  it("puts steered messages back in the editor when it stops the turn", async () => {
    const { tui } = await start({ holdMs: 60_000 })
    await tui.type("first prompt")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("alt+enter to queue"), 10_000, "running turn")
    await tui.type("also check the tests")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("steering"), 5_000, "steer")
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
    const records = readFileSync(join(sessions, folder!, file!), "utf8").trim().split("\n").map((line) =>
      JSON.parse(line)
    )
    expect(records.at(-1)).toMatchObject({
      type: "shell",
      excluded: false,
      result: { command: "ls && echo done-$((1+1))", exitCode: 0 }
    })
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

  it("folds a finished cell's code and what it printed until ctrl+o", async () => {
    const { tui } = await start()
    await tui.type("node check.mjs fails. Fix it and show it passes.")
    await tui.press(key.enter)
    await tui.until((screen) => idle(screen) && /Fixed/.test(screen), 120_000, "answer")
    const folded = tui.screen()
    expect(folded).toMatch(/… \d+ more lines/)
    expect(folded).toMatch(/printed \d+ lines · ctrl\+o/)
    expect(folded).not.toContain("output to a specific file")
    await tui.press(key.ctrlO)
    await tui.until((screen) => screen.includes("output to a specific file"), 5_000, "expanded output")
    expect(tui.screen()).not.toMatch(/… \d+ more lines/)
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

describe("search palette", () => {
  it("ctrl+k opens Search without deleting the rest of the line", async () => {
    const { tui } = await start()
    await tui.type("look at ")
    await tui.press(key.ctrlA)
    await tui.press(key.ctrlK)
    await tui.until((screen) => screen.includes("Search") && screen.includes("/model"), 5_000, "palette")
    await tui.press(key.escape)
    await tui.until((screen) => !screen.includes("Pick a model") && /┃\s+look at/.test(screen), 5_000, "draft kept")
  }, 60_000)

  it("enter on a file inserts an @mention after the draft", async () => {
    const { tui } = await start()
    await tui.type("look at ")
    await tui.press(key.ctrlK)
    await tui.until((screen) => screen.includes("Search"), 5_000, "palette")
    await tui.type("check")
    await tui.until((screen) => screen.includes("check.mjs"), 5_000, "file row")
    await tui.press(key.enter)
    await tui.until((screen) => /┃\s+look at @check\.mjs/.test(screen), 5_000, "mention")
  }, 60_000)

  it("text: searches file text with rg and inserts @path:line", async () => {
    const { tui } = await start()
    await tui.press(key.ctrlK)
    await tui.until((screen) => screen.includes("Search"), 5_000, "palette")
    await tui.type("text:a - b")
    await tui.until((screen) => screen.includes("math.js:1"), 10_000, "rg hit")
    await tui.press(key.enter)
    await tui.until((screen) => /┃\s+@math\.js:1/.test(screen), 5_000, "line mention")
  }, 60_000)

  it("runs a command, and ? lists prefixes that switch the mode", async () => {
    const { tui } = await start()
    await tui.press(key.ctrlK)
    await tui.type("/sess")
    await tui.until((screen) => /\/session\s+Show the session file/.test(screen), 5_000, "command row")
    await tui.press(key.enter)
    await tui.until((screen) => /exchanges · ↑0/.test(screen), 5_000, "session note")
    await tui.press(key.ctrlK)
    await tui.type("?")
    await tui.until((screen) => screen.includes("session:") && screen.includes("worker tabs"), 5_000, "prefix list")
    await tui.press(key.enter)
    await tui.type("hotk")
    await tui.until((screen) => /\/hotkeys\s+Show the keys/.test(screen), 5_000, "typed after the prefix")
  }, 60_000)

  it("session: resumes a past session", async () => {
    const first = await start()
    await first.tui.type("!echo remembered-output")
    await first.tui.press(key.enter)
    await first.tui.until((screen) => screen.includes("remembered-output"))
    await first.tui.stop()
    tui = await Tui.start({
      cwd: first.cwd,
      command: `bun ${join(app, "src", "main.tsx")} ${first.cwd}`,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        SMITHERS_TUI_REPLAY: fixture,
        SMITHERS_TUI_SESSION_DIR: first.sessions
      }
    })
    await tui.until((screen) => screen.includes("code  ·"), 20_000, "first draw")
    await tui.press(key.ctrlK)
    await tui.type("session:")
    await tui.until((screen) => /Search[\s\S]*_[0-9a-f]{8}-/.test(screen), 5_000, "session row")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Resumed") && screen.includes("remembered-output"), 5_000, "resumed")
  }, 90_000)
})

describe("model dialog", () => {
  it("filters as you type and picks with enter", async () => {
    const { tui } = await start()
    await tui.type("/model")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Select model"), 5_000, "dialog")
    await tui.type("zzzz-none")
    await tui.until((screen) => screen.includes("No model matches \"zzzz-none\""), 5_000, "empty filter")
    await tui.press(key.escape)
    await tui.until((screen) => !screen.includes("Select model"), 5_000, "closed dialog")
  }, 60_000)
})

describe("runtime views", () => {
  it(
    "navigates summary rows with hjkl/arrows, expands code, toggles the real diff, and returns focus to chat",
    async () => {
      const { tui } = await start()
      await tui.type("node check.mjs fails. Fix it and show it passes.")
      await tui.press(key.enter)
      await tui.until((screen) => idle(screen) && /Fixed/.test(screen), 120_000, "answer")
      await tui.type("/summary")
      await tui.press(key.enter)
      await tui.until((screen) => screen.includes("enter details") && screen.includes("Asked:"), 5_000, "summary")
      await tui.type("jl")
      await tui.until((screen) => screen.includes("ctx.call(\"ls\""), 5_000, "expanded cell source")
      await tui.type("hjd")
      const diff = await tui.until(
        (screen) => screen.includes("math.js") && screen.includes("a + b") && screen.includes("a - b"),
        5_000,
        "real edit diff"
      )
      expect(diff).toContain("Updated math.js")
      await tui.type("v")
      await tui.until((screen) => screen.includes("a + b") && screen.includes("a - b"), 5_000, "split diff")
      await tui.press(key.up)
      await tui.until((screen) => screen.includes("No recorded changes."), 5_000, "previous turn")
      await tui.press(key.escape)
      await tui.type("a new question")
      await tui.until((screen) => /┃\s+a new question/.test(screen), 5_000, "usable composer")
    },
    180_000
  )

  it("renders agent-authored UI from a real cell and restores it after restart", async () => {
    const cwd = repository()
    const sessions = mkdtempSync(join(tmpdir(), "tui-panels-"))
    const recording = join(sessions, "ui-reply.jsonl")
    const panel = {
      id: "checks",
      title: "Checks",
      summary: "The addition check passed.",
      rows: [{
        id: "addition",
        label: "Checked addition",
        status: "done",
        details: [{ kind: "code", language: "javascript", code: "assert(add(2, 3) === 5)" }]
      }]
    }
    const reply = `\`\`\`javascript\nconst shown = await ctx.call("ui.publish", ${
      JSON.stringify(panel)
    }); if (shown.ok === false) throw new Error(JSON.stringify(shown)); ctx.done("Published the checks view.")\n\`\`\``
    writeFileSync(
      recording,
      [
        { at: 1, event: { _tag: "model-requested" } },
        { at: 2, event: { _tag: "model-delta", delta: { type: "text-delta", id: "reply", text: reply } } },
        { at: 3, event: { _tag: "model-settled", message: { stopReason: "stop" } } }
      ].map((record) => JSON.stringify(record)).join("\n")
    )
    const launch = async (resume: boolean) => {
      tui = await Tui.start({
        cwd,
        command: `bun ${join(app, "src", "main.tsx")} ${cwd} ${resume ? "-c" : ""}`,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          SMITHERS_TUI_REPLAY: recording,
          SMITHERS_TUI_SESSION_DIR: sessions
        }
      })
      await tui.until((screen) => screen.includes("code  ·"), 20_000, "first draw")
      return tui
    }
    const first = await launch(false)
    await first.type("Build a checks view")
    await first.press(key.enter)
    await first.until(
      (screen) => idle(screen) && screen.includes("Published the checks view."),
      30_000,
      "runtime UI published"
    )
    await first.type("/ui")
    await first.press(key.enter)
    await first.until(
      (screen) => screen.includes("The addition check passed.") && screen.includes("Checked addition"),
      5_000,
      "custom view"
    )
    await first.type("l")
    await first.until((screen) => screen.includes("assert(add(2, 3) === 5)"), 5_000, "custom code")
    await first.stop()
    const resumed = await launch(true)
    await resumed.type("/ui")
    await resumed.press(key.enter)
    await resumed.until((screen) => screen.includes("The addition check passed."), 5_000, "persisted custom view")
  }, 90_000)
})

it(
  "keeps chat and navigation usable through an unresolved worker, deduplicates its tab, and settles its toast on cancellation",
  async () => {
    const cwd = repository()
    const sessions = mkdtempSync(join(tmpdir(), "tui-background-"))
    tui = await Tui.start({
      cwd,
      command: `bun ${join(app, "e2e", "workspace-fixture.tsx")}`,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SMITHERS_TUI_SESSION_DIR: sessions }
    })
    await tui.until((screen) => screen.includes("code  ·"), 20_000, "first draw")
    await tui.type("investigate")
    await tui.press(key.enter)
    await tui.until(
      (screen) => screen.includes("Requested the investigation.") && screen.includes("Investigation · running"),
      5_000,
      "worker still running after chat acknowledges"
    )
    await tui.type("hello")
    await tui.press(key.enter)
    await tui.until(
      (screen) => screen.includes("Still here.") && screen.includes("Investigation · running"),
      5_000,
      "second chat turn during background work"
    )
    await tui.until(
      (screen) => /┃ ↳ Investigation/.test(screen) && screen.includes("Investigate the failing check."),
      5_000,
      "worker rows in the chat timeline"
    )
    await tui.type("/filter")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Filter chat") && screen.includes("Show all"), 5_000, "filter dialog")
    await tui.press(key.down)
    await tui.press(key.down)
    await tui.press(key.enter)
    await tui.press(key.escape)
    await tui.until(
      (screen) =>
        screen.includes("filtered") && screen.includes("Still here.") &&
        !screen.includes("Investigate the failing check."),
      5_000,
      "worker hidden by the filter"
    )
    await tui.type("/filter")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Filter chat"), 5_000, "filter dialog again")
    await tui.press(key.enter)
    await tui.press(key.escape)
    await tui.until(
      (screen) => !screen.includes("filtered") && screen.includes("Investigate the failing check."),
      5_000,
      "show all restores the worker"
    )
    const folder = join(sessions, readdirSync(sessions)[0]!)
    const records = readFileSync(join(folder, readdirSync(folder).find((name) => name.endsWith(".jsonl"))!), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line))
    expect(records.filter((record) => record.type === "tab" && record.tab.status === "requested")).toHaveLength(1)
    await tui.press(key.ctrlK)
    await tui.type("tab:inv")
    await tui.until((screen) => screen.includes("Search") && /Investigation\s+running/.test(screen), 5_000, "tab row")
    await tui.press(key.enter)
    await tui.until(
      (screen) => screen.includes("r retry") && screen.includes("Investigation · running"),
      5_000,
      "inspect running worker"
    )
    await tui.type("x")
    await tui.until((screen) => screen.includes("Investigation · cancelled"), 5_000, "actual worker settlement")
    await tui.press(key.escape)
    await tui.until((screen) => screen.includes("Still here.") && !screen.includes("r retry"), 5_000, "escape returns to chat")
    await tui.type("still usable")
    await tui.until((screen) => /┃\s+still usable/.test(screen), 5_000, "composer after cancellation")
  },
  60_000
)
