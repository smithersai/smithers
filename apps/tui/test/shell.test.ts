import { describe, expect, it } from "bun:test"
import { readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import * as Shell from "../src/shell.ts"

describe("shell output", () => {
  it("masks credential-named environment values in the output it shows, saves and sends", async () => {
    const env = { ...process.env, GH_TOKEN: "ghp_supersecretvalue", HARMLESS: "ghp_supersecretvalue_not" }
    const streamed: Array<string> = []
    const result = await Shell.run({ command: "echo $GH_TOKEN", cwd: tmpdir(), env, onOutput: (text) => streamed.push(text) })
      .done
    expect(result.output).toBe("[redacted $GH_TOKEN]")
    expect(streamed.join("")).not.toContain("ghp_supersecretvalue")
  }, 20_000)

  it("keeps a !! command's output out of the session record", () => {
    const result = { command: "cat .env", output: "KEY=1", exitCode: 0, cancelled: false, fullOutputPath: "/tmp/x" }
    expect(Shell.persisted(result, true)).toEqual({ command: "cat .env", output: "", exitCode: 0, cancelled: false })
    expect(Shell.persisted(result, false)).toBe(result)
  })

  it("streams output over the limit to an owner-only file and keeps only a bounded tail in memory", async () => {
    const result = await Shell.run({
      command: "i=0; while [ $i -lt 3000 ]; do printf '%0200d\\n' $i; i=$((i+1)); done",
      cwd: tmpdir(),
      onOutput: () => {}
    }).done
    expect(result.fullOutputPath).toBeDefined()
    expect(statSync(result.fullOutputPath!).mode & 0o777).toBe(0o600)
    expect(readFileSync(result.fullOutputPath!, "utf8").split("\n").filter((line) => line !== "")).toHaveLength(3000)
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(Shell.maxBytes)
    expect(result.output.endsWith(String(2999).padStart(200, "0"))).toBe(true)
  }, 20_000)

  it("settles with the kept tail when the full-output file cannot be written", async () => {
    const result = await Shell.run({
      command: "i=0; while [ $i -lt 3000 ]; do printf '%0200d\\n' $i; i=$((i+1)); done",
      cwd: tmpdir(),
      spillDir: "/nonexistent-smithers-spill-dir",
      onOutput: () => {}
    }).done
    expect(result.exitCode).toBe(0)
    expect(result.fullOutputPath).toBeUndefined()
    expect(result.output.endsWith(String(2999).padStart(200, "0"))).toBe(true)
  }, 20_000)

  it("batches a burst of output into few screen updates", async () => {
    let updates = 0
    let text = ""
    await Shell.run({
      command: "i=0; while [ $i -lt 2000 ]; do echo line$i; i=$((i+1)); done",
      cwd: tmpdir(),
      onOutput: (chunk) => {
        updates++
        text += chunk
      }
    }).done
    expect(text.trim().split("\n")).toHaveLength(2000)
    expect(updates).toBeLessThan(50)
  }, 20_000)
})
