/**
 * The TUI in a real PTY, driven through zmux: keys in, screen out.
 *
 * Model turns replay `test/fixtures/fix-add.jsonl` (a recorded gpt-6-sol run)
 * through the replay seat, so no provider is called and the cells it carries
 * run for real against a scratch repository.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import * as Session from "../src/session.ts"
import { key, Tui } from "./zmux.ts"

const app = resolve(import.meta.dir, "..")
const fixture = join(app, "test", "fixtures", "fix-add.jsonl")
/** The status bar's token counter: present once the first frame is drawn. */
const drawn = (screen: string) => /↑\S+ ↓\S+/.test(screen)
const idle = (screen: string) =>
  drawn(screen) && !screen.includes("esc Interrupt") && !/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \d/.test(screen)

/** The scrubber's playhead column. */
const knob = (screen: string): number =>
  screen.split("\n").map((line) => [...line].indexOf("●")).find((column) => column >= 0) ?? -1

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
    /** Unset runs the default (every call unasked); approval cases opt in. */
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
      ...(options.approve === undefined ? {} : { SMITHERS_TUI_APPROVE: options.approve })
    }
  })
  await tui.until(drawn, 20_000, "first draw")
  return { tui, cwd, sessions }
}

describe("composer mode", () => {
  it("names no mode by default and shows shell once the draft starts with !", async () => {
    const { tui } = await start()
    const footer = (screen: string) => screen.split("\n").find((line) => line.includes("replay fix-add.jsonl"))?.replace(/^\s*┃/, "").trim()
    expect(footer(tui.screen())).toBe("replay fix-add.jsonl")
    await tui.type("!")
    const screen = await tui.until((screen) => footer(screen)?.includes("shell") === true, 5_000, "shell mode")
    expect(footer(screen)).toBe("shell  ·  replay fix-add.jsonl")
  }, 60_000)
})

describe("which-key", () => {
  /** The popup's title row: `Keys` on the left, `esc` on the right. */
  const popup = (screen: string) => /^\s*Keys\s+esc\s*$/m.test(screen)
  /** The draft: the composer's first non-empty row. */
  const composerLine = (screen: string) =>
    screen.split("\n").filter((line) => /^\s*┃/.test(line)).map((line) => line.replace(/^\s*┃/, "").trim()).find((line) => line !== "")

  it("hints the context keys in the footer", async () => {
    const { tui } = await start()
    expect(tui.screen()).toContain("ctrl+k Search  ctrl+s Summary  ctrl+] Next tab  ? Keys")
    await tui.type("!")
    await tui.until((screen) => screen.includes("enter Run command  esc Cancel"), 5_000, "shell hints")
  }, 60_000)

  it("opens from the empty composer, dispatches a listed key, and closes", async () => {
    const { tui } = await start()
    await tui.press("?")
    const shown = await tui.until(popup, 5_000, "which-key popup")
    expect(shown).toMatch(/ctrl\+\]\/ctrl\+right\s+Next tab/)

    // A listed binding is a real dispatch: Ctrl+K opens the palette.
    await tui.press(key.ctrlK)
    await tui.until((screen) => !popup(screen) && screen.includes("Search"), 5_000, "palette from which-key")
    await tui.press(key.escape)

    await tui.press("?")
    await tui.until(popup, 5_000, "which-key reopen")
    await tui.press(key.escape)
    await tui.until((screen) => !popup(screen), 5_000, "which-key close on esc")
    await tui.press("?")
    await tui.until(popup, 5_000, "which-key reopen")
    await tui.press("?")
    const closed = await tui.until((screen) => !popup(screen), 5_000, "which-key close on ?")
    expect(composerLine(closed)).not.toContain("?")
  }, 60_000)

  it("keeps a message that starts with ?", async () => {
    const { tui } = await start()
    await tui.press("?")
    await tui.until(popup, 5_000, "which-key popup")
    await tui.type("why")
    const typed = await tui.until((screen) => !popup(screen) && composerLine(screen)?.startsWith("?why") === true, 5_000, "typed question")
    expect(composerLine(typed)).toStartWith("?why")
    // Mid-draft, ? is text.
    await tui.type("?")
    await tui.until((screen) => composerLine(screen)?.startsWith("?why?") === true, 5_000, "literal ?")
  }, 60_000)
})

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

