/**
 * The cache evidence policy: which modes have a complete contract, how a run
 * gets its evidence, and what one failed confined attempt is remembered as.
 */
import { Smithers as S } from "@smthrs/targets"
import type * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as CacheEvidence from "../src/internal/CacheEvidence.ts"

const temporary: Array<string> = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const workspace = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-cache-evidence-")))
  temporary.push(root)
  return root
}

const node = {
  rule: "Vitest",
  attrs: {},
  sandbox: undefined,
  mechanism: undefined,
  services: 0,
  installed: undefined,
  cache: undefined
} as const

describe("rules", () => {
  it("covers the test runners, the type checker and the linter, and nothing that writes", () => {
    expect([...CacheEvidence.rules].sort()).toEqual(["EsLint", "NodeTest", "Typecheck", "Vitest"])
  })
})

describe("incomplete", () => {
  it("names the modes whose products are not declared outputs", () => {
    expect(CacheEvidence.incomplete("Typecheck", { buildMode: true, incremental: false })).toContain("build info")
    expect(CacheEvidence.incomplete("Typecheck", { buildMode: false, incremental: true })).toContain("build info")
    expect(CacheEvidence.incomplete("Typecheck", { buildMode: false, incremental: false })).toBeUndefined()
    expect(CacheEvidence.incomplete("EsLint", { fix: true })).toContain("rewrites its sources")
    expect(CacheEvidence.incomplete("EsLint", { fix: false })).toBeUndefined()
    // The flags mean nothing on a rule that does not have them.
    expect(CacheEvidence.incomplete("Vitest", { fix: true, buildMode: true })).toBeUndefined()
  })
})

describe("decide", () => {
  it("confines a run the way the workspace declares, and attempts one where confinement is off", () => {
    expect(CacheEvidence.decide(node)).toEqual({ mode: "declared" })
    expect(CacheEvidence.decide({ ...node, mechanism: S.Sandbox.Bubblewrap() })).toEqual({ mode: "declared" })
    expect(CacheEvidence.decide({ ...node, mechanism: S.Sandbox.None() })).toEqual({ mode: "attempt" })
    expect(CacheEvidence.decide({ ...node, sandbox: {} })).toEqual({ mode: "declared" })
    expect(CacheEvidence.decide({ ...node, sandbox: { network: false } })).toEqual({ mode: "declared" })
    expect(CacheEvidence.isEvidence(CacheEvidence.decide(node))).toBe(true)
  })

  it("says why a result is never reused", () => {
    const reason = (override: Partial<Parameters<typeof CacheEvidence.decide>[0]>): string => {
      const decision = CacheEvidence.decide({ ...node, ...override })
      expect(CacheEvidence.isEvidence(decision)).toBe(false)
      return CacheEvidence.isEvidence(decision) ? "" : decision.reason
    }
    expect(reason({ rule: "EsLint", attrs: { fix: true } })).toContain("fix mode")
    expect(reason({ installed: "the installed tree node_modules could not be identified: EACCES" })).toContain(
      "could not be identified"
    )
    expect(reason({ sandbox: "none" })).toContain("sandbox: \"none\"")
    expect(reason({ sandbox: { network: true } })).toContain("opens the network")
    expect(reason({ sandbox: { network: "loopback" } })).toContain("opens the network")
    expect(reason({ services: 1 })).toContain("services")
    // The declaration's own opt-out comes first: such a target runs exactly as the workspace declares.
    expect(reason({ cache: false })).toBe("the target declares cache: false")
    expect(reason({ cache: false, rule: "EsLint", attrs: { fix: true } })).toBe("the target declares cache: false")
  })
})

const request: ExecSandbox.Request = {
  policy: undefined,
  reads: ["src/b.ts", "src/a.ts"],
  links: [{ path: "node_modules/tool", target: ".pnpm/tool/node_modules/tool" }],
  writes: [".flows"],
  writeFiles: ["out.txt"],
  externalReads: ["/opt/tool"]
}

describe("declarationIdentity", () => {
  it("is one value for one declaration, in any order, and moves with each part of it", () => {
    const identity = CacheEvidence.declarationIdentity("//pkg:test", "Vitest", request)
    expect(identity).toMatch(/^[0-9a-f]{64}$/)
    expect(CacheEvidence.declarationIdentity("//pkg:test", "Vitest", { ...request, reads: ["src/a.ts", "src/b.ts"] }))
      .toBe(identity)
    const differs = (label: string, rule: string, override: Partial<ExecSandbox.Request>): void => {
      expect(CacheEvidence.declarationIdentity(label, rule, { ...request, ...override })).not.toBe(identity)
    }
    differs("//other:test", "Vitest", {})
    differs("//pkg:test", "NodeTest", {})
    differs("//pkg:test", "Vitest", { policy: {} })
    differs("//pkg:test", "Vitest", { reads: ["src/a.ts", "src/b.ts", "src/c.ts"] })
    differs("//pkg:test", "Vitest", { links: undefined })
    differs("//pkg:test", "Vitest", { writes: [] })
    differs("//pkg:test", "Vitest", { writeFiles: undefined })
    differs("//pkg:test", "Vitest", { externalReads: undefined })
  })
})

