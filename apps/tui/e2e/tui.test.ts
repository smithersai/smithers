/**
 * The TUI in a real PTY, driven through zmux: keys in, screen out.
 *
 * Model turns replay `test/fixtures/fix-add.jsonl` (a recorded gpt-6-sol run)
 * through the replay seat, so no provider is called and the cells it carries
 * run for real against a scratch repository.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import * as Session from "../src/session.ts"
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

/**
 * A scratch repository whose `node check.mjs` fails until `add` adds. With
 * `git`, it is committed, so shell calls are captured and can be undone.
 */
const repository = (options: { readonly git?: boolean } = {}) => {
  const directory = mkdtempSync(join(tmpdir(), "tui-repo-"))
  writeFileSync(join(directory, "math.js"), "export const add = (a, b) => a - b\n")
  writeFileSync(
    join(directory, "check.mjs"),
    "import { add } from \"./math.js\"\nif (add(2, 3) !== 5) { console.error(\"add is wrong\"); process.exit(1) }\nconsole.log(\"ok\")\n"
  )
  if (options.git === true) {
    for (const command of [["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]]) {
      if (spawnSync("git", command, { cwd: directory }).status !== 0) throw new Error(`git ${command[0]} failed`)
    }
  }
  return directory
}

const start = async (
  options: {
    readonly holdMs?: number
    readonly args?: string
    readonly cwd?: string
    readonly sessions?: string
    readonly cols?: number
    /** `all` unless a case is about approvals, so replays test what they test. */
    readonly approve?: "ask" | "all" | "deny"
  } = {}
) => {
  const cwd = options.cwd ?? repository()
  const sessions = options.sessions ?? mkdtempSync(join(tmpdir(), "tui-sessions-"))
  tui = await Tui.start({
    cwd,
    cols: options.cols,
    command: `bun ${join(app, "src", "main.tsx")} ${cwd} ${options.args ?? ""}`,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      SMITHERS_TUI_REPLAY: fixture,
      SMITHERS_TUI_REPLAY_HOLD_MS: String(options.holdMs ?? 0),
      SMITHERS_TUI_REPLAY_SPEED: "20",
      SMITHERS_TUI_SESSION_DIR: sessions,
      SMITHERS_TUI_APPROVE: options.approve ?? "all"
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
  it.each([40, 110])("replays a whole recorded turn at %i columns: cells stream, flows run, the answer lands", async (cols) => {
    const { tui, cwd } = await start({ cols })
    await tui.type("node check.mjs fails. Fix it and show it passes.")
    await tui.press(key.enter)
    await tui.until((screen) => /[●⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] (writing|cell)/.test(screen), 20_000, "first cell")
    await tui.until((screen) => idle(screen) && /Fixed/.test(screen), 120_000, "answer")
    expect(readFileSync(join(cwd, "math.js"), "utf8")).toContain("a + b")
    await tui.until(screen => screen.includes("ctrl+t timeline"), 5_000, "recorded timeline")
    await tui.press("\x14")
    await tui.until(screen => screen.includes("esc live"), 5_000, "timeline focus")
    await tui.press("\x1b[H")
    await tui.until(screen => screen.includes("#1 "), 5_000, "first journal position")
    await tui.press("\x1b[F")
    await tui.press("\x13")
    await tui.until(screen => screen.includes("hjkl/"), 5_000, "summary keyboard focus")
    await tui.press(key.escape)
    await tui.until(screen => screen.includes("esc live"), 5_000, "summary handles Escape and restores the chat timeline")
    await tui.press(key.escape)
    await tui.type("keep the composer usable")
    const inspected = await tui.until(screen => /┃\s+keep the composer usable/.test(screen), 5_000, "chat after inspection")
    if (process.env.STRIP_EVIDENCE_DIR) {
      writeFileSync(join(process.env.STRIP_EVIDENCE_DIR, `terminal-${cols}.txt`), inspected)
      writeFileSync(join(process.env.STRIP_EVIDENCE_DIR, `terminal-${cols}.html`), tui.html())
    }
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
        SMITHERS_TUI_SESSION_DIR: first.sessions,
        SMITHERS_TUI_APPROVE: "all"
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

  it("a picked command keeps the draft out of the way and out of history", async () => {
    const { tui } = await start()
    await tui.type("my precious draft")
    await tui.press(key.ctrlK)
    await tui.type("/sess")
    await tui.until((screen) => /\/session\s+Show the session file/.test(screen), 5_000, "command row")
    await tui.press(key.enter)
    await tui.until((screen) => /exchanges · ↑0/.test(screen) && /┃\s+my precious draft/.test(screen), 5_000, "draft kept")
    await tui.press(key.ctrlK)
    await tui.type("/name")
    await tui.until((screen) => /\/name\s+<name>/.test(screen), 5_000, "name row")
    await tui.press(key.enter)
    await tui.until((screen) => /┃\s+\/name\s*$/m.test(screen), 5_000, "command in composer")
    await tui.type("kept")
    await tui.press(key.enter)
    await tui.until((screen) => /┃\s+my precious draft/.test(screen), 5_000, "draft restored")
  }, 60_000)

  it("text: says when rg stopped at the cap", async () => {
    const cwd = repository()
    for (let file = 0; file < 12; file++) {
      writeFileSync(join(cwd, `many${file}.txt`), Array.from({ length: 20 }, () => "repeated").join("\n") + "\n")
    }
    const { tui } = await start({ cwd })
    await tui.press(key.ctrlK)
    await tui.type("text:repeated")
    await tui.until((screen) => screen.includes("Search · first 200"), 10_000, "cap shown")
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
        SMITHERS_TUI_SESSION_DIR: first.sessions,
        SMITHERS_TUI_APPROVE: "all"
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

describe("fork", () => {
  it("forks before a picked message, puts it back in the editor, and keeps the original", async () => {
    const cwd = repository()
    const sessions = mkdtempSync(join(tmpdir(), "tui-sessions-"))
    process.env.SMITHERS_TUI_SESSION_DIR = sessions
    const source = Session.create(cwd)
    const exchange = (at: number, text: string, answer: string) => {
      source.append({ type: "user", at, text })
      const message = { role: "assistant", content: [{ type: "text", text: answer }] }
      source.append({ type: "event", at: at + 1, event: { _tag: "resolved", message } } as unknown as Session.Record)
      source.append({ type: "outcome", at: at + 1, prompt: text, outcome: { _tag: "done", answer } })
    }
    exchange(1, "first question", "A1")
    exchange(3, "second question", "A2")
    const before = readFileSync(source.file, "utf8")
    const { tui } = await start({ cwd, sessions, args: "-c" })
    await tui.until((screen) => screen.includes("A2"), 10_000, "restored session")
    await tui.type("/fork")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Fork from message"), 5_000, "fork dialog")
    await tui.type("second")
    await tui.press(key.enter)
    await tui.until(
      (screen) => /┃\s+second question/.test(screen) && screen.includes("Forked to new session"),
      5_000,
      "forked"
    )
    expect(tui.screen()).not.toContain("A2")
    expect(tui.screen()).toContain("A1")
    const listed = Session.list(cwd)
    expect(listed).toHaveLength(2)
    expect(readFileSync(source.file, "utf8")).toBe(before)
    const forked = listed.find((each) => each.file !== source.file)!
    expect(Session.load(forked.file)[0]).toMatchObject({ type: "session", parent: source.file })
  }, 60_000)

  it("refuses while a turn runs", async () => {
    const { tui } = await start({ holdMs: 60_000 })
    await tui.type("node check.mjs fails. Fix it and show it passes.")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("esc interrupt"), 20_000, "turn running")
    await tui.type("/fork")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Stop running work first"), 5_000, "refusal")
    expect(tui.screen()).not.toContain("Fork from message")
  }, 60_000)

  it("refuses while a shell command runs", async () => {
    const { tui } = await start()
    await tui.type("!sleep 30")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Running… (esc to cancel)"), 5_000, "running shell")
    await tui.type("/fork")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Stop running work first"), 5_000, "refusal")
    expect(tui.screen()).not.toContain("Fork from message")
  }, 60_000)

  it("refuses while a worker runs", async () => {
    tui = await Tui.start({
      cwd: repository(),
      command: `bun ${join(app, "e2e", "workspace-fixture.tsx")}`,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        SMITHERS_TUI_SESSION_DIR: mkdtempSync(join(tmpdir(), "tui-background-"))
      }
    })
    await tui.until((screen) => screen.includes("code  ·"), 20_000, "first draw")
    await tui.type("investigate")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Investigation · running") && !screen.includes("esc interrupt"), 5_000, "worker")
    await tui.type("/fork")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Stop running work first"), 5_000, "refusal")
    expect(tui.screen()).not.toContain("Fork from message")
  }, 60_000)

  it("has nothing to fork in a fresh session", async () => {
    const { tui } = await start()
    await tui.type("/fork")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("No messages to fork from"), 5_000, "empty")
  }, 60_000)
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

  /** Runs the fix-add turn in a git repository and selects the `Updated math.js` row in the Summary. */
  const editRow = async (options: { readonly sessions?: string } = {}) => {
    const started = await start({ cwd: repository({ git: true }), ...options })
    await started.tui.type("node check.mjs fails. Fix it and show it passes.")
    await started.tui.press(key.enter)
    await started.tui.until((screen) => idle(screen) && /Fixed/.test(screen), 120_000, "answer")
    await started.tui.type("/summary")
    await started.tui.press(key.enter)
    await started.tui.until((screen) => screen.includes("u undo") && screen.includes("Asked:"), 5_000, "summary")
    for (let step = 0; step < 8 && !/› .*Updated math\.js/.test(started.tui.screen()); step++) {
      await started.tui.type("j")
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    await started.tui.until((screen) => /› .*Updated math\.js/.test(screen), 5_000, "edit row")
    return started
  }

  it("u on the edit row confirms, restores math.js, and tells the transcript", async () => {
    const { tui, cwd } = await editRow()
    expect(readFileSync(join(cwd, "math.js"), "utf8")).toContain("a + b")
    await tui.type("u")
    await tui.until((screen) => screen.includes("Undo math.js?"), 5_000, "confirm")
    await tui.press(key.enter)
    await tui.until(
      (screen) => readFileSync(join(cwd, "math.js"), "utf8").includes("a - b") && screen.includes("Undid math.js"),
      10_000,
      "undone"
    )
    await tui.until((screen) => /› .*Undone: Updated math\.js/.test(screen), 5_000, "undone row")
    await tui.press(key.escape)
    await tui.until((screen) => screen.includes("Undid math.js") && !screen.includes("u undo"), 5_000, "chat note")
    await tui.type("still usable")
    await tui.until((screen) => /┃\s+still usable/.test(screen), 5_000, "usable composer")
  }, 180_000)

  it("u refuses when math.js changed since, and changes nothing", async () => {
    const { tui, cwd } = await editRow()
    writeFileSync(join(cwd, "math.js"), "export const add = (a, b) => b + a\n")
    await tui.type("u")
    await tui.until((screen) => screen.includes("Undo math.js?"), 5_000, "confirm")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("changed since: math.js"), 10_000, "conflict")
    expect(readFileSync(join(cwd, "math.js"), "utf8")).toBe("export const add = (a, b) => b + a\n")
  }, 180_000)

  it("esc in the undo dialog changes nothing", async () => {
    const { tui, cwd } = await editRow()
    await tui.type("u")
    await tui.until((screen) => screen.includes("Undo math.js?"), 5_000, "confirm")
    await tui.press(key.escape)
    await tui.until((screen) => !screen.includes("Undo math.js?"), 5_000, "closed")
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(readFileSync(join(cwd, "math.js"), "utf8")).toContain("a + b")
    expect(tui.screen()).not.toContain("Undid")
  }, 180_000)

  it("u refuses while a turn runs, and the composer stays usable", async () => {
    const { tui } = await start({ holdMs: 60_000 })
    await tui.type("node check.mjs fails. Fix it and show it passes.")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("esc interrupt"), 10_000, "running turn")
    await tui.press(key.ctrlS)
    await tui.until((screen) => screen.includes("u undo"), 5_000, "summary")
    await tui.type("u")
    await tui.until((screen) => screen.includes("Stop running work first"), 5_000, "busy")
    await tui.press(key.escape)
    await tui.type("still usable")
    await tui.until((screen) => /┃\s+still usable/.test(screen), 5_000, "usable composer")
  }, 60_000)

  it("keeps the undo across a restart", async () => {
    const first = await editRow()
    await first.tui.type("u")
    await first.tui.until((screen) => screen.includes("Undo math.js?"), 5_000, "confirm")
    await first.tui.press(key.enter)
    await first.tui.until((screen) => screen.includes("Undid math.js"), 10_000, "undone")
    await first.tui.stop()
    tui = await Tui.start({
      cwd: first.cwd,
      command: `bun ${join(app, "src", "main.tsx")} ${first.cwd} -c`,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        SMITHERS_TUI_REPLAY: fixture,
        SMITHERS_TUI_SESSION_DIR: first.sessions,
        SMITHERS_TUI_APPROVE: "all"
      }
    })
    await tui.until((screen) => screen.includes("Undid math.js"), 20_000, "restored note")
    await tui.type("/summary")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Undone: Updated math.js"), 5_000, "restored row")
    for (let step = 0; step < 8 && !/› .*Undone: Updated math\.js/.test(tui.screen()); step++) {
      await tui.type("j")
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    await tui.until((screen) => /› .*Undone: Updated math\.js/.test(screen), 5_000, "undone row")
    await tui.type("u")
    await tui.until((screen) => screen.includes("Already undone"), 5_000, "already undone")
  }, 180_000)

  it("u in a worker tab undoes the worker's edit and records it in the worker file", async () => {
    const cwd = repository()
    const sessions = mkdtempSync(join(tmpdir(), "tui-worker-undo-"))
    tui = await Tui.start({
      cwd,
      command: `bun ${join(app, "e2e", "workspace-fixture.tsx")}`,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SMITHERS_TUI_SESSION_DIR: sessions }
    })
    await tui.until((screen) => screen.includes("code  ·"), 20_000, "first draw")
    await tui.type("delegate fix")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Fixer · done"), 10_000, "worker done")
    expect(readFileSync(join(cwd, "math.js"), "utf8")).toContain("a + b")
    await tui.press(key.ctrlK)
    await tui.type("tab:fix")
    await tui.until((screen) => screen.includes("Search") && /Fixer\s+done/.test(screen), 5_000, "tab row")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("u undo"), 5_000, "worker tab")
    for (let step = 0; step < 8 && !/› .*math\.js/.test(tui.screen()); step++) {
      await tui.type("j")
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    await tui.until((screen) => /› .*math\.js/.test(screen), 5_000, "edit row")
    await tui.type("u")
    await tui.until((screen) => screen.includes("Undo math.js?"), 5_000, "confirm")
    await tui.press(key.enter)
    await tui.until(
      (screen) => readFileSync(join(cwd, "math.js"), "utf8").includes("a - b") && screen.includes("Undid math.js"),
      10_000,
      "undone"
    )
    const folder = join(sessions, readdirSync(sessions)[0]!)
    const lines = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    const chat = lines(join(folder, readdirSync(folder).find((name) => name.endsWith(".jsonl"))!))
    expect(chat.filter((record) => record.type === "undo")).toMatchObject([{ tab: "fixer", paths: ["math.js"] }])
    const worker = lines(join(folder, "workers", readdirSync(join(folder, "workers"))[0]!))
    expect(worker.filter((record) => record.type === "undo")).toMatchObject([{ paths: ["math.js"] }])
    await tui.type("u")
    await tui.until((screen) => screen.includes("Already undone"), 5_000, "already undone")
  }, 60_000)

  it("undo refuses while a project flow is active", async () => {
    const cwd = repository()
    tui = await Tui.start({
      cwd,
      command: `bun ${join(app, "e2e", "workspace-fixture.tsx")}`,
      env: { PATH: process.env.PATH!, HOME: process.env.HOME!, SMITHERS_TUI_SESSION_DIR: join(cwd, "sessions") }
    })
    await tui.until((screen) => screen.includes("code  ·"), 20_000)
    await tui.type("delegate fix")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Requested the fix.") && screen.includes("Fixer · done"))
    await tui.type("/flow review title=x")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("review · running"))
    await tui.type("/tabs")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("r retry"))
    await tui.press("u")
    const screen = await tui.until((screen) => screen.includes("Stop running work first") || screen.includes("Undo math.js?"))
    expect(screen).toContain("Stop running work first")
    expect(screen).not.toContain("Undo math.js?")
    expect(readFileSync(join(cwd, "math.js"), "utf8")).toContain("a + b")
  }, 60_000)

  it("/new waits for a running undo, which settles in its own session", async () => {
    const { tui, cwd } = await editRow()
    // A FIFO holds the undo's read of math.js open: a deliberately unresolved undo.
    rmSync(join(cwd, "math.js"))
    if (spawnSync("mkfifo", [join(cwd, "math.js")]).status !== 0) throw new Error("mkfifo failed")
    await tui.type("u")
    await tui.until((screen) => screen.includes("Undo math.js?"), 5_000, "confirm")
    await tui.press(key.enter)
    await tui.until((screen) => !screen.includes("Undo math.js?"), 5_000, "undo started")
    await tui.press(key.escape)
    await tui.type("/new")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Stop running work first"), 5_000, "refusal")
    const release = Bun.spawn(["sh", "-c", "printf x > math.js"], { cwd })
    await tui.until((screen) => screen.includes("changed since: math.js"), 10_000, "undo settled")
    await release.exited
    await tui.type("/new")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("New session started"), 5_000, "new session")
  }, 180_000)

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
          SMITHERS_TUI_APPROVE: "all",
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
    const requests = records.filter((record) => record.type === "tab" && record.tab.status === "requested")
    // Describing a pending request may append a newer version of the same
    // tab. Deduplication promises one worker identity and one execution file.
    expect([...new Set(requests.map((record) => record.tab.id))]).toEqual(["investigation"])
    expect(new Set(requests.map((record) => record.tab.file)).size).toBe(1)
    expect(readdirSync(join(folder, "workers"))).toHaveLength(1)
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

describe("flows", () => {
  const ctrlRight = "\x1b[1;5C"
  const open = async () => {
    const cwd = repository()
    const sessions = mkdtempSync(join(tmpdir(), "tui-flows-"))
    tui = await Tui.start({
      cwd,
      command: `bun ${join(app, "e2e", "workspace-fixture.tsx")}`,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SMITHERS_TUI_SESSION_DIR: sessions }
    })
    await tui.until((screen) => screen.includes("code  ·"), 20_000, "first draw")
    return { tui, sessions }
  }

  it("runs a flow from /flows through its form without blocking chat", async () => {
    const { tui } = await open()
    await tui.type("/flows")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Review a change"), 5_000, "flows dialog")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Title"), 5_000, "form field")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Needs: Title"), 5_000, "missing field")
    await tui.type("x")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("review · running"), 5_000, "running toast")
    await tui.type("hello")
    await tui.until((screen) => /┃\s+hello/.test(screen), 5_000, "composer usable while the flow runs")
    await tui.press(ctrlRight)
    await tui.press(ctrlRight)
    await tui.until((screen) => screen.includes("r retry"), 5_000, "flow tab")
    await tui.type("x")
    await tui.until((screen) => screen.includes("review · cancelled") && screen.includes("■ review"), 5_000, "settled from the watch")
  }, 60_000)

  it("a flow form yields to chat: Esc and Ctrl+Right close it and the run stays parked", async () => {
    const { tui } = await open()
    await tui.type("/flow review")
    await tui.press(key.enter)
    await tui.until((screen) => /┃\s+Title/.test(screen), 5_000, "form")
    await tui.press(key.escape)
    await tui.type("hello")
    await tui.until((screen) => /┃\s+hello/.test(screen), 5_000, "composer after Esc")
    await tui.press(key.ctrlC)
    await tui.press(ctrlRight)
    await tui.press(ctrlRight)
    await tui.until((screen) => screen.includes("r retry"), 5_000, "flow tab")
    await tui.type("a")
    await tui.until((screen) => /┃\s+Title/.test(screen), 5_000, "form reopened")
    await tui.press(ctrlRight)
    await tui.type("again")
    await tui.until((screen) => /┃\s+again/.test(screen), 5_000, "composer after Ctrl+Right")
    expect(tui.screen()).not.toContain("cancelled")
    expect(tui.screen()).toContain("◌ review")
  }, 60_000)

  it("offers the directory's flows in the / menu", async () => {
    const { tui } = await open()
    await tui.type("/rev")
    await tui.until((screen) => screen.includes("/flow review") && screen.includes("Review a change"), 5_000, "flow in menu")
  }, 30_000)
})