describe("tabs", () => {
  it("switches Chat and Summary by clicking a tab title", async () => {
    const { tui } = await start()
    await tui.click("Summary")
    await tui.until((screen) => screen.includes("esc Chat"), 5_000, "summary focused footer")
    await tui.click("Chat")
    await tui.until((screen) => !screen.includes("esc Chat") && screen.includes("ctrl+k Search"), 5_000, "chat footer")
  }, 60_000)

  it("cycles tabs with ctrl+] and ctrl+\\", async () => {
    const { tui } = await start()
    await tui.press(key.ctrlBracket)
    await tui.until((screen) => screen.includes("esc Chat"), 5_000, "summary after ctrl+]")
    await tui.press(key.ctrlBracket)
    await tui.until((screen) => !screen.includes("esc Chat") && screen.includes("ctrl+k Search"), 5_000, "chat after ctrl+]")
    await tui.press(key.ctrlBackslash)
    await tui.until((screen) => screen.includes("esc Chat"), 5_000, "summary after ctrl+\\")
  }, 60_000)
})

describe("esc", () => {
  it("interrupts a running agent turn and returns to idle", async () => {
    const { tui } = await start({ holdMs: 60_000 })
    await tui.type("node check.mjs fails. Fix it and show it passes.")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("esc Interrupt") && /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \d/.test(screen), 10_000, "running turn")
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
    await tui.until((screen) => /[▾▸⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] +\d+  /.test(screen), 20_000, "first cell")
    await tui.until((screen) => idle(screen) && /Fixed/.test(screen), 120_000, "answer")
    expect(readFileSync(join(cwd, "math.js"), "utf8")).toContain("a + b")
    const following = await tui.until(screen => screen.includes("⏸") && knob(screen) > 0, 5_000, "recorded timeline")
    await tui.press("\x14")
    await tui.until(screen => screen.includes("▶"), 5_000, "timeline paused")
    await tui.press("\x1b[H")
    await tui.until(screen => knob(screen) < knob(following), 5_000, "first journal position")
    await tui.press("\x1b[F")
    await tui.press("\x13")
    // 40 columns clip the footer hints; Escape clearing these rows proves the panel had focus.
    await tui.until(screen => /›\s+\d+ /.test(screen), 5_000, "summary keyboard focus")
    await tui.press(key.escape)
    await tui.until(screen => !/›\s+\d+ /.test(screen) && screen.includes("▶"), 5_000, "summary handles Escape and restores the chat timeline")
    await tui.press(key.escape)
    // Typing right behind Escape reads as alt+key, so wait for the timeline to follow live again.
    await tui.until(screen => screen.includes("⏸"), 5_000, "timeline follows live")
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

  it("settles a turn and keeps working when the session file stops accepting writes", async () => {
    const { tui, sessions } = await start({ holdMs: 1_000 })
    await tui.type("node check.mjs fails. Fix it and show it passes.")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("esc Interrupt"), 10_000, "running turn")
    const folder = join(sessions, readdirSync(sessions)[0]!)
    chmodSync(join(folder, readdirSync(folder).find((name) => name.endsWith(".jsonl"))!), 0o444)
    await tui.until((screen) => screen.includes("Session not saved: EACCES"), 10_000, "unsaved record")
    await tui.until((screen) => idle(screen) && /Fixed/.test(screen), 90_000, "answer")
    await tui.type("second prompt after the failed write")
    await tui.press(key.enter)
    await tui.until(
      (screen) => screen.includes("esc Interrupt") && screen.includes("second prompt after the failed write"),
      10_000,
      "second turn"
    )
    await tui.press(key.escape)
    await tui.until((screen) => screen.includes("✗ Stopped") && idle(screen), 10_000, "second turn stopped")
  }, 120_000)

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
    await tui.until(drawn, 20_000, "first draw")
    await tui.press(key.ctrlK)
    await tui.type("session:")
    await tui.until((screen) => /Search[\s\S]*_[0-9a-f]{8}-/.test(screen), 5_000, "session row")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Resumed") && screen.includes("remembered-output"), 5_000, "resumed")
  }, 90_000)
})

