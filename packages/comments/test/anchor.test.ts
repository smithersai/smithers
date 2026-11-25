import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { Anchor } from "../src/index.ts"

describe("Anchor", () => {
  const tsSource = [
    "import { sha256 } from \"./crypto.ts\"",
    "",
    "export const TOKEN_TTL = 900",
    "",
    "export function verifyToken(token: string, secret: string): boolean {",
    "  if (token.length === 0) return false",
    "  return sha256(token + secret).startsWith(\"0\")",
    "}",
    "",
    "export class SessionStore {",
    "  private readonly items = new Map<string, string>()",
    "  get(id: string) {",
    "    return this.items.get(id)",
    "  }",
    "}",
    ""
  ].join("\n")

  it("extracts symbols and parameter names across TypeScript, Python, Go, and Rust", () => {
    const tsSymbols = Anchor.extractSymbols(tsSource, "c-style")
    expect(tsSymbols.find((s) => s.name === "verifyToken")).toMatchObject({
      name: "verifyToken",
      line: 5,
      params: ["token", "secret"]
    })
    expect(tsSymbols.find((s) => s.name === "SessionStore")).toMatchObject({
      name: "SessionStore",
      line: 10
    })

    const pySymbols = Anchor.extractSymbols("def compute_hash(data, salt=None):\n    return data\n", "hash")
    expect(pySymbols.find((s) => s.name === "compute_hash")).toMatchObject({
      name: "compute_hash",
      line: 1,
      params: ["data", "salt"]
    })

    const goSymbols = Anchor.extractSymbols(
      "func ParseHeader(raw []byte, strict bool) error {\n\treturn nil\n}\n",
      "c-style"
    )
    expect(goSymbols.find((s) => s.name === "ParseHeader")).toMatchObject({
      name: "ParseHeader",
      line: 1
    })

    const rsSymbols = Anchor.extractSymbols("pub fn decode_frame(buf: &[u8]) -> usize {\n    buf.len()\n}\n", "c-style")
    expect(rsSymbols.find((s) => s.name === "decode_frame")).toMatchObject({
      name: "decode_frame",
      line: 1
    })
  })

  it.effect("resolves symbol anchors even after lines shift above the declaration", () =>
    Effect.gen(function*() {
      const shifted = "\n\n\n" + tsSource
      const resolved = yield* Anchor.resolveAnchor(
        shifted,
        "c-style",
        { kind: "symbol", symbol: "verifyToken" },
        "before",
        5
      )
      expect(resolved.line).toBe(8)
      expect(resolved.codeHash).toMatch(/^[0-9a-f]{8}$/)
    }))

  it.effect("resolves pattern anchors and uses lineHint to break ties, or reports ambiguous-anchor", () =>
    Effect.gen(function*() {
      const dupSource = [
        "const a = retry()",
        "const b = 1",
        "const c = retry()",
        ""
      ].join("\n")

      const withHint = yield* Anchor.resolveAnchor(
        dupSource,
        "c-style",
        { kind: "pattern", pattern: "retry()" },
        "before",
        3
      )
      expect(withHint.line).toBe(3)

      const withoutHint = yield* Effect.exit(
        Anchor.resolveAnchor(dupSource, "c-style", { kind: "pattern", pattern: "retry()" }, "before")
      )
      expect(Exit.isFailure(withoutHint)).toBe(true)
    }))

  it.effect("reports dangling-anchor for missing symbols or out-of-range lines", () =>
    Effect.gen(function*() {
      const missingSym = yield* Effect.exit(
        Anchor.resolveAnchor(tsSource, "c-style", { kind: "symbol", symbol: "doesNotExist" }, "before")
      )
      expect(Exit.isFailure(missingSym)).toBe(true)

      const outOfRange = yield* Effect.exit(
        Anchor.resolveAnchor(tsSource, "c-style", { kind: "line", line: 999 }, "before")
      )
      expect(Exit.isFailure(outOfRange)).toBe(true)
    }))

  it("computes stable 8-hex code hashes sensitive to code changes and insensitive to indentation/CRLF", () => {
    const h1 = Anchor.computeCodeHash("  export function foo() {\n    return 1\n  }")
    const h2 = Anchor.computeCodeHash("export function foo() {\r\nreturn 1\r\n}")
    const h3 = Anchor.computeCodeHash("export function foo() {\nreturn 2\n}")

    expect(h1).toMatch(/^[0-9a-f]{8}$/)
    expect(h1).toBe(h2)
    expect(h1).not.toBe(h3)
  })
})
