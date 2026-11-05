import { Cli } from "incur"
import { spawn } from "node:child_process"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"
import { normalizeArguments } from "../src/cli/Arguments.ts"

const document = async (argv: Array<string>) => {
  let output = "", code = 0
  await makeCli({ environment: {} }).serve(normalizeArguments(argv), {
    env: {},
    stdout: (text) => {
      output += text
    },
    exit: (value) => {
      code = value
    }
  })
  return { output, code }
}

describe("supported nested command help", () => {
  // Reviewed against the supported library commands and the catalog doors.
  // Keep these expectations literal; compatibility backend verbs are excluded.
  it.each(
    [
      ["runs", [
        "wait",
        "list",
        "count",
        "show",
        "devtools",
        "logs",
        "output",
        "cancel",
        "cancel-all",
        "resume",
        "continue",
        "stop",
        "signal",
        "steer",
        "inspect",
        "replay",
        "verify"
      ]],
      ["flow", ["list", "show", "plan", "start", "execute", "edit", "new", "run", "source"]],
      ["memory", ["list", "get", "set", "rm", "recall", "compact", "notes", "threads", "messages"]],
      ["memory notes", ["list", "get", "add", "status", "supersede"]],
      ["generate", ["ci", "package", "flow"]]
    ] as const
  )("lists supported children of %s without reviving old backend commands", async (path, children) => {
    const result = await document([...path.split(" "), "--help"])
    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain(`Usage: smthrs ${path}`)
    expect([...result.output.matchAll(/^  ([a-z][a-z-]*)\s{2,}/gm)].map((match) => match[1]).sort())
      .toEqual([...children].sort())
    for (const removed of ["rerun", "watch", "dispatch"]) {
      expect(result.output).not.toMatch(new RegExp(`^\\s+${removed}\\s{2,}`, "m"))
    }
  })

  it.each([
    "runs list",
    "runs signal",
    "runs logs",
    "runs resume",
    "runs output",
    "memory set",
    "memory notes",
    "memory notes list",
    "flow start",
    "flow run",
    "approvals approve"
  ])("renders the exact document for %s with either help spelling", async (path) => {
    for (const flag of ["--help", "-h"]) {
      const result = await document([...path.split(" "), flag])
      expect(result.code, result.output).toBe(0)
      expect(result.output).toContain(`Usage: smthrs ${path}`)
      expect(result.output).not.toContain("Usage: smthrs <command>")
    }
  })

  it("renders every registered nested path without falling through to root help", async () => {
    const cli = makeCli({ environment: {} })
    const check = async (commands: NonNullable<ReturnType<typeof Cli.toCommands.get>>, prefix: Array<string> = []) => {
      for (const [name, entry] of commands) {
        if ("_alias" in entry) continue
        const path = [...prefix, name]
        if (path.length > 1) {
          let output = ""
          await cli.serve([...path, "--help"], {
            env: {},
            stdout: (text) => {
              output += text
            },
            exit: (code) => expect(code, path.join(" ")).toBe(0)
          })
          expect(output, path.join(" ")).toContain(`Usage: smthrs ${path.join(" ")}`)
        }
        if ("_group" in entry) await check(entry.commands, path)
      }
    }
    await check(Cli.toCommands.get(cli as never)!)
  })

  it("keeps a prefixed root option and explicit approval schema inert", async () => {
    const result = await document(["--root", "/does-not-exist", "approvals", "approve", "--schema", "--json"])
    expect(result.code, result.output).toBe(0)
    expect(JSON.parse(result.output).args.required).toEqual(["approval"])
  })

  it("keeps unsupported backend commands and library groups out of root discovery", async () => {
    const help = await document(["--help"])
    const manifest = await document(["--llms-full", "--format", "json"])
    const paths = JSON.parse(manifest.output).commands.map((entry: { name: string }) => entry.name)
    for (const group of ["memory", "approvals", "admin", "environment"]) {
      expect(help.output).not.toMatch(new RegExp(`^\\s+${group}\\s{2,}`, "m"))
    }
    for (const path of ["runs signal", "runs logs", "memory set", "approvals approve", "runs rerun", "flow dispatch"]) {
      expect(paths).not.toContain(path)
    }
  })

  it.each([false, true])("answers nested executable help without stores (project=%s)", async (project) => {
    const root = await mkdtemp(join(tmpdir(), "sm-b21-help-"))
    try {
      if (project) await writeFile(join(root, "WORKSPACE.ts"), "throw new Error('help must not load this')\n")
      const before = await readdir(root)
      const executable = fileURLToPath(new URL("../bin/smithers.mjs", import.meta.url))
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--no-warnings", executable, "runs", "--help"], {
          cwd: root,
          env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root }
        })
        let stdout = "", stderr = ""
        child.stdout.on("data", (chunk) => {
          stdout += chunk
        })
        child.stderr.on("data", (chunk) => {
          stderr += chunk
        })
        child.once("error", reject)
        child.once("close", (code) => resolve({ code, stdout, stderr }))
      })
      expect(result.code, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain("Usage: smthrs runs")
      expect(result.stdout).toMatch(/^\s+signal\s{2,}/m)
      expect(result.stderr).toBe("")
      expect(await readdir(root)).toEqual(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
