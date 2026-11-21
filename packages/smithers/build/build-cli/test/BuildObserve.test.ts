/**
 * `scripts/build-observe.mjs`, the build of `//packages/smithers/build/build-cli:observe`, where no zig can build
 * `smthrs-observe`: Windows has no zig archive to fetch, and the target still declares `native/out`.
 */
import * as NodeFs from "node:fs"
import * as Os from "node:os"
import * as Path from "node:path"
import { describe, expect, it } from "vitest"
import { buildObserve, notBuilt } from "../scripts/build-observe.mjs"

const noZig = "zig 0.17.1 is not installed, and a build fetches it only on x86_64 or aarch64 Linux or macOS"

describe("buildObserve where no zig can build", () => {
  // Smithers build refuses a declared output directory that is empty (PackageRunner: "did not produce declared
  // outputs"), so `native/out` must hold a file even where nothing was built.
  it("leaves native/out holding only why nothing was built, so the target has its declared output", () => {
    const root = NodeFs.mkdtempSync(Path.join(Os.tmpdir(), "smthrs-observe-none-"))
    try {
      const lines: Array<string> = []
      const built = buildObserve({
        root,
        named: undefined,
        required: false,
        log: (line: string) => lines.push(line),
        find: () => ({ problem: noZig })
      })
      expect(built).toEqual([])
      expect(NodeFs.readdirSync(Path.join(root, "native", "out"))).toEqual([notBuilt])
      expect(NodeFs.readFileSync(Path.join(root, "native", "out", notBuilt), "utf8"))
        .toBe(`smthrs-observe not built: ${noZig}\n`)
      expect(lines).toEqual([`smthrs-observe not built: ${noZig}; reads are recorded with strace`])
    } finally {
      NodeFs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("drops the note when a later build has a zig, so native/out never says both", () => {
    const root = NodeFs.mkdtempSync(Path.join(Os.tmpdir(), "smthrs-observe-later-"))
    try {
      buildObserve({ root, named: undefined, required: false, log: () => {}, find: () => ({ problem: noZig }) })
      const zig = Path.join(root, "no-such-zig")
      expect(() => buildObserve({ root, named: undefined, required: false, log: () => {}, find: () => ({ zig }) }))
        .toThrow("smthrs-observe: zig cc -target x86_64-linux-musl failed")
      expect(NodeFs.existsSync(Path.join(root, "native", "out", notBuilt))).toBe(false)
    } finally {
      NodeFs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("fails and builds nothing when the build is required", () => {
    const root = NodeFs.mkdtempSync(Path.join(Os.tmpdir(), "smthrs-observe-required-"))
    try {
      expect(() =>
        buildObserve({ root, named: undefined, required: true, log: () => {}, find: () => ({ problem: noZig }) })
      )
        .toThrow(`smthrs-observe: ${noZig}`)
      expect(NodeFs.existsSync(Path.join(root, "native"))).toBe(false)
    } finally {
      NodeFs.rmSync(root, { recursive: true, force: true })
    }
  })
})
