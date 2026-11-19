/**
 * The directory a confined run with too many declared files is given: what
 * it holds, how its files are made, and that it is removed however the run
 * ends. Real files throughout; a failing host operation is passed in.
 */
import type * as ProcessSandbox from "@smthrs/platform-node/ProcessSandbox"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as ExecStage from "../src/internal/ExecStage.ts"

let temporary = ""
let previous: string | undefined
beforeEach(() => {
  previous = process.env["TMPDIR"]
  temporary = NodeFs.realpathSync(NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "smthrs-exec-stage-")))
  process.env["TMPDIR"] = NodePath.join(temporary, "tmp")
  NodeFs.mkdirSync(NodePath.join(temporary, "tmp"))
})
afterEach(() => {
  if (previous === undefined) delete process.env["TMPDIR"]
  else process.env["TMPDIR"] = previous
  NodeFs.rmSync(temporary, { recursive: true, force: true })
})

/** What a stage left in the temporary directory. */
const left = (): ReadonlyArray<string> => NodeFs.readdirSync(NodePath.join(temporary, "tmp"))

const until = async (condition: () => boolean): Promise<void> => {
  for (let waited = 0; waited < 20_000 && !condition(); waited += 50) await delay(50)
  expect(condition()).toBe(true)
}

/** A workspace with sources, an installed tree, an output, a hidden entry and two links, and its plan. */
const workspace = (scratch: boolean): ProcessSandbox.Plan => {
  const root = NodePath.join(temporary, "ws")
  const file = (path: string, text: string) => {
    NodeFs.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true })
    NodeFs.writeFileSync(NodePath.join(root, path), text)
  }
  file("src/a.ts", "a\n")
  file("src/deep/b.ts", "b\n")
  NodeFs.chmodSync(NodePath.join(root, "src/deep/b.ts"), 0o755)
  NodeFs.utimesSync(NodePath.join(root, "src/deep/b.ts"), new Date(1_000_000_000), new Date(1_000_000_000))
  file("src/.env", "SECRET=1\n")
  file("node_modules/dep/index.js", "dep\n")
  file("dist/old.js", "old\n")
  file("dist/kept.d.ts", "kept\n")
  NodeFs.mkdirSync(NodePath.join(root, "restored"))
  const at = (path: string) => NodePath.join(root, path)
  return {
    mechanism: { _tag: "bubblewrap", executable: "/usr/bin/bwrap" },
    network: "none",
    workspaceRoot: root,
    cwd: at("src"),
    reads: [
      root,
      "/usr/share",
      at("src/a.ts"),
      at("src/deep/b.ts"),
      at("src/.env"),
      at("node_modules"),
      at("dist/kept.d.ts")
    ],
    links: [
      { path: at("src/link.ts"), target: "a.ts" },
      { path: at("node_modules/.bin/tool"), target: "../dep/index.js" }
    ],
    readDenies: [],
    writes: [at("dist"), at("out/new"), "/elsewhere"],
    readOnly: [],
    externalReads: [],
    hidden: { prefixes: [".env"], paths: [at("src/.env")], restored: [at("restored")] },
    ...(scratch ? { scratch: true } : {}),
    tmp: NodePath.join(temporary, "run"),
    uid: process.getuid?.(),
    gid: process.getgid?.()
  }
}

const inStage = (prepared: ExecStage.Prepared, plan: ProcessSandbox.Plan, path: string): string =>
  NodePath.join(prepared.stage.directory, NodePath.relative(plan.workspaceRoot, path))