describe("a remembered failed attempt", () => {
  it("answers for a day and then lets the run be attempted again", async () => {
    const root = await workspace()
    const identity = "a".repeat(64)
    expect(await CacheEvidence.attemptFailed(root, ".flows", identity)).toBe(false)
    const at = 1_800_000_000_000
    await CacheEvidence.rememberFailedAttempt(
      root,
      ".flows",
      identity,
      { label: "//pkg:test", denied: ["pkg/data.json is outside the declared read set"], output: ["FAIL\n"] },
      at
    )
    const file = CacheEvidence.attemptPath(root, ".flows", identity)
    expect(file).toBe(Path.join(root, ".flows", "evidence", `${identity}.json`))
    expect(JSON.parse(await Fs.readFile(file, "utf8"))).toEqual({
      format: "smthrs-confined-attempt/1",
      at,
      label: "//pkg:test",
      denied: ["pkg/data.json is outside the declared read set"],
      output: ["FAIL\n"]
    })
    expect(await CacheEvidence.attemptFailed(root, ".flows", identity, at)).toBe(true)
    expect(await CacheEvidence.attemptFailed(root, ".flows", identity, at + CacheEvidence.attemptMemoryMs - 1)).toBe(
      true
    )
    expect(await CacheEvidence.attemptFailed(root, ".flows", identity, at + CacheEvidence.attemptMemoryMs)).toBe(false)
    // A record from the future is a clock that moved, not a fact.
    expect(await CacheEvidence.attemptFailed(root, ".flows", identity, at - 1)).toBe(false)
    // The host clock: remembered now, it answers now.
    await CacheEvidence.rememberFailedAttempt(root, ".flows", identity, { label: "//pkg:test", denied: [], output: [] })
    expect(await CacheEvidence.attemptFailed(root, ".flows", identity)).toBe(true)
  })

  it.each([
    ["text that is not JSON", "{"],
    ["a value that is not an object", "7"],
    ["null", "null"],
    ["another format", JSON.stringify({ format: "other/1", at: 1 })],
    ["a time that is not a number", JSON.stringify({ format: "smthrs-confined-attempt/1", at: "1" })]
  ])("ignores %s", async (_name, text) => {
    const root = await workspace()
    const identity = "b".repeat(64)
    await Fs.mkdir(Path.join(root, ".flows", "evidence"), { recursive: true })
    await Fs.writeFile(CacheEvidence.attemptPath(root, ".flows", identity), text)
    expect(await CacheEvidence.attemptFailed(root, ".flows", identity, 1)).toBe(false)
  })

  it("fails to remember where the record cannot be published, and leaves no temporary file", async () => {
    const root = await workspace()
    const identity = "c".repeat(64)
    // A directory where the record belongs: the rename cannot replace it.
    await Fs.mkdir(CacheEvidence.attemptPath(root, ".flows", identity), { recursive: true })
    await expect(
      CacheEvidence.rememberFailedAttempt(root, ".flows", identity, { label: "//pkg:test", denied: [], output: [] })
    ).rejects.toThrow()
    expect(await Fs.readdir(Path.join(root, ".flows", "evidence"))).toEqual([`${identity}.json`])
  })
})

describe("deniedLines", () => {
  it("names each closed path once, from plain or rendered text, up to the limit", () => {
    const text = [
      "FAIL test/a.test.ts",
      "sandbox: pkg/data.json is outside the declared read set",
      "sandbox: pkg/data.json is outside the declared read set",
      "  sandbox: pkg/out.txt is outside the declared write set",
      "sandbox: pkg/dist was denied inside the declared set",
      "sandbox: bubblewrap, network none, 4 read path(s), 1 write path(s)"
    ]
    const expected = [
      "pkg/data.json is outside the declared read set",
      "pkg/out.txt is outside the declared write set",
      "pkg/dist was denied inside the declared set"
    ]
    expect(CacheEvidence.deniedLines(text.join("\n"))).toEqual(expected)
    // A rendered failure writes its line breaks as two characters, and ends the field with a quote.
    expect(CacheEvidence.deniedLines(`{"stderr":"${text.join("\\n")}"}`)).toEqual(expected)
    expect(CacheEvidence.deniedLines(text.join("\n"), 2)).toEqual(expected.slice(0, 2))
    expect(CacheEvidence.deniedLines("no sandbox line")).toEqual([])
  })
})

describe("a stored result with its evidence", () => {
  it("round trips the dependency outputs its run could read", () => {
    const stored = CacheEvidence.record([["pkg/dist", "a".repeat(64)], ["pkg/gen.ts", "absent"]], { exitCode: 0 })
    expect(stored).toEqual({
      kind: "evidence",
      reads: [["pkg/dist", "a".repeat(64)], ["pkg/gen.ts", "absent"]],
      result: { exitCode: 0 }
    })
    expect(CacheEvidence.decode(JSON.parse(JSON.stringify(stored)))).toEqual(stored)
    // A result of `undefined` is still a result.
    expect(CacheEvidence.decode(CacheEvidence.record([], undefined))).toEqual({
      kind: "evidence",
      reads: [],
      result: undefined
    })
  })

  it.each([
    ["a bare result", { exitCode: 0 }],
    ["nothing", undefined],
    ["null", null],
    ["text", "evidence"],
    ["another kind", { kind: "build", reads: [], result: 1 }],
    ["no result", { kind: "evidence", reads: [] }],
    ["reads that are not a list", { kind: "evidence", reads: {}, result: 1 }],
    ["a read that is not a pair", { kind: "evidence", reads: ["pkg/dist"], result: 1 }],
    ["a read of three", { kind: "evidence", reads: [["pkg/dist", "a", "b"]], result: 1 }],
    ["a path that is not text", { kind: "evidence", reads: [[1, "a"]], result: 1 }],
    ["a digest that is not text", { kind: "evidence", reads: [["pkg/dist", 1]], result: 1 }]
  ])("does not decode %s", (_name, output) => {
    expect(CacheEvidence.decode(output)).toBeUndefined()
  })
})
