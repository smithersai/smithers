import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import * as Context from "../src/context.ts"
import * as Editor from "../src/editor.ts"
import * as Replay from "../src/replay.ts"
import * as Session from "../src/session.ts"
import * as Shell from "../src/shell.ts"
import * as Steering from "../src/steering.ts"

describe("History", () => {
  it("walks back from the newest prompt, returns the draft past the newest, and skips a repeat", () => {
    const history = new Editor.History(["one", "two", "two"])
    expect(history.up("draft")).toBe("two")
    expect(history.up("two")).toBe("one")
    expect(history.up("one")).toBeUndefined()
    expect(history.down()).toBe("two")
    expect(history.down()).toBe("draft")
    expect(history.browsing).toBe(false)
  })

  it("keeps the newest 100 prompts", () => {
    const history = new Editor.History(Array.from({ length: 120 }, (_, index) => `p${index}`))
    let oldest: string | undefined
    for (let step = 0; step < 200; step++) oldest = history.up("") ?? oldest
    expect(oldest).toBe("p20")
  })
})

describe("commands", () => {

  it("parses a command and its argument", () => {
    expect(Editor.parseCommand("/model  gpt 6 ")).toEqual({ name: "model", argument: "gpt 6" })
    expect(Editor.parseCommand("/new")).toEqual({ name: "new", argument: "" })
  })

  it("cycles reasoning effort through every level and back to the provider default", () => {
    const seen: Array<Editor.Thinking> = []
    let level: Editor.Thinking = undefined
    do {
      level = Editor.nextThinking(level)
      seen.push(level)
    } while (level !== undefined)
    expect(seen).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", undefined])
  })

  it("formats token counts like pi's footer", () => {
    expect([950, 1234, 45_000, 1_234_567].map(Editor.tokens)).toEqual(["950", "1.2k", "45k", "1.2M"])
  })
})

describe("shell", () => {
  it("tells !, !! and prose apart", () => {
    expect(Shell.parse("!ls -la")).toEqual({ command: "ls -la", excluded: false })
    expect(Shell.parse("!! git status")).toEqual({ command: "git status", excluded: true })
    expect(Shell.parse("fix it!")).toBeUndefined()
  })

  it("strips escapes and normalizes carriage returns", () => {
    expect(Shell.clean("\x1b[31mred\x1b[0m\r\nnext\rover")).toBe("red\nnext\nover")
  })

  it("keeps the tail within pi's line limit", () => {
    const text = Array.from({ length: Shell.maxLines + 5 }, (_, index) => `line ${index}`).join("\n")
    const kept = Shell.tail(text)
    expect(kept.truncated).toBe(true)
    expect(kept.text.split("\n")).toHaveLength(Shell.maxLines)
    expect(kept.text.endsWith(`line ${Shell.maxLines + 4}`)).toBe(true)
  })

  it("writes pi's context template", () => {
    expect(Shell.contextText({ command: "ls", output: "a\nb", exitCode: 0, cancelled: false })).toBe("Ran `ls`\n```\na\nb\n```")
    expect(Shell.contextText({ command: "false", output: "", exitCode: 1, cancelled: false })).toBe(
      "Ran `false`\n```\n(no output)\n```\n\nCommand exited with code 1"
    )
    expect(Shell.contextText({ command: "sleep 9", output: "", exitCode: null, cancelled: true })).toContain(
      "(command cancelled)"
    )
  })

  it("runs in the working directory and reports a nonzero exit", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tui-shell-"))
    writeFileSync(join(cwd, "marker"), "")
    const streamed: Array<string> = []
    const result = await Shell.run({ command: "ls; exit 3", cwd, onOutput: (text) => streamed.push(text) }).done
    expect(result).toMatchObject({ output: "marker", exitCode: 3, cancelled: false })
    expect(streamed.join("")).toContain("marker")
  })

  it("cancels the whole process group", async () => {
    const running = Shell.run({ command: "sleep 30", cwd: tmpdir(), onOutput: () => {} })
    setTimeout(running.cancel, 100)
    const started = Date.now()
    const result = await running.done
    expect(result.cancelled).toBe(true)
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})

describe("context", () => {
  it("reads the first instruction file per directory, outermost first, after the global one", () => {
    const home = mkdtempSync(join(tmpdir(), "tui-home-"))
    mkdirSync(join(home, ".smithers", "agent"), { recursive: true })
    writeFileSync(join(home, ".smithers", "agent", "AGENTS.md"), "global")
    const root = mkdtempSync(join(tmpdir(), "tui-context-"))
    const nested = join(root, "a", "b")
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(root, "CLAUDE.md"), "root")
    writeFileSync(join(root, "a", "AGENTS.md"), "a")
    writeFileSync(join(root, "a", "CLAUDE.md"), "shadowed")
    const files = Context.instructionFiles(nested, home)
    expect(files[0]).toBe(join(home, ".smithers", "agent", "AGENTS.md"))
    expect(files.slice(-2)).toEqual([join(root, "CLAUDE.md"), join(root, "a", "AGENTS.md")])
  })

  it("tells the next turn about earlier exchanges and shell commands", () => {
    const [, ...rest] = Context.system("/nowhere-at-all", [
      { kind: "exchange", user: "fix it", answer: "fixed" },
      { kind: "shell", text: "Ran `ls`\n```\na\n```" }
    ])
    expect(rest.at(-1)).toContain("User: fix it\nYou answered: fixed")
    expect(rest.at(-1)).toContain("User ran a shell command:\nRan `ls`")
  })
})

