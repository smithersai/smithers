// @vitest-environment node
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { serverPath } from "./surface-host.ts"
import { mockReply } from "../src/core/mockReplies.ts"
import { unreachable } from "../src/surfaces/backend.vibe"

/** Nothing listens on the discard port: the live Factory there is unreachable. test/live.workerd.test.ts serves one. */
const CLOSED = "http://127.0.0.1:9"

const entry = fileURLToPath(new URL("../dist-factory/surfaces/cli-entry.js", import.meta.url))
function cli(args: string[], backend = "") {
  return spawnSync(entry, args, {
    encoding: "utf8", timeout: 15_000, env: { ...process.env, VIBELANG_FACTORY: backend, VIBELANG_FACTORY_URL: CLOSED, NO_COLOR: "1" },
  })
}

describe("built CLI process", () => {
  it("prints the complete reply and event numbers", () => {
    const result = cli(["--mock", "ask", "How do I install it?"])
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(mockReply("install"))
    expect(result.stdout).toMatch(/Events: 1, 2, 3/)
    expect(result.stderr).toBe("")
  })
  it("supports JSON and global flags on either side of a subcommand", () => {
    const result = cli(["ask", "install", "--json", "--mock", "--conversation", "docs"])
    expect(result.status).toBe(0)
    const output = JSON.parse(result.stdout)
    expect(output).toMatchObject({ conversation: "docs", text: mockReply("install") })
    expect(output.events[0]).toBe(1)
    expect(output.events.at(-1)).toBe(output.events.length)
    expect(result.stderr).toBe("")
  })
  it("reads without waiting and honors the environment backend", () => {
    const result = cli(["read", "--after", "0", "--json"], "mock")
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ conversation: "home", seq: 0, entries: [] })
    expect(cli(["--mock", "read"]).stdout).toBe("No entries. Event: 0\n")
  })
  it.each([
    [["read"], "can't be reached"],
    [["--mock", "ask", " "], "message was refused: empty"],
    [["--mock", "read", "--after", "-1"], "after"],
    [["--mock", "ask"], "text"],
    [["--wat"], "wat"],
  ])("fails with a plain error for %j", (args, message) => {
    const result = cli(args as string[])
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain(message as string)
  })
  it.each([["--help"], ["ask", "--help"], ["--llms"]])("discovers %j without a backend", (...args) => {
    const result = cli(args)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("ask")
    expect(result.stdout).toContain(args[0] === "--llms" ? "inputSchema" : "--mock")
    expect(result.stderr).toBe("")
  })
  it("keeps MCP startup errors on stderr and exits nonzero without a live backend", () => {
    const result = spawnSync(process.execPath, [serverPath], {
      encoding: "utf8", timeout: 10_000, env: { ...process.env, VIBELANG_FACTORY: "", VIBELANG_FACTORY_URL: CLOSED },
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe(`${unreachable(CLOSED)}\n`)
  })
  it("ships a concise skill that describes both commands and backend lifetime", () => {
    const skill = readFileSync(new URL("../skills/vibelang-factory/SKILL.md", import.meta.url), "utf8")
    expect(skill).toMatch(/^---\nname: vibelang-factory\ndescription: .+\n---/)
    expect(skill.split(/\s+/).length).toBeLessThan(600)
    for (const phrase of [" ask ", " read ", "--llms", "--json", "--mock", "one process"]) expect(skill).toContain(phrase)
  })
})