describe("timeline scrubber", () => {
  /** A real worker session: 20 frames, an edit pin, and the verdict. */
  const restored = (cols: number) => {
    const cwd = repository()
    const sessions = mkdtempSync(join(tmpdir(), "tui-sessions-"))
    process.env.SMITHERS_TUI_SESSION_DIR = sessions
    mkdirSync(Session.directory(cwd), { recursive: true })
    writeFileSync(join(Session.directory(cwd), "2026-09-23T20-05-36-811Z_timeline.jsonl"),
      readFileSync(join(app, "test", "fixtures", "timeline-worker.jsonl")))
    return start({ cwd, sessions, args: "-c", cols })
  }

  it("a click on a milestone jumps the chat to its numbered step; keys step and esc follows live", async () => {
    const { tui } = await restored(120)
    const screen = await tui.until((screen) => screen.includes("approvals.ts") && screen.includes("Pause"), 15_000, "scrubber")
    const rows = screen.split("\n")
    const row = rows.findIndex((line) => line.includes("approvals.ts") && !line.includes("┃"))
    const column = rows[row]!.indexOf("approvals.ts")
    await tui.press(`\x1b[<0;${column + 2};${row + 1}M\x1b[<0;${column + 2};${row + 1}m`)
    const jumped = await tui.until((screen) => /▾ 10\s+patched approvals\.ts/.test(screen), 5_000, "jumped to step 10")
    expect(jumped).toContain("Implementing")
    expect(jumped).toContain("▶ Live")
    await tui.press("\x1b[D")
    await tui.until((screen) => /▾ \s?9\s/.test(screen) || /▾ \s?8\s/.test(screen), 5_000, "previous step")
    await tui.press("]")
    await tui.until((screen) => screen.includes("patched approvals.ts"), 5_000, "next milestone")
    await tui.press(key.escape)
    await tui.until((screen) => screen.includes("⏸ Pause") && screen.includes("Done"), 5_000, "following live")
  }, 60_000)

  it("stays inside a narrow terminal", async () => {
    const { tui } = await restored(40)
    const screen = await tui.until((screen) => screen.includes("⏸") && screen.includes("●"), 15_000, "narrow scrubber")
    for (const line of screen.split("\n")) expect([...line.trimEnd()].length).toBeLessThanOrEqual(40)
  }, 60_000)
})

