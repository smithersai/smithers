import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { invokeCanonical } from "./fixtures/invokeCanonical.ts"

describe("canonical memory parser", () => {
  it.each(["--help", "--schema", "--nope"])("handles %s before opening durable stores", async (flag) => {
    const root = mkdtempSync(join(tmpdir(), "smithers-memory-parser-"))
    try {
      const result = await invokeCanonical(["memory", "recall", flag, "--root", root, "--json"])
      expect(existsSync(join(root, ".flows"))).toBe(false)
      expect(result.stderr).toBe("")
      if (flag === "--nope") {
        expect(result.codes).toEqual([1])
        expect(JSON.parse(result.stdout)).toMatchObject({ code: "UNKNOWN", message: "Unknown flag: --nope" })
      } else {
        expect(result.codes).toEqual([])
        if (flag === "--help") expect(result.stdout).toContain("Usage: smthrs memory recall")
        else {expect(JSON.parse(result.stdout)).toMatchObject({
            args: { type: "object", required: ["query"] },
            options: { properties: { root: { type: "string" } } }
          })}
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
