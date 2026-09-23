/** Bash capture in a git repository: the VCS's own before/after, relative to the working directory. */
import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import * as Changes from "../src/changes.ts"

const sh = (cwd: string, ...command: string[]) => {
  const result = Bun.spawnSync(command, { cwd, stdout: "ignore", stderr: "ignore" })
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed`)
}
const repository = (commit = true) => {
  const cwd = mkdtempSync(join(tmpdir(), "tui-capture-"))
  sh(cwd, "git", "init", "-q")
  if (commit) {
    writeFileSync(join(cwd, "root.ts"), "root\n")
    mkdirSync(join(cwd, "sub"))
    writeFileSync(join(cwd, "sub", "tracked.ts"), "one\n")
    sh(cwd, "git", "add", "-A")
    sh(cwd, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init")
  }
  return cwd
}
/** Runs one captured bash call whose body is `effect`, from `cwd`. */
const bash = async (cwd: string, effect: () => void): Promise<ReadonlyArray<Changes.Receipt>> => {
  const receipts: Array<Changes.Receipt> = []
  const source = {
    name: "test",
    bindings: () => Effect.succeed([{ descriptor: { name: "bash" }, run: () => Effect.sync(() => (effect(), { outcome: "success" })) }])
  } as unknown as Parameters<typeof Changes.capture>[0]
  const [binding] = await Effect.runPromise(Changes.capture(source, cwd, (receipt) => receipts.push(receipt)).bindings())
  await Effect.runPromise(
    binding!.run({ flowName: "bash", input: { command: "x" }, identity: { session: "t", frame: 1, ordinal: 0 } } as never)
  )
  return receipts
}

describe("bash capture under git", () => {
  it("names tracked and untracked changes relative to a subdirectory working directory", async () => {
    const root = repository()
    const cwd = join(root, "sub")
    const receipts = await bash(cwd, () => {
      writeFileSync(join(cwd, "tracked.ts"), "two\n")
      writeFileSync(join(cwd, "new.ts"), "fresh\n")
    })
    expect(receipts).toHaveLength(1)
    const paths = receipts[0]!.patches.map((patch) => patch.path).sort()
    expect(paths).toEqual(["new.ts", "tracked.ts"])
    const tracked = receipts[0]!.patches.find((patch) => patch.path === "tracked.ts")!.patch
    expect(tracked).toContain("-one")
    expect(tracked).toContain("+two")
  }, 20_000)

  it("attributes only the call's own change when hundreds of files were already dirty", async () => {
    const cwd = repository()
    for (let index = 0; index < 300; index++) writeFileSync(join(cwd, `dirty-${index}.txt`), `${index}\n`)
    writeFileSync(join(cwd, "root.ts"), "edited before the call\n")
    const receipts = await bash(cwd, () => writeFileSync(join(cwd, "root.ts"), "edited by the call\n"))
    expect(receipts[0]!.patches.map((patch) => patch.path)).toEqual(["root.ts"])
    expect(receipts[0]!.patches[0]!.patch).toContain("-edited before the call")
    expect(receipts[0]!.patches[0]!.patch).toContain("+edited by the call")
  }, 20_000)

  it("captures a repository with no commit yet", async () => {
    const cwd = repository(false)
    const receipts = await bash(cwd, () => writeFileSync(join(cwd, "first.ts"), "hello\n"))
    expect(receipts[0]!.patches.map((patch) => patch.path)).toEqual(["first.ts"])
  }, 20_000)

  it("records an empty receipt for a call that changed nothing, and none outside a repository", async () => {
    expect((await bash(repository(), () => {}))[0]!.patches).toEqual([])
    expect(await bash(mkdtempSync(join(tmpdir(), "tui-capture-")), () => {})).toEqual([])
  }, 20_000)
})