describe("new session", () => {
  it("starts with no filter, queued follow-up or form left from the last session", async () => {
    const { tui } = await start()
    await tui.type("!echo alpha-row")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("alpha-row") && screen.includes("exit 0") || /alpha-row[\s\S]*alpha-row/.test(screen), 10_000, "shell row")
    await tui.type("/grep no-such-text")
    await tui.press(key.enter)
    await tui.until((screen) => !screen.includes("alpha-row"), 5_000, "filtered away")
    await tui.type("/new")
    await tui.press(key.enter)
    await tui.type("!echo beta-row")
    await tui.press(key.enter)
    await tui.until((screen) => /beta-row[\s\S]*beta-row/.test(screen), 10_000, "new session shows its rows")
  }, 60_000)
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
    await tui.until((screen) => screen.includes("esc Interrupt"), 20_000, "turn running")
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
    await tui.until(drawn, 20_000, "first draw")
    await tui.type("investigate")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Investigation · running") && !screen.includes("esc Interrupt"), 5_000, "worker")
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
      await tui.until((screen) => screen.includes("enter Expand row") && screen.includes("Asked:"), 5_000, "summary")
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
    await started.tui.until((screen) => screen.includes("u Undo changes") && screen.includes("Asked:"), 5_000, "summary")
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
    await tui.until((screen) => screen.includes("Undid math.js") && !screen.includes("u Undo changes"), 5_000, "chat note")
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
    await tui.until((screen) => screen.includes("esc Interrupt"), 10_000, "running turn")
    await tui.press(key.ctrlS)
    await tui.until((screen) => screen.includes("u Undo changes"), 5_000, "summary")
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
    await tui.until(drawn, 20_000, "first draw")
    await tui.type("delegate fix")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Fixer · done"), 10_000, "worker done")
    expect(readFileSync(join(cwd, "math.js"), "utf8")).toContain("a + b")
    await tui.press(key.ctrlK)
    await tui.type("tab:fix")
    await tui.until((screen) => screen.includes("Search") && /Fixer\s+done/.test(screen), 5_000, "tab row")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("u Undo changes"), 5_000, "worker tab")
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

  it("estimates a new worker from the finished one, shows it on the tab, and a coordinator turn answers ETA through tab.eta", async () => {
    const cwd = repository()
    const sessions = mkdtempSync(join(tmpdir(), "tui-estimate-"))
    tui = await Tui.start({
      cwd,
      command: `bun ${join(app, "e2e", "workspace-fixture.tsx")}`,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SMITHERS_TUI_SESSION_DIR: sessions }
    })
    await tui.until(drawn, 20_000, "first draw")
    await tui.type("delegate fix")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Fixer · done"), 10_000, "worker done")
    await tui.type("investigate")
    await tui.press(key.enter)
    // The only history is a worker that took milliseconds, so the new one is soon past its estimate.
    await tui.until((screen) => /Investigation\s+late/.test(screen), 10_000, "estimate on the tab")
    await tui.type("what is the ETA on all tasks")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("ETA investigation:running:class"), 30_000, "tab.eta answer")
    const folder = join(sessions, readdirSync(sessions)[0]!)
    const ledger = readFileSync(join(folder, "evals", "estimates.jsonl"), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line))
    expect(ledger.filter((entry) => entry.type === "observation" && entry.observation.kind === "delegate")).toHaveLength(1)
    expect(ledger.filter((entry) => entry.type === "prediction" && entry.prediction.kind === "delegate"))
      .toMatchObject([{ prediction: { method: "class", subject: "Investigation\nInvestigate the failing check." } }])
    // Chat turns are measured too: every settled turn is on record.
    expect(ledger.filter((entry) => entry.type === "observation" && entry.observation.kind === "turn").length)
      .toBeGreaterThanOrEqual(2)
  }, 60_000)

  it("undo refuses while a project flow is active", async () => {
    const cwd = repository()
    tui = await Tui.start({
      cwd,
      command: `bun ${join(app, "e2e", "workspace-fixture.tsx")}`,
      env: { PATH: process.env.PATH!, HOME: process.env.HOME!, SMITHERS_TUI_SESSION_DIR: join(cwd, "sessions") }
    })
    await tui.until(drawn, 20_000)
    await tui.type("delegate fix")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Requested the fix.") && screen.includes("Fixer · done"))
    await tui.type("/flow review title=x")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("review · running"))
    await tui.type("/tabs")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("r Resume") && screen.includes("u Undo changes"), 5_000, "worker footer")
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
      await tui.until(drawn, 20_000, "first draw")
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
    await tui.until(drawn, 20_000, "first draw")
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
      (screen) => screen.includes("r Resume") && screen.includes("x Stop") && screen.includes("Investigation · running"),
      5_000,
      "inspect running worker"
    )
    await tui.type("x")
    await tui.until((screen) => screen.includes("Investigation · cancelled"), 5_000, "actual worker settlement")
    await tui.press(key.escape)
    await tui.until((screen) => screen.includes("Still here.") && !screen.includes("r Resume"), 5_000, "escape returns to chat")
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
    await tui.until(drawn, 20_000, "first draw")
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
    await tui.until((screen) => screen.includes("r Resume") && screen.includes("x Stop"), 5_000, "flow tab footer")
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
    await tui.until((screen) => screen.includes("r Resume") && screen.includes("x Stop"), 5_000, "flow tab footer")
    await tui.type("a")
    await tui.until((screen) => /┃\s+Title/.test(screen), 5_000, "form reopened")
    await tui.press(ctrlRight)
    await tui.type("again")
    await tui.until((screen) => /┃\s+again/.test(screen), 5_000, "composer after Ctrl+Right")
    expect(tui.screen()).not.toContain("cancelled")
    expect(tui.screen()).toContain("◌ review")
  }, 60_000)

  it("a run parked on its form never blocks /new", async () => {
    const { tui } = await open()
    await tui.type("/flow review")
    await tui.press(key.enter)
    await tui.until((screen) => /┃\s+Title/.test(screen), 5_000, "form")
    await tui.press(key.escape)
    await tui.until((screen) => screen.includes("◌ review · input"), 5_000, "parked toast")
    await tui.type("/new")
    await tui.press(key.enter)
    const screen = await tui.until(
      (screen) => screen.includes("New session started") || screen.includes("Stop running work first"),
      5_000,
      "new session"
    )
    expect(screen).toContain("New session started")
  }, 60_000)

  it("/smithers opens a Smithers tab that closes once the user moves on", async () => {
    const { tui } = await open()
    const tabBar = (screen: string) => screen.split("\n").find((line) => line.includes("Chat  Summary")) ?? ""
    expect(tabBar(tui.screen())).not.toContain("Smithers")
    await tui.type("/smithers")
    await tui.press(key.enter)
    await tui.until((screen) => tabBar(screen).includes("Smithers") && screen.includes("1 flows · 0 active"), 5_000, "smithers tab")
    await tui.press(key.ctrlBracket)
    const chat = await tui.until((screen) => !screen.includes("1 flows · 0 active"), 5_000, "chat after ctrl+]")
    expect(tabBar(chat)).not.toContain("Smithers")
  }, 30_000)

  it("offers the directory's flows in the / menu", async () => {
    const { tui } = await open()
    await tui.type("/rev")
    await tui.until((screen) => screen.includes("/flow review") && screen.includes("Review a change"), 5_000, "flow in menu")
  }, 30_000)
})

