import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { replay } from "../src/index.ts"
import { trace } from "./support/Generate.ts"

/**
 * The kernel against the Lean reference.
 *
 * `fixtures/reference.json` holds, for each seed, the SHA-256 of what the
 * reference binary printed for that seed's random trace
 * (`scripts/reference.ts` writes it). This suite replays the same traces
 * through the kernel and compares digests, so it needs no Lean toolchain.
 * Where the reference binary is built, it also compares fresh traces line by
 * line.
 */

const fixture: { readonly firstSeed: number; readonly length: number; readonly digests: ReadonlyArray<string> } = JSON
  .parse(readFileSync(new URL("./fixtures/reference.json", import.meta.url), "utf8"))

const digest = (lines: ReadonlyArray<string>): string =>
  createHash("sha256").update(lines.map((line) => line + "\n").join("")).digest("hex")

describe("the kernel prints what the Lean reference printed", () => {
  it("has a digest for every seed", () => {
    expect(fixture.digests).toHaveLength(400)
  })

  it("agrees with the reference on every recorded random trace", () => {
    const differing = fixture.digests.flatMap((expected, index) => {
      const seed = fixture.firstSeed + index
      return digest(replay(trace(seed, fixture.length))) === expected ? [] : [seed]
    })
    // To see a difference line by line: `node scripts/differential.ts 1 <length> <seed>`.
    expect(differing).toEqual([])
  })
})

const reference = fileURLToPath(new URL("../lean/.lake/build/bin/reference", import.meta.url))

describe.skipIf(!existsSync(reference))("the kernel against a freshly built reference binary", () => {
  it("agrees line by line on traces outside the recorded seeds", () => {
    const seeds = Array.from({ length: 150 }, (_, index) => 100_000 + index)
    const lines = seeds.flatMap((seed) => trace(seed, 160))
    const ran = spawnSync(reference, { input: lines.join("\n") + "\n", encoding: "utf8", maxBuffer: 1 << 30 })
    expect(ran.status).toBe(0)
    const expected = ran.stdout.split("\n").slice(0, -1)
    const actual = replay(lines)
    expect(actual).toHaveLength(expected.length)
    const first = actual.findIndex((line, index) => line !== expected[index])
    expect(first === -1 ? "agree" : `line ${first}: ${lines[first]}\n${expected[first]}\n${actual[first]}`).toBe(
      "agree"
    )
  })
})
