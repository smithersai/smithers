import { describe, expect, it } from "bun:test"
import * as Complete from "../src/complete.ts"
import * as Editor from "../src/editor.ts"
import * as Palette from "../src/palette.ts"
import type { Tab } from "../src/workspace.ts"

const files = ["README.md", "src/app.tsx", "src/view.tsx", "test/app.test.ts", "docs/my notes.md"]
const tab = (id: string, title: string, status: Tab["status"]): Tab => ({
  id, title, status, prompt: "p", seat: "s", file: `${id}.jsonl`, startedAt: 0
})
const sessions = [
  { file: "/s/b.jsonl", name: "Fix the build", firstPrompt: "fix it", modified: 1_000 },
  { file: "/s/a.jsonl", name: undefined, firstPrompt: "add a view\nsecond line", modified: 500 }
]
const sources: Palette.Sources = {
  commands: Editor.commands,
  files: () => files,
  sessions,
  tabs: [tab("w1", "Investigation", "running"), tab("w2", "Docs pass", "done")],
  hits: [{ path: "math.js", line: 1, text: "  export const add = (a, b) => a - b" }],
  now: 2_000
}
const rows = (raw: string, extra: Partial<Palette.Sources> = {}) => Palette.rows(Palette.parse(raw), { ...sources, ...extra })

describe("parse", () => {
  it("reads the first token as the mode, like the web palette", () => {
    expect(Palette.parse("")).toMatchObject({ mode: "all", query: "" })
    expect(Palette.parse("/res")).toMatchObject({ mode: "commands", query: "res" })
    expect(Palette.parse("text:a - b")).toEqual({ mode: "text", prefix: "text:", query: "a - b" })
    expect(Palette.parse("text:/a.+b/")).toMatchObject({ mode: "text", regex: "a.+b" })
    expect(Palette.parse("session:fix")).toMatchObject({ mode: "sessions", query: "fix" })
    expect(Palette.parse("tab:w1")).toMatchObject({ mode: "tabs", query: "w1" })
    expect(Palette.parse("?")).toMatchObject({ mode: "help" })
    expect(Palette.parse("  text:x")).toMatchObject({ mode: "text", query: "x" })
    expect(Palette.parse("notes: hi")).toMatchObject({ mode: "all", query: "notes: hi" })
  })
})

describe("rows", () => {
  it("lists commands before files, ranks files by name, and caps files", () => {
    const all = rows("")
    expect(all[0]).toMatchObject({ label: "/model", value: { kind: "command", name: "model" } })
    const firstFile = all.findIndex((row) => row.value.kind === "file")
    expect(all.slice(0, firstFile).every((row) => row.value.kind === "command")).toBe(true)
    const view = rows("view").filter((row) => row.value.kind === "file")
    expect(view[0]?.value).toEqual({ kind: "file", path: "src/view.tsx" })
    const many = Array.from({ length: 50 }, (_, index) => `f${index}.ts`)
    expect(rows("f", { files: () => many }).filter((row) => row.value.kind === "file")).toHaveLength(Complete.fileLimit)
  })

  it("offers only commands after /", () => {
    const commands = rows("/")
    expect(commands.length).toBe(Editor.commands.length)
    expect(commands.every((row) => row.value.kind === "command")).toBe(true)
    expect(rows("/rsm").map((row) => row.label)).toEqual(["/resume"])
  })

  it("lists rg hits as path:line with the line text", () => {
    expect(rows("text:a - b")).toEqual([
      { key: "hit:math.js:1", label: "math.js:1", detail: "export const add = (a, b) => a - b", value: { kind: "hit", path: "math.js", line: 1 } }
    ])
  })

  it("filters worker tabs by title and status", () => {
    expect(rows("tab:inv").map((row) => row.value)).toEqual([{ kind: "tab", id: "w1" }])
    expect(rows("tab:done").map((row) => row.label)).toEqual(["Docs pass"])
    expect(rows("tab:")[0]).toMatchObject({ label: "Investigation", hint: "running" })
  })

  it("lists sessions exactly as /resume does", () => {
    const listed = rows("session:")
    expect(listed.map((row) => row.value)).toEqual([{ kind: "session", file: "/s/b.jsonl" }, { kind: "session", file: "/s/a.jsonl" }])
    expect(listed.map((row) => row.label)).toEqual(Palette.sessionRows(sessions, "", 2_000).map((row) => row.label))
    expect(listed.map((row) => row.label)).toEqual(["Fix the build", "add a view"])
    expect(rows("session:view").map((row) => row.label)).toEqual(["add a view"])
    expect(rows("session:", { sessions: undefined })).toEqual([])
  })

  it("lists the prefixes after ?", () => {
    expect(rows("?").map((row) => row.value)).toEqual([
      { kind: "prefix", prefix: "/" },
      { kind: "prefix", prefix: "text:" },
      { kind: "prefix", prefix: "session:" },
      { kind: "prefix", prefix: "tab:" }
    ])
  })
})

describe("mentions", () => {
  it("writes @path and @path:line, quoting paths with spaces", () => {
    expect(Palette.mention("src/a.ts", 12)).toBe("@src/a.ts:12 ")
    expect(Palette.mention("docs/my notes.md")).toBe('@"docs/my notes.md" ')
  })

  it("inserts at the cursor with a separating space, merging a trailing one", () => {
    expect(Palette.insertAt("look at", 7, "@x ")).toEqual({ text: "look at @x ", cursor: 11 })
    expect(Palette.insertAt("", 0, "@x ")).toEqual({ text: "@x ", cursor: 3 })
    expect(Palette.insertAt("a  b", 2, "@x ")).toEqual({ text: "a @x b", cursor: 5 })
  })
})