describe("custom agents", () => {
  /** A scratch repository holding the example agent, `examples/custom-agent/flows/review/flow.mdx`. */
  const withAgent = () => {
    const cwd = repository()
    cpSync(join(app, "examples", "custom-agent", "flows"), join(cwd, "flows"), { recursive: true })
    return cwd
  }

  it("/agent review x opens a review tab and the composer still takes input", async () => {
    const { tui } = await start({ cwd: withAgent(), holdMs: 2_000 })
    await tui.type("/agent review look at math.js")
    await tui.press(key.escape)
    await tui.press(key.enter)
    await tui.until((screen) => /◌ review: look at/.test(screen), 20_000, "agent tab")
    await tui.type("still here")
    await tui.until((screen) => /┃\s+still here/.test(screen), 5_000, "composer usable while the agent runs")
    // The toast follows the run until it really stops; x in the tab asks it to.
    await tui.until((screen) => /review: look at math.js · running/.test(screen), 5_000, "running toast")
    await tui.press(key.ctrlBracket)
    await tui.press(key.ctrlBracket)
    await tui.until((screen) => screen.includes("r Resume"), 5_000, "agent tab")
    await tui.type("x")
    await tui.until((screen) => /■ review: look at/.test(screen), 20_000, "stopped from the real outcome")
  }, 120_000)

  it("/agent lists agents with their seat; choosing one puts its prompt field in the composer", async () => {
    const { tui } = await start({ cwd: withAgent() })
    await tui.type("/agent")
    await tui.press(key.escape)
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Agents") && /review\s+GPT-6 Sol\s+Reviews the uncommitted/.test(screen), 20_000, "agents dialog")
    await tui.press(key.enter)
    await tui.until((screen) => /┃\s+\/agent review\s*$/m.test(screen), 5_000, "prompt prefilled")
  }, 60_000)

  it("refuses an unknown agent with one line and keeps chat usable", async () => {
    const { tui } = await start({ cwd: withAgent() })
    // The first listing settles in the background; after it, the refusal is synchronous.
    await Bun.sleep(1_500)
    await tui.type("/agent nobody do it")
    await tui.press(key.escape)
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("No agent named nobody"), 10_000, "typed refusal")
  }, 60_000)
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
    const asked = (screen: string) => screen.includes("fs:write:/**") && screen.includes("n deny")
    const launched = await started.tui.until((screen) => asked(screen) || screen.includes("✗ consequential"), 30_000, "approval row")
    if (!asked(launched)) {
      // A launch failure never asks; its reason is on the flow's tab.
      await started.tui.click("✗ consequential")
      throw new Error(`consequential failed before asking:\n${await started.tui.until((screen) => screen.includes("· failed"), 5_000, "flow tab")}`)
    }
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
    await tui.until(drawn, 20_000)
    await tui.type("run")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("? bash true") && screen.includes("n deny"))
    await tui.press(key.ctrlS)
    // The approval owns the keys, so the footer advertises it over the panel.
    await tui.until((screen) => screen.includes("Asked: run") && screen.includes("n Deny"))
    await tui.press("n")
    await Bun.sleep(600)
    expect(tui.screen()).not.toContain("? bash true")
    const folder = join(cwd, "sessions", readdirSync(join(cwd, "sessions"))[0]!)
    const file = join(folder, readdirSync(folder).find((name) => name.endsWith(".jsonl"))!)
    const outcome = Session.load(file).findLast((record) => record.type === "outcome")
    expect(outcome).toMatchObject({ type: "outcome", outcome: { answer: "Choice: deny" } })
  }, 60_000)

  it("a focused panel's a sends its action to the agent as text, never granting an approval or running a shell", async () => {
    const cwd = repository()
    tui = await Tui.start({
      cwd,
      command: `bun ${join(app, "e2e", "panel-action-fixture.tsx")}`,
      env: { PATH: process.env.PATH!, HOME: process.env.HOME!, SMITHERS_TUI_SESSION_DIR: join(cwd, "sessions") }
    })
    await tui.until(drawn, 20_000)
    await tui.type("publish")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Actions") && screen.includes("n deny"), 10_000, "panel and approval")
    for (let index = 0; index < 4 && !tui.screen().includes("One action."); index++) {
      await tui.press("\x1b[1;5C")
      await Bun.sleep(200)
    }
    await tui.until((screen) => screen.includes("One action.") && screen.includes("n deny") && !screen.includes("a all bash"), 5_000, "panel focused")
    await Bun.sleep(600)
    await tui.press("a")
    await tui.until((screen) => screen.includes("a all bash"), 5_000, "panel released")
    for (let index = 0; index < 4 && !tui.screen().includes("steering"); index++) {
      await tui.press("\x1b[1;5D")
      await Bun.sleep(200)
    }
    await tui.until((screen) => /┃\s+!touch pwned/.test(screen) && screen.includes("steering"), 5_000, "action sent as a message")
    await Bun.sleep(500)
    expect(readFileSync(join(cwd, "host.log"), "utf8")).not.toContain("reply")
    expect(existsSync(join(cwd, "pwned"))).toBe(false)
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
    const { tui, cwd, sessions } = await start({ approve: "ask" })
    await tui.type(prompt)
    await tui.press(key.enter)
    await tui.until((screen) => asking.test(screen), 60_000, "first approval")
    await tui.press("n")
    const folder = join(sessions, readdirSync(sessions)[0]!)
    const file = join(folder, readdirSync(folder).find((name) => name.endsWith(".jsonl"))!)
    await tui.until(() => Session.load(file).some((record) =>
      record.type === "event" && record.event._tag === "cell-call-settled" &&
      record.event.result.code === "capability_refused" && record.event.result.message?.startsWith("Denied:")
    ), 10_000, "denial receipt")
    // The recording repeats after a refusal. Stop once the real denial is durable.
    await tui.press(key.escape)
    const screen = await tui.until(idle, 10_000, "stopped replay")
    expect(screen).not.toMatch(/┃[ \t]+n[ \t]*$/m)
    expect(readFileSync(join(cwd, "math.js"), "utf8")).toBe("export const add = (a, b) => a - b\n")
    await tui.press(key.ctrlO)
    await tui.until((screen) => screen.includes("Denied"), 10_000, "denied call")
  }, 90_000)

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

  it("print mode never hangs: it runs every call by default and denies when told", () => {
    const run = (approve: string | undefined, args: ReadonlyArray<string> = []) => {
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
      const result = spawnSync("bun", [join(app, "src", "main.tsx"), cwd, "-p", prompt, ...args], {
        env,
        encoding: "utf8",
        // The replay seat keeps replaying after a denial until the 40-frame
        // budget ends the run: about 80 s at speed 20. A hang never ends.
        timeout: 150_000
      })
      return { ...result, ms: Date.now() - started, math: readFileSync(join(cwd, "math.js"), "utf8") }
    }
    const allowed = run(undefined)
    expect(allowed.signal).toBeNull()
    expect(allowed.stderr).not.toMatch(/denied (bash|edit)/)
    expect(allowed.math).toContain("a + b")
    const denied = run(undefined, ["--approve", "deny"])
    expect(denied.signal).toBeNull()
    expect(denied.stderr).toMatch(/denied (bash|edit)/)
    expect(denied.math).toContain("a - b")
    const refused = run("ask")
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain("SMITHERS_TUI_APPROVE=ask needs the interactive TUI")
    expect(refused.ms).toBeLessThan(10_000)
  }, 400_000)
})

