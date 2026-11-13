/**
 * The native Copy and Literal contract, planned and executed directly against
 * a real temporary workspace: a copy from a producing target reads that
 * producer's single planned output, and a node whose source cannot be resolved
 * is refused by name before anything is published.
 */
import { Smithers as S } from "@smthrs/targets"
import type * as Target from "@smthrs/targets/Target"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type * as Rule from "../src/internal/RuleContract.ts"
import { accepts, contract } from "../src/internal/rules/NativeFileRule.ts"

type Node = Parameters<typeof contract.execute>[0]
type Context = Parameters<typeof contract.execute>[1]

let root: string
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-native-file-")))
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

const producer = S.Literal({ path: "gen/source.txt", content: "unused" })
const labelFor = (target: Target.AnyTarget): string => target === producer ? "//pkg:producer" : "//pkg:other"

const planned = (rule: "Copy" | "Literal", attrs: unknown): Node => {
  const result = contract.plan({ rule, attrs, packagePath: "pkg", labelFor })
  if (!result.ok) throw new Error(result.refusal)
  return { label: `//pkg:${rule}`, ...result.value } as unknown as Node
}

const context = (nodes: ReadonlyArray<readonly [string, { readonly outFiles: ReadonlyArray<string> }]>): Context => ({
  root,
  signal: undefined,
  nodes: new Map(nodes) as unknown as ReadonlyMap<string, Rule.PlannedRule>
})

describe("NativeFileRule Copy from a producing target", () => {
  it("plans the source as the producer's label and copies the producer's one planned output", async () => {
    const node = planned("Copy", { from: producer, to: "out/copied.txt" })
    expect(node.lane).toEqual({ kind: "native-file", flavor: "copy", sourceLabel: "//pkg:producer" })
    expect(node.outFiles).toEqual(["pkg/out/copied.txt"])
    expect(accepts(node as unknown as Rule.PlannedRule)).toBe(true)
    await Fs.mkdir(Path.join(root, "pkg", "gen"), { recursive: true })
    await Fs.writeFile(Path.join(root, "pkg", "gen", "source.txt"), "producer bytes\n")

    await contract.execute(node, context([["//pkg:producer", { outFiles: ["pkg/gen/source.txt"] }]]))

    expect(await Fs.readFile(Path.join(root, "pkg", "out", "copied.txt"), "utf8")).toBe("producer bytes\n")
  })

  it("refuses a producer label the plan does not contain and publishes nothing", async () => {
    const node = planned("Copy", { from: producer, to: "out/copied.txt" })
    await expect(contract.execute(node, context([]))).rejects.toThrow("copy source //pkg:producer was not planned")
    await expect(Fs.access(Path.join(root, "pkg", "out"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each([[[]], [["pkg/a.txt", "pkg/b.txt"]]])(
    "refuses a producer that declares %j output files instead of exactly one",
    async (outFiles) => {
      const node = planned("Copy", { from: producer, to: "out/copied.txt" })
      await expect(contract.execute(node, context([["//pkg:producer", { outFiles }]]))).rejects.toThrow(
        "copy source //pkg:producer must declare exactly one output file"
      )
      await expect(Fs.access(Path.join(root, "pkg", "out"))).rejects.toMatchObject({ code: "ENOENT" })
    }
  )

  it("refuses a copy lane that names neither a file nor a producer", async () => {
    const node = { ...planned("Copy", { from: producer, to: "out/copied.txt" }) } as Node
    const lane = { kind: "native-file", flavor: "copy" } as Node["lane"]
    await expect(contract.execute({ ...node, lane } as Node, context([]))).rejects.toThrow(
      "copy source did not resolve to a file"
    )
    await expect(Fs.access(Path.join(root, "pkg", "out"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})

describe("NativeFileRule Copy from a file and Literal", () => {
  it("copies a declared workspace file without consulting the plan's other nodes", async () => {
    const node = planned("Copy", { from: S.file("input.txt"), to: "copied.txt" })
    expect(node.lane).toEqual({ kind: "native-file", flavor: "copy", source: "pkg/input.txt" })
    await Fs.mkdir(Path.join(root, "pkg"))
    await Fs.writeFile(Path.join(root, "pkg", "input.txt"), "file bytes\n")
    await contract.execute(node, context([]))
    expect(await Fs.readFile(Path.join(root, "pkg", "copied.txt"), "utf8")).toBe("file bytes\n")
  })

  it("writes a literal's exact content, including an empty one", async () => {
    await contract.execute(planned("Literal", { path: "lit/full.txt", content: "fixed\n" }), context([]))
    await contract.execute(planned("Literal", { path: "lit/empty.txt", content: "" }), context([]))
    expect(await Fs.readFile(Path.join(root, "pkg", "lit", "full.txt"), "utf8")).toBe("fixed\n")
    expect(await Fs.readFile(Path.join(root, "pkg", "lit", "empty.txt"), "utf8")).toBe("")
  })

  it("writes an empty file for a literal lane that carries no text", async () => {
    const node = planned("Literal", { path: "lit/textless.txt", content: "dropped" })
    const lane = { kind: "native-file", flavor: "literal" } as Node["lane"]
    await contract.execute({ ...node, lane } as Node, context([]))
    expect(await Fs.readFile(Path.join(root, "pkg", "lit", "textless.txt"), "utf8")).toBe("")
  })
})