describe("approvals", () => {
  it("project flows use approval rows without blocking the composer", async () => {
    const cwd = repository()
    const folder = join(cwd, "flows", "consequential")
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, "flow.ts"), readFileSync(join(app, "test", "fixtures", "flows-project", "flows", "consequential", "flow.ts")))
    symlinkSync(join(app, "..", "..", "node_modules"), join(cwd, "node_modules"))
    const started = await start({ cwd, approve: "ask" })
    await started.tui.type("/flow consequential")
    await started.tui.press(key.enter)
    await started.tui.until((screen) => screen.includes("fs:write:/**") && screen.includes("n deny"), 30_000)
    await started.tui.type("draft")
    await started.tui.until((screen) => /┃\s+draft/.test(screen) && !screen.includes("n deny"))
    await started.tui.press(key.ctrlC)
    await started.tui.until((screen) => screen.includes("n deny"))
    await started.tui.press("n")
    await started.tui.until((screen) => screen.includes("consequential · failed") && !screen.includes("n deny"))
    const sessions = join(started.sessions, readdirSync(started.sessions)[0]!)
    const records = Session.load(join(sessions, readdirSync(sessions).find((name) => name.endsWith(".jsonl"))!))
    expect(records.filter((record) => record.type === "flow").every((record) => record.run.runId === undefined)).toBe(true)
  }, 60_000)

  it("advertised approval keys work with Summary focus", async () => {
    const cwd = repository()
    tui = await Tui.start({
      cwd,
      command: `bun ${join(app, "e2e", "approval-fixture.tsx")}`,
      env: { PATH: process.env.PATH!, HOME: process.env.HOME!, SMITHERS_TUI_SESSION_DIR: join(cwd, "sessions") }
    })
    await tui.until((screen) => screen.includes("code  ·"), 20_000)
    await tui.type("run")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("? bash true") && screen.includes("n deny"))
    await tui.press(key.ctrlS)
    await tui.until((screen) => screen.includes("u undo") && screen.includes("n deny"))
    await tui.press("n")
    await Bun.sleep(600)
    expect(tui.screen()).not.toContain("? bash true")
    const folder = join(cwd, "sessions", readdirSync(join(cwd, "sessions"))[0]!)
    const file = join(folder, readdirSync(folder).find((name) => name.endsWith(".jsonl"))!)
    const outcome = Session.load(file).findLast((record) => record.type === "outcome")
    expect(outcome).toMatchObject({ type: "outcome", outcome: { answer: "Choice: deny" } })
  }, 60_000)

  const prompt = "node check.mjs fails. Fix it and show it passes."
  const asking = /\? (bash|edit|write|apply_patch) .*y allow/

  /** Answers every approval with `answer` until the turn is idle. */
  const answerAll = async (tui: Tui, answer: (screen: string) => string) => {
    // A denied replay keeps issuing recorded calls until its frame budget ends.
    for (let index = 0; index < 200; index++) {
      const screen = await tui.until((screen) => asking.test(screen) || idle(screen), 120_000, "approval or idle")
      if (!asking.test(screen)) return screen
      const shown = screen.match(asking)![0]
      await tui.press(answer(screen))
      // Wait for the answered row to leave, or a pressed key would land in
      // the editor. A new request can read the same, so this only bounds it.
      await tui.until((screen) => screen.match(asking)?.[0] !== shown, 2_000, "answered row").catch(() => undefined)
    }
    throw new Error(`too many approvals; screen:\n${tui.screen()}`)
  }

  it("asks before a consequential call; y lets it run", async () => {
    const { tui, cwd } = await start({ approve: "ask" })
    await tui.type(prompt)
    await tui.press(key.enter)
    await tui.until((screen) => asking.test(screen), 60_000, "first approval")
    expect(readFileSync(join(cwd, "math.js"), "utf8")).toContain("a - b")
    // `a` on the first bash covers the rest of them for the session.
    let always = false
    await answerAll(tui, (screen) => {
      if (!always && /\? bash .*a all bash/.test(screen)) {
        always = true
        return "a"
      }
      return "y"
    })
    expect(always).toBe(true)
    expect(readFileSync(join(cwd, "math.js"), "utf8")).toContain("a + b")
  }, 240_000)

  it("n denies: nothing changes and the call shows denied", async () => {
    const { tui, cwd } = await start({ approve: "ask" })
    await tui.type(prompt)
    await tui.press(key.enter)
    await tui.until((screen) => asking.test(screen), 60_000, "first approval")
    const screen = await answerAll(tui, () => "n")
    expect(screen).not.toMatch(/┃\s+n/)
    expect(readFileSync(join(cwd, "math.js"), "utf8")).toBe("export const add = (a, b) => a - b\n")
    await tui.press(key.ctrlO)
    await tui.until((screen) => screen.includes("Denied"), 10_000, "denied call")
  }, 240_000)

  it("never eats typing, and answers once the editor is empty", async () => {
    const { tui } = await start({ approve: "ask" })
    await tui.type(prompt)
    await tui.press(key.enter)
    await tui.until((screen) => asking.test(screen), 60_000, "first approval")
    const before = tui.screen().match(asking)![0]
    await tui.type("hy")
    const typed = await tui.until((screen) => /┃\s+hy/.test(screen), 5_000, "typed draft")
    expect(typed).not.toMatch(asking)
    expect(typed).toContain("? bash")
    await tui.press(key.ctrlC)
    const ready = await tui.until(
      (screen) => !/┃\s+hy/.test(screen) && asking.test(screen), 5_000, "cleared draft and armed approval"
    )
    expect(ready.match(asking)?.[0]).toBe(before)
    await tui.press("y")
    await tui.until((screen) => screen.match(asking)?.[0] !== before, 30_000, "answered")
  }, 120_000)

  it("keeps chat usable while a request waits, and esc drops it", async () => {
    const { tui } = await start({ approve: "ask" })
    await tui.type(prompt)
    await tui.press(key.enter)
    await tui.until((screen) => asking.test(screen), 60_000, "first approval")
    await tui.type("later")
    await tui.press("\x1b\r")
    await tui.until((screen) => screen.includes("Follow-up: later"), 5_000, "queued")
    // The first `a` after sending is text, even though the approval waited
    // long enough to arm before the editor was cleared.
    await tui.type("and also")
    const typed = await tui.until((screen) => /┃\s+and also/.test(screen), 5_000, "next draft")
    expect(typed).toContain("? bash")
    expect(typed).not.toMatch(asking)
    await tui.press(key.escape)
    await tui.until((screen) => !asking.test(screen) && idle(screen), 5_000, "dropped approval")
  }, 120_000)

  it("print mode never hangs: it denies unless told otherwise", () => {
    const run = (approve: string | undefined) => {
      const cwd = repository()
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        SMITHERS_TUI_REPLAY: fixture,
        SMITHERS_TUI_REPLAY_SPEED: "20",
        SMITHERS_TUI_SESSION_DIR: mkdtempSync(join(tmpdir(), "tui-sessions-"))
      }
      if (approve !== undefined) env.SMITHERS_TUI_APPROVE = approve
      const started = Date.now()
      const result = spawnSync("bun", [join(app, "src", "main.tsx"), cwd, "-p", prompt], {
        env,
        encoding: "utf8",
        // The replay seat keeps replaying after a denial until the 40-frame
        // budget ends the run: about 80 s at speed 20. A hang never ends.
        timeout: 150_000
      })
      return { ...result, ms: Date.now() - started, math: readFileSync(join(cwd, "math.js"), "utf8") }
    }
    const denied = run(undefined)
    expect(denied.signal).toBeNull()
    expect(denied.stderr).toMatch(/denied (bash|edit)/)
    expect(denied.math).toContain("a - b")
    const allowed = run("all")
    expect(allowed.math).toContain("a + b")
    const refused = run("ask")
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain("SMITHERS_TUI_APPROVE=ask needs the interactive TUI")
    expect(refused.ms).toBeLessThan(10_000)
  }, 400_000)
})