describe("transcript scrolling", () => {
  /** An SGR mouse report: button code, 1-based column and row, press or release. */
  const mouse = (button: number, column: number, row: number, release = false) =>
    `\x1b[<${button};${column};${row}${release ? "m" : "M"}`
  const fill = async (tui: Tui) => {
    for (const block of ["b1", "b2", "b3"]) {
      await tui.type(`!seq -f '${block}-%g' 1 40`)
      await tui.press(key.enter)
      await tui.until((screen) => screen.includes(`${block}-40`), 10_000, `${block} output`)
    }
    expect(tui.screen()).not.toContain("b2-24")
  }

  it("scrolls up under the mouse wheel", async () => {
    const { tui } = await start()
    await fill(tui)
    for (let tick = 0; tick < 12; tick++) await tui.press(mouse(64, 20, 10))
    await tui.until((screen) => screen.includes("b2-24") && !screen.includes("b3-40"), 5_000, "scrolled transcript")
  }, 60_000)

  it("scrolls up while a selection is dragged above the transcript", async () => {
    const { tui } = await start()
    await fill(tui)
    await tui.press(mouse(0, 5, 14))
    await tui.press(mouse(32, 5, 8))
    await tui.press(mouse(32, 5, 1))
    await tui.until((screen) => screen.includes("$ seq -f 'b1-%g' 1 40"), 5_000, "autoscrolled transcript")
    await tui.press(mouse(0, 5, 1, true))
  }, 60_000)
})