describe.skipIf(process.platform === "win32")("a stage", () => {
  it("holds hard links to the declared files, mount points for every other bind, and the unbound links", () => {
    const plan = workspace(false)
    const prepared = ExecStage.prepare(plan)
    const at = (path: string) => NodePath.join(plan.workspaceRoot, path)
    expect(prepared.stage.writable).toBe(false)
    expect(prepared.stage.files).toEqual([at("src/a.ts"), at("src/deep/b.ts")])
    expect(prepared.stage.links).toEqual([at("src/link.ts")])
    expect(NodeFs.statSync(inStage(prepared, plan, at("src/a.ts"))).ino).toBe(NodeFs.statSync(at("src/a.ts")).ino)
    expect(NodeFs.readlinkSync(inStage(prepared, plan, at("src/link.ts")))).toBe("a.ts")
    // Every other bind finds an empty place to mount on; nothing it covers is in the directory.
    expect(NodeFs.readdirSync(inStage(prepared, plan, at("node_modules")))).toEqual([])
    // A declared file inside an output is bound before the output is, so it too needs a place to mount on.
    expect(NodeFs.readdirSync(inStage(prepared, plan, at("dist")))).toEqual(["kept.d.ts"])
    expect(NodeFs.readFileSync(inStage(prepared, plan, at("dist/kept.d.ts")), "utf8")).toBe("")
    expect(NodeFs.statSync(inStage(prepared, plan, at("out/new"))).isDirectory()).toBe(true)
    expect(NodeFs.readFileSync(inStage(prepared, plan, at("src/.env")), "utf8")).toBe("")
    expect(NodeFs.statSync(inStage(prepared, plan, at("restored"))).isDirectory()).toBe(true)
    expect(NodeFs.existsSync(NodePath.join(prepared.stage.directory, "usr"))).toBe(false)
    expect(NodeFs.existsSync(NodePath.join(prepared.stage.directory, "elsewhere"))).toBe(false)
    expect(left()).toHaveLength(1)
    prepared.release()
    expect(left()).toEqual([])
    // The workspace's files are where they were.
    expect(NodeFs.readFileSync(at("src/a.ts"), "utf8")).toBe("a\n")
  })

  it("needs no links or hidden entries", () => {
    const { hidden: _hidden, links: _links, ...plan } = workspace(false)
    const prepared = ExecStage.prepare(plan)
    // With no entry hidden, a declared .env is a declared file like any other.
    expect(prepared.stage.files.map((path) => NodePath.basename(path))).toEqual(["a.ts", "b.ts", ".env"])
    expect(prepared.stage.links).toEqual([])
    expect(NodeFs.existsSync(inStage(prepared, plan, NodePath.join(plan.workspaceRoot, "restored")))).toBe(false)
    prepared.release()
  })

  it("holds copies the run may not write under a scratch layer, with each file's times", () => {
    const plan = workspace(true)
    const prepared = ExecStage.prepare(plan)
    const source = NodePath.join(plan.workspaceRoot, "src/deep/b.ts")
    const copy = NodeFs.statSync(inStage(prepared, plan, source))
    expect(prepared.stage.writable).toBe(true)
    expect(copy.ino).not.toBe(NodeFs.statSync(source).ino)
    expect(copy.mode & 0o777).toBe(0o555)
    expect(copy.mtimeMs).toBe(1_000_000_000)
    prepared.release()
  })

  it("copies a file it cannot link", () => {
    const plan = workspace(false)
    const prepared = ExecStage.prepare(plan, {
      ...ExecStage.liveIo,
      link: () => {
        throw Object.assign(new Error("cross-device link"), { code: "EXDEV" })
      }
    })
    const source = NodePath.join(plan.workspaceRoot, "src/deep/b.ts")
    const copy = NodeFs.statSync(inStage(prepared, plan, source))
    expect(copy.ino).not.toBe(NodeFs.statSync(source).ino)
    expect(copy.mode & 0o777).toBe(0o755)
    prepared.release()
  })

  it("removes what it made when making it fails, and says why", () => {
    const plan = workspace(true)
    expect(() =>
      ExecStage.prepare(plan, {
        ...ExecStage.liveIo,
        copy: () => {
          throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" })
        }
      })
    ).toThrow("no space left on device")
    expect(left()).toEqual([])
  })

  it("leaves removal to the reaper when the program cannot remove it", async () => {
    const prepared = ExecStage.prepare(workspace(false), {
      ...ExecStage.liveIo,
      remove: () => {
        throw Object.assign(new Error("busy"), { code: "EBUSY" })
      }
    })
    expect(left()).toHaveLength(1)
    prepared.release()
    await until(() => left().length === 0)
  })
})

describe.skipIf(process.platform === "win32")("the reaper", () => {
  it("removes the directory once it is told to stop", async () => {
    const directory = NodePath.join(temporary, "tmp", "held")
    NodeFs.mkdirSync(directory)
    NodeFs.writeFileSync(NodePath.join(directory, "file"), "x")
    const stop = ExecStage.reaper(directory)
    await delay(200)
    expect(NodeFs.existsSync(directory)).toBe(true)
    stop()
    await until(() => !NodeFs.existsSync(directory))
  })

  it("is no failure when it cannot start", async () => {
    const stop = ExecStage.reaper(NodePath.join(temporary, "tmp"), NodePath.join(temporary, "no-shell"))
    await delay(200)
    stop()
    expect(NodeFs.existsSync(NodePath.join(temporary, "tmp"))).toBe(true)
  })
})

describe("a command's length", () => {
  it("is too long past bubblewrap's argument limit or the byte limit", () => {
    expect(ExecStage.exceeds(Array.from({ length: 9_000 }, () => "a"))).toBe(false)
    expect(ExecStage.exceeds(Array.from({ length: 9_001 }, () => "a"))).toBe(true)
    expect(ExecStage.exceeds(["bwrap", "x".repeat(ExecStage.maximumCommandBytes)])).toBe(true)
  })
})

describe.skipIf(process.platform === "win32")("rendering a command", () => {
  const long = Array.from({ length: 9_001 }, () => "--ro-bind")

  it("stages nothing for a command that fits, or a mechanism other than bubblewrap", () => {
    const plan = workspace(false)
    expect(ExecStage.render(plan, () => ({ argv: ["bwrap"] }))).toEqual({ wrapped: { argv: ["bwrap"] } })
    const seatbelt = { ...plan, mechanism: { _tag: "seatbelt", executable: "/usr/bin/sandbox-exec" } } as const
    expect(ExecStage.render(seatbelt, () => ({ argv: long }))).toEqual({ wrapped: { argv: long } })
    expect(left()).toEqual([])
  })

  it("renders a long command again over a stage, which the caller releases", () => {
    const seen: Array<ProcessSandbox.Stage | undefined> = []
    const rendered = ExecStage.render(workspace(false), (plan) => {
      seen.push(plan.stage)
      return { argv: plan.stage === undefined ? long : ["bwrap"] }
    })
    expect(rendered.wrapped.argv).toEqual(["bwrap"])
    expect(seen[0]).toBeUndefined()
    expect(seen[1]).toEqual(rendered.prepared!.stage)
    expect(left()).toHaveLength(1)
    rendered.prepared!.release()
    expect(left()).toEqual([])
  })

  it("refuses a command still too long once staged, and removes the stage", () => {
    expect(() => ExecStage.render(workspace(false), () => ({ argv: long }))).toThrow(
      /still has 9001 arguments once its files are gathered in one directory; bubblewrap accepts 9000/
    )
    expect(left()).toEqual([])
  })
})
