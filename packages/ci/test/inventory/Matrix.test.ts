import { describe, expect, it } from "vitest"
import { expandMatrix } from "../../src/inventory/Matrix.vibe"

describe("expandMatrix", () => {
  it("is empty when a job has no matrix", () => {
    expect(expandMatrix(undefined)).toEqual({ variants: [], keys: new Set() })
  })

  it("combines every list and writes values as text", () => {
    const matrix = expandMatrix({ os: ["linux", "mac"], node: [20, 22], flag: [true, null] })
    expect(matrix.variants).toHaveLength(8)
    expect(matrix.variants[0]).toEqual({ os: "linux", node: "20", flag: "true" })
    expect(matrix.variants[7]).toEqual({ os: "mac", node: "22", flag: "" })
    expect([...matrix.keys]).toEqual(["os", "node", "flag"])
  })

  it("flattens mapping values into dotted names", () => {
    expect(expandMatrix({ node: [{ version: 20, tools: { npm: 10 } }] }).variants).toEqual([
      { "node.version": "20", "node.tools.npm": "10" }
    ])
  })

  it("removes combinations matching exclude", () => {
    const matrix = expandMatrix({ os: ["a", "b"], node: [1, 2], exclude: [{ os: "a", node: 1 }, { os: "b" }] })
    expect(matrix.variants).toEqual([{ os: "a", node: "2" }])
  })

  // The example in GitHub's workflow syntax documentation.
  it("applies include as GitHub documents it", () => {
    const { variants } = expandMatrix({
      fruit: ["apple", "pear"],
      animal: ["cat", "dog"],
      include: [
        { color: "green" },
        { color: "pink", animal: "cat" },
        { fruit: "apple", shape: "circle" },
        { fruit: "banana" },
        { fruit: "banana", animal: "cat" }
      ]
    })
    expect(variants).toEqual([
      { fruit: "apple", animal: "cat", color: "pink", shape: "circle" },
      { fruit: "apple", animal: "dog", color: "green", shape: "circle" },
      { fruit: "pear", animal: "cat", color: "pink" },
      { fruit: "pear", animal: "dog", color: "green" },
      { fruit: "banana" },
      { fruit: "banana", animal: "cat" }
    ])
  })

  it("makes a variant of each include entry when there are no lists", () => {
    const matrix = expandMatrix({ include: [{ os: "a" }, { os: "b", extra: 1 }] })
    expect(matrix.variants).toEqual([{ os: "a" }, { os: "b", extra: "1" }])
    expect([...matrix.keys]).toEqual(["os", "extra"])
  })

  it.each([
    ["a computed matrix", "${{ fromJSON(x) }}", "computed when the workflow runs"],
    ["a computed list", { os: "${{ fromJSON(x) }}" }, "os is not a list"],
    ["a computed list value", { os: ["${{ env.OS }}"] }, "os is not a list"],
    ["a nested list value", { os: [["a"]] }, "os is not a list"],
    ["a computed include", { os: ["a"], include: "${{ x }}" }, "include or exclude"],
    ["an include entry that is not a mapping", { include: ["a"] }, "include or exclude"],
    ["a computed exclude value", { os: ["a"], exclude: [{ os: "${{ x }}" }] }, "include or exclude"]
  ])("reports %s", (_name, raw, problem) => {
    const matrix = expandMatrix(raw)
    expect(matrix.variants).toEqual([])
    expect(matrix.keys.size).toBe(0)
    expect(matrix.problem).toContain(problem)
  })

  it("compares nested values whatever order their fields are written in", () => {
    const node = { a: 1, b: 2, c: 3 }
    expect(expandMatrix({ node: [node], include: [{ node: { c: 3, b: 2, a: 1 }, extra: 1 }] }).variants).toEqual([
      { "node.a": "1", "node.b": "2", "node.c": "3", extra: "1" }
    ])
  })

  it("does not merge an include entry that changes a nested value", () => {
    expect(expandMatrix({ node: [{ version: 20 }], include: [{ node: { other: 1 } }] }).variants).toEqual([
      { "node.version": "20" },
      { "node.other": "1" }
    ])
    expect(expandMatrix({ node: [{ version: 20 }], include: [{ node: { version: 20 }, extra: 1 }] }).variants).toEqual([
      { "node.version": "20", extra: "1" }
    ])
  })

  it("lets a later include entry replace a value an earlier one added", () => {
    const include = [{ extra: { a: 1 } }, { extra: { b: 2 } }, { e2: 1 }, { e2: { z: 2 } }]
    expect(expandMatrix({ n: [1], include }).variants).toEqual([{ n: "1", "extra.b": "2", "e2.z": "2" }])
  })

  it("keeps ordinary names that resemble secret words", () => {
    expect(expandMatrix({ auth: ["none", "basic"], pass: [1] }).variants).toEqual([
      { auth: "none", pass: "1" },
      { auth: "basic", pass: "1" }
    ])
  })

  it.each([
    [{ include: [{ API_TOKEN: "abc123" }] }],
    [{ login: [{ password: "abc123" }] }]
  ])("withholds a matrix holding a secret by name: %j", (raw) => {
    const matrix = expandMatrix(raw)
    expect(matrix.variants).toEqual([])
    expect(matrix.problem).toBe("it holds a value named like a secret")
  })

  it("refuses more variants than GitHub allows", () => {
    const values = Array.from({ length: 17 }, (_, index) => index)
    expect(expandMatrix({ a: values, b: values }).problem).toBe("it has over 256 variants")
  })
})