describe("monitors", () => {
  const update = "CI: Build failed on main."
  const watch = async (notable: boolean) => {
    const cwd = repository()
    const sessions = join(cwd, "sessions")
    tui = await Tui.start({
      cwd,
      command: `bun ${join(app, "e2e", "monitor-fixture.tsx")}`,
      env: {
        PATH: process.env.PATH!,
        HOME: process.env.HOME!,
        SMITHERS_TUI_SESSION_DIR: sessions,
        MONITOR_NOTABLE: notable ? "1" : "0"
      }
    })
    await tui.until(drawn, 20_000, "first draw")
    await tui.type("watch the build")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Watching the build."), 10_000, "acknowledgement")
    const log = join(cwd, "judged.log")
    const judged = () => {
      try {
        return readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { verdict: boolean; done: boolean })
      } catch {
        return []
      }
    }
    for (let attempt = 0; attempt < 200 && !judged().some((entry) => entry.done); attempt++) await Bun.sleep(50)
    expect(judged().some((entry) => entry.done)).toBe(true)
    const folder = join(sessions, readdirSync(sessions)[0]!)
    const file = join(folder, readdirSync(folder).find((name) => name.endsWith(".jsonl"))!)
    const updates = () => Session.load(file).filter((record) => record.type === "monitor-update")
    return { tui, judged, updates }
  }

  it("delivers a notable change as one toast and one chat row", async () => {
    const { tui, updates } = await watch(true)
    const screen = await tui.until((screen) => screen.includes(update), 10_000, "monitor update")
    // Once in the toast, once as the chat row.
    expect(screen.split(update).length - 1).toBe(2)
    await Bun.sleep(3_000)
    expect(updates()).toEqual([expect.objectContaining({ type: "monitor-update", id: "ci", text: "Build failed on main." })])
    expect(tui.screen().split(update).length - 1).toBeLessThanOrEqual(2)
  }, 60_000)

  it("delivers nothing when Jev calls the change routine", async () => {
    const { tui, judged, updates } = await watch(false)
    // The monitors plugin shows the active monitor in the footer.
    await tui.until((screen) => screen.includes("◉ CI"), 5_000, "monitor status item")
    await Bun.sleep(3_000)
    expect(judged().every((entry) => !entry.verdict)).toBe(true)
    expect(tui.screen()).not.toContain("Build failed on main.")
    expect(updates()).toEqual([])
  }, 60_000)
})

