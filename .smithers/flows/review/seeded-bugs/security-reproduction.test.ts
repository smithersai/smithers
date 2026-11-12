import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { reproduce } from "./security-reproduction.ts"

const node = Bun.which("node")!
const corpus = join(import.meta.dirname, "corpus")
const users = readFileSync(join(corpus, "sql-injection/head/src/users.ts"), "utf8")
let scratch = ""
let hits = 0
let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "security-reproduction-test-"))
  server = Bun.serve({ port: 0, fetch: () => (hits++, new Response("reached")) })
})

afterAll(() => {
  server.stop(true)
  rmSync(scratch, { recursive: true, force: true })
})

/** The real vulnerable fixture with `prelude` as extra top-level code. */
const planted = (name: string, prelude: string): string => {
  const file = join(scratch, `${name}.ts`)
  writeFileSync(file, `${prelude}\n${users}`)
  return file
}

describe("security reproduction", () => {
  test("reproduces the corpus pairs: the head leaks the private row, the base does not", () => {
    for (const [fixture, file, helper] of [
      ["sql-injection", "src/users.ts", "findUserByEmail"],
      ["sql-injection-like", "src/search.ts", "searchArticles"]
    ] as const) {
      for (const [side, rows] of [["head", 1], ["base", 0]] as const) {
        const copy = join(scratch, `${fixture}-${side}.ts`)
        copyFileSync(join(corpus, fixture, side, file), copy)
        expect(reproduce(copy, helper, node)).toEqual({ observedRows: rows })
      }
    }
  })

  test("a fixture sees none of the evaluator's environment", () => {
    process.env.REVIEW_SYNTHETIC_KEY = "synthetic-sentinel"
    try {
      const file = planted("env", "if (Object.keys(process.env).length > 0) throw new Error('host env reached the fixture')")
      expect(reproduce(file, "findUserByEmail", node)).toEqual({ observedRows: 1 })
    } finally {
      delete process.env.REVIEW_SYNTHETIC_KEY
    }
  })

  test("a fixture cannot read a host file", () => {
    const secret = join(scratch, "host-secret.txt")
    writeFileSync(secret, "synthetic-secret")
    const file = planted("fs", `import { readFileSync } from "node:fs"\nreadFileSync(${JSON.stringify(secret)})`)
    expect(() => reproduce(file, "findUserByEmail", node)).toThrow(/ERR_ACCESS_DENIED/)
  })

  test("a fixture cannot reach the network", () => {
    const file = planted("net", `await fetch(${JSON.stringify(server.url.href)})`)
    expect(() => reproduce(file, "findUserByEmail", node)).toThrow(/ERR_ACCESS_DENIED/)
    expect(hits).toBe(0)
  })

  test("a fixture cannot start a process", () => {
    const file = planted("process", `import { execFileSync } from "node:child_process"\nexecFileSync("true")`)
    expect(() => reproduce(file, "findUserByEmail", node)).toThrow(/ERR_ACCESS_DENIED/)
  })

  test("a fixture that prints no receipt fails the reproduction", () => {
    const file = planted("exit", "process.exit(0)")
    expect(() => reproduce(file, "findUserByEmail", node)).toThrow()
  })
})