describe("steering", () => {
  it("delivers a steer once per boundary and hands back what no boundary took", async () => {
    const queue = Steering.make()
    queue.steer("check the tests")
    const first = await Effect.runPromise(queue.source.drain({ boundary: "b1", wouldIdle: false }))
    const again = await Effect.runPromise(queue.source.drain({ boundary: "b1", wouldIdle: false }))
    expect(first.inserts).toHaveLength(1)
    expect(again).toMatchObject({ duplicate: true })
    expect(again.inserts).toEqual(first.inserts)
    queue.steer("late")
    expect(queue.take()).toEqual(["late"])
    expect(queue.take()).toEqual([])
  })
})

describe("sessions", () => {
  it("rebuilds the screen, the agent's context and the prompt history from the file", () => {
    process.env.SMITHERS_TUI_SESSION_DIR = mkdtempSync(join(tmpdir(), "tui-sessions-"))
    const writer = Session.create("/work/repo")
    const result = { command: "ls", output: "a", exitCode: 0, cancelled: false }
    writer.append({ type: "name", name: "fixing add" })
    writer.append({ type: "user", at: 1, text: "fix add" })
    writer.append({ type: "outcome", at: 2, prompt: "fix add", outcome: { _tag: "done", answer: "fixed" } })
    writer.append({ type: "shell", at: 3, result, excluded: false })
    writer.append({ type: "shell", at: 4, result: { ...result, command: "secret" }, excluded: true })
    const [summary] = Session.list("/work/repo")
    expect(summary).toMatchObject({ file: writer.file, name: "fixing add", firstPrompt: "fix add" })
    const restored = Session.restore(Session.load(writer.file))
    expect(restored.name).toBe("fixing add")
    expect(restored.prompts).toEqual(["fix add", "!ls", "!!secret"])
    expect(restored.entries).toEqual([
      { kind: "exchange", user: "fix add", answer: "fixed" },
      { kind: "shell", text: Shell.contextText(result) }
    ])
    expect(restored.transcript.items.map((item) => item.kind)).toEqual(["user", "shell", "shell"])
  })
})

describe("replay", () => {
  it("splits a recording into one reply per model call, each ending in its settlement", () => {
    const recorded = readFileSync(join(import.meta.dir, "fixtures", "fix-add.jsonl"), "utf8")
    const replies = Replay.replies(recorded)
    const calls = recorded.trim().split("\n").filter((line) => JSON.parse(line).event._tag === "model-requested").length
    expect(replies).toHaveLength(calls)
    expect(replies.every((reply) => reply.at(-1)?.delta.type === "settle")).toBe(true)
  })
})
