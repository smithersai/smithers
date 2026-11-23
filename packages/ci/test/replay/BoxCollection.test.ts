import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"

const script = join(import.meta.dirname, "../../scripts/box-replay.mjs")
const box: {
  collect: (directory: string, cpu: string, status: number) => number
  main: (args: ReadonlyArray<string>) => Promise<number>
} = await import(script)

const directories: Array<string> = []
const temp = () => {
  const directory = mkdtempSync(join(tmpdir(), "box-collection-"))
  directories.push(directory)
  return directory
}

const artifact = (files: Record<string, string>) => {
  const source = temp()
  const result = temp()
  mkdirSync(join(source, "out"))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(source, "out", name), content)
  execFileSync("tar", ["-czf", join(result, "result.tgz"), "-C", source, "out"])
  return result
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it("rejects oversized metadata before writing any result", () => {
  const result = artifact({ "box.txt": "one job", exit: "0".repeat(4097) })
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined)
  expect(box.collect(result, "2", 0)).toBe(4)
  expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("collection size limit at exit"))
  expect(readdirSync(result)).toEqual([])
})

it("finds a replay refusal after a long log line, including a final line without a newline", () => {
  const reason = "smithers-ci: replay: fixture has no checks"
  const result = artifact({ "replay.log": "x".repeat(1024 * 1024 + 17) + "\n" + reason, exit: "3" })
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined)
  expect(box.collect(result, "2", 0)).toBe(3)
  expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining(reason))
})

it("reports a failed stop for its box and removes its upload", async () => {
  const packs = temp()
  const file = "smithers-ci-1.tgz"
  writeFileSync(join(packs, "manifest.json"), JSON.stringify([{ filename: file }]))
  writeFileSync(join(packs, file), "fixture")
  const binary = join(temp(), "cfbox")
  writeFileSync(binary, "#!/bin/sh\nif [ \"$1\" = stop ]; then exit 17; fi\nexit 0\n", { mode: 0o755 })
  vi.stubEnv("CFBOX", binary)
  const result = temp()
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined)
  expect(
    await box.main(["https://example.com/repo", "1234567", "--packs", packs, "--out", result, "--job-id", "fixture1"])
  ).toBe(17)
  expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("could not stop fixture1 (cfbox exit 17)"))
  expect(existsSync(join(result, "upload"))).toBe(false)
})