describe("extensions", () => {
  const altR = "\x1br"
  /** A repository flow whose `metadata.tui` key requests a durable run of itself. */
  const reviewFlow = [
    "---",
    "description: Reviews the uncommitted change and returns a verdict.",
    "metadata:",
    "  tui:",
    "    keys:",
    "      - key: alt+r",
    "        label: Review",
    "        action: { kind: flow, flow: review }",
    "    status: true",
    "    card: true",
    "---",
    "Review the uncommitted change.",
    ""
  ].join("\n")

  /** A repository holding `reviewFlow`, read by the real registry. */
  const open = async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tui-extensions-"))
    mkdirSync(join(cwd, "flows", "review"), { recursive: true })
    const mdx = join(cwd, "flows", "review", "flow.mdx")
    writeFileSync(mdx, reviewFlow)
    tui = await Tui.start({
      cwd,
      cols: 120,
      command: `bun ${join(app, "e2e", "extensions-fixture.tsx")}`,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        SMITHERS_TUI_SESSION_DIR: mkdtempSync(join(tmpdir(), "tui-extensions-sessions-")),
        SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY ??
          join(process.env.HOME ?? "", "smithers", "target", "release", "smithers-jj-export")
      }
    })
    await tui.until(drawn, 20_000, "first draw")
    return { tui, mdx }
  }

  it("a metadata.tui key requests the flow; card, status and toast settle only with the run; chat stays usable", async () => {
    const { tui } = await open()
    await tui.until((screen) => screen.includes("alt+r Review"), 10_000, "contributed key hint")
    await tui.press(altR)
    await tui.until((screen) => screen.includes("◌ review") && screen.includes("review · Running."), 5_000, "tab and card")
    await tui.until((screen) => screen.includes("review · running"), 5_000, "running toast")
    await tui.until((screen) => /◌ review\s+↑/.test(screen), 5_000, "status item")
    // Chat answers while the run is unresolved.
    await tui.type("hello")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Still here."), 5_000, "chat answered while the run runs")
    expect(tui.screen()).toContain("review · running")
    await tui.type("finish")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("review · done") && screen.includes("review · Approved."), 5_000, "settled")
    await tui.until((screen) => /✓ review\s+↑/.test(screen), 5_000, "settled status item")
  }, 60_000)

  it("a cell's card and status item show in place, and a row action runs from its view", async () => {
    const { tui } = await open()
    await tui.type("plan release")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Release plan · Two steps left.") && screen.includes("✓ Changelog"), 5_000, "card")
    await tui.until((screen) => screen.includes("CI ✓"), 5_000, "status item")
    await tui.click("Release plan")
    await tui.until((screen) => screen.includes("3 ▸ Publish"), 5_000, "card view")
    await tui.press(key.down)
    await tui.press(key.down)
    await tui.until((screen) => screen.includes("a Publish"), 5_000, "the row's action")
    await tui.type("a")
    await tui.until((screen) => screen.includes("review · running"), 5_000, "row action requested the flow")
  }, 60_000)

  it("tab focuses the newest card from an empty composer and enter opens its view", async () => {
    const { tui } = await open()
    await tui.type("plan release")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("Release plan · Two steps left."), 5_000, "card")
    await tui.press(key.tab)
    await tui.until((screen) => screen.includes("enter Open") && screen.includes("esc Composer"), 5_000, "card focused")
    await tui.press(key.enter)
    await tui.until((screen) => screen.includes("3 ▸ Publish") && screen.includes("esc Chat"), 5_000, "card view")
    await tui.press(key.escape)
    await tui.until((screen) => screen.includes("ctrl+k Search"), 5_000, "back in chat")
    await tui.press(key.tab)
    await tui.until((screen) => screen.includes("enter Open"), 5_000, "focused again")
    await tui.press(key.escape)
    await tui.until((screen) => screen.includes("ctrl+k Search") && !screen.includes("enter Open"), 5_000, "composer again")
  }, 60_000)

  it("a metadata.tui key on a markdown flow starts a real durable run that settles", async () => {
    // The real Flows.Port: registry discovery, the control plane's plan, approval, launch and watch.
    const cwd = mkdtempSync(join(tmpdir(), "tui-extensions-real-"))
    mkdirSync(join(cwd, "flows", "ping"), { recursive: true })
    writeFileSync(join(cwd, "flows", "ping", "flow.mdx"), [
      "---",
      "description: Answers Pong.",
      "model: openai:gpt-6-sol",
      "metadata:",
      "  tui:",
      "    keys:",
      "      - key: alt+p",
      "        label: Ping",
      "        action: { kind: flow, flow: ping }",
      "    status: true",
      "---",
      "Answer Pong.",
      ""
    ].join("\n"))
    tui = await Tui.start({
      cwd,
      cols: 120,
      command: `bun ${join(app, "e2e", "real-flows-fixture.tsx")}`,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        SMITHERS_TUI_SESSION_DIR: mkdtempSync(join(tmpdir(), "tui-extensions-sessions-")),
        SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY ??
          join(process.env.HOME ?? "", "smithers", "target", "release", "smithers-jj-export")
      }
    })
    await tui.until(drawn, 20_000, "first draw")
    await tui.until((screen) => screen.includes("alt+p Ping"), 20_000, "contributed key hint")
    await tui.press("\x1bp")
    await tui.until((screen) => screen.includes("ping · running"), 20_000, "running toast")
    await tui.until((screen) => screen.includes("ping · done") && /✓ ping\s+↑/.test(screen), 90_000, "settled from the real run")
  }, 150_000)

  it("hot-reloads an edited flow.mdx and lists a colliding key as a problem", async () => {
    const { tui, mdx } = await open()
    await tui.until((screen) => screen.includes("alt+r Review"), 10_000, "contributed key hint")
    writeFileSync(mdx, readFileSync(mdx, "utf8").replace("label: Review", "label: Recheck"))
    await tui.until((screen) => screen.includes("alt+r Recheck"), 5_000, "reloaded label")
    writeFileSync(mdx, readFileSync(mdx, "utf8").replace("key: alt+r", "key: ctrl+c"))
    await tui.until((screen) => screen.includes("✗ 1 extension"), 5_000, "problem status item")
    expect(tui.screen()).not.toContain("Recheck")
    await tui.click("✗ 1 extension")
    await tui.until((screen) => screen.includes("review: ctrl+c is the built-in Clear key"), 5_000, "problem view")
  }, 60_000)
})
