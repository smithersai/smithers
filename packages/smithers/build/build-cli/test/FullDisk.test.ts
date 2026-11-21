/** A full disk under a build's machines: when a machine target's failure is the build's own. */
import * as NodeFs from "node:fs"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { buildsOwn, fullLine, heldUnder, isFull, sizeOf, spaceOf } from "../src/internal/FullDisk.ts"

const made: Array<string> = []
afterAll(() => {
  for (const root of made) {
    NodeFs.chmodSync(root, 0o700)
    NodeFs.rmSync(root, { recursive: true, force: true })
  }
})
const scratch = (): string => {
  const root = NodeFs.mkdtempSync(Path.join(Os.tmpdir(), "full-disk-"))
  made.push(root)
  return root
}
const gb = (n: number): number => n * 1_000_000_000

/** Machines `a` (1 MB) and `b` (2 MB) under one directory. */
const machines = (): { readonly kept: string; readonly a: string; readonly b: string } => {
  const kept = scratch()
  const a = Path.join(kept, "a")
  const b = Path.join(kept, "b")
  NodeFs.mkdirSync(Path.join(a, "tmp"), { recursive: true })
  NodeFs.mkdirSync(Path.join(b, "home"), { recursive: true })
  NodeFs.writeFileSync(Path.join(a, "tmp", "file"), "x".repeat(1_000_000))
  NodeFs.writeFileSync(Path.join(b, "home", "file"), "x".repeat(2_000_000))
  return { kept, a, b }
}

describe("a disk", () => {
  it("is full under 1 GB free, or under 1% of it when that is more", () => {
    expect(isFull({ free: gb(0.9), total: gb(50) })).toBe(true)
    expect(isFull({ free: gb(1.1), total: gb(50) })).toBe(false)
    expect(isFull({ free: gb(15), total: gb(2000) })).toBe(true)
  })

  it("has a size and free space where a directory is, and none where there is no directory", async () => {
    const space = await spaceOf(Os.tmpdir())
    expect(space!.total).toBeGreaterThan(0)
    expect(space!.free).toBeLessThanOrEqual(space!.total)
    expect(await spaceOf("/no/such/directory")).toBeUndefined()
  })

  it("is written as a person reads a size", () => {
    expect(sizeOf(gb(47.4))).toBe("47 GB")
    expect(sizeOf(gb(0.04))).toBe("0 GB")
    expect(sizeOf(-1)).toBe("0 GB")
  })

  it("counts each file under a directory once, and nothing it cannot read", async () => {
    const root = scratch()
    NodeFs.writeFileSync(Path.join(root, "a"), "x".repeat(100_000))
    NodeFs.linkSync(Path.join(root, "a"), Path.join(root, "b"))
    NodeFs.mkdirSync(Path.join(root, "closed"))
    NodeFs.writeFileSync(Path.join(root, "closed", "c"), "x".repeat(100_000))
    NodeFs.chmodSync(Path.join(root, "closed"), 0o000)
    const held = await heldUnder(root)
    NodeFs.chmodSync(Path.join(root, "closed"), 0o700)
    expect(held).toBeGreaterThanOrEqual(100_000)
    expect(held).toBeLessThan(200_000)
    expect(await heldUnder(Path.join(root, "missing"))).toBe(0)
  })
})

describe("a machine target that failed", () => {
  const full = async () => ({ free: gb(0.2), total: gb(100) })

  it("failed for the build when the disk is full and the other machines hold more than its own", async () => {
    const { kept, a, b } = machines()
    const line = await buildsOwn(kept, a, [b], full)
    expect(line).toMatch(
      new RegExp(
        `^the disk that holds this build's machines \\(${kept}\\) is full, 0.2 GB free: its 2 machines hold ` +
          "0 GB, this target's 0 GB, so the target did not fail on its own\\. Run fewer jobs at once \\(--jobs\\) " +
          "or free some space$"
      )
    )
    expect(fullLine("/m", { free: gb(0.2), total: gb(100) }, 3, gb(47), gb(2))).toBe(
      "the disk that holds this build's machines (/m) is full, 0.2 GB free: its 3 machines hold 47 GB, this " +
        "target's 2 GB, so the target did not fail on its own. Run fewer jobs at once (--jobs) or free some space"
    )
  })

  it("failed on its own when its machine holds the most, when the disk has room, or when the host does not say", async () => {
    const { kept, a, b } = machines()
    expect(await buildsOwn(kept, b, [a], full)).toBeUndefined()
    expect(await buildsOwn(kept, a, [b], async () => ({ free: gb(50), total: gb(100) }))).toBeUndefined()
    expect(await buildsOwn(kept, a, [b], async () => undefined)).toBeUndefined()
    // The host's own answer, where the disk has room.
    expect(await buildsOwn(kept, a, [b])).toBeUndefined()
  })
})
