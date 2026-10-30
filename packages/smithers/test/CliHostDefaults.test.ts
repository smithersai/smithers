import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as Agents from "../src/Agents.ts"
import { makeCli } from "../src/Cli.ts"
import type * as Bridge from "../src/cli/ControlBridge.ts"
import { packageVersion } from "../src/Version.ts"
import { temporaryEnvironment } from "./temporaryEnvironment.ts"

const roots: Array<string> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const invoke = async (
  argv: Array<string>,
  runtime: Bridge.Runtime = { environment: {} },
  documentation: { humanHelp?: boolean } = {}
) => {
  const codes: Array<number> = []
  let stdout = ""
  await makeCli({ exit: (code) => codes.push(code), ...runtime }, documentation).serve(argv, {
    env: {},
    exit: (code) => codes.push(code),
    stdout: (text) => {
      stdout += text
    }
  })
  return { codes, stdout }
}

// The host supplies no writer, so output reaches the process's standard stream.
const processOutput = async (run: () => Promise<unknown>) => {
  const written: Array<string> = []
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    written.push(String(chunk))
    return true
  })
  try {
    await run()
  } finally {
    stdout.mockRestore()
  }
  return written.join("")
}

describe("a host that supplies no stdout writer", () => {
  it("prints root output to process stdout", async () => {
    const output = await processOutput(() => makeCli({ environment: {} }).serve(["--version"], { env: {} }))
    expect(output.trim()).toBe(packageVersion)
  })

  it("prints a JSON document to process stdout", async () => {
    const codes: Array<number> = []
    // A private root: the memory store it opens must not land in the shared tmpdir.
    const root = await mkdtemp(join(tmpdir(), "smthrs-cli-stdout-"))
    roots.push(root)
    const output = await processOutput(() =>
      makeCli({ environment: {} }).serve(["memory", "notes", "get", "absent", "--root", root, "--json"], {
        env: {},
        exit: (code) => codes.push(code)
      })
    )
    expect(JSON.parse(output)).toMatchObject({ code: "operator_failed", message: "Unknown note absent" })
    expect(codes).toEqual([1])
  })

  it("prints a removed verb's parser refusal without asking Jev for a suggestion", async () => {
    const codes: Array<number> = []
    const output = await processOutput(() =>
      makeCli({ environment: {} }).serve(["replay"], { env: {}, exit: (code) => codes.push(code) })
    )
    expect(output).toContain("COMMAND_NOT_FOUND")
    expect(output).not.toContain("Jev")
    expect(codes).toEqual([1])
  })
})

describe("command routing before Incur", () => {
  it("finds the verb after a spaced valued option", async () => {
    const { codes, stdout } = await invoke(["--token-limit", "500", "stauts"])
    expect(stdout).toContain("COMMAND_NOT_FOUND")
    expect(stdout.trimEnd().endsWith("Could not ask Jev for a suggestion: unconfigured")).toBe(true)
    expect(codes).toEqual([1])
  })

  it("runs a door command behind a leading option through install discovery", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "smthrs-cli-door-")))
    roots.push(root)
    const names = (stdout: string) => JSON.parse(stdout).checks.map((check: { name: string }) => check.name)
    const plain = await invoke(["doctor", "--root", root, "--json"])
    const led = await invoke(["--token-limit", "500", "doctor", "--root", root, "--json"])
    expect(led.codes).toEqual([])
    expect(JSON.parse(led.stdout).root).toBe(root)
    expect(names(led.stdout)).toEqual(names(plain.stdout))
  })

  it("hands --http to Incur unwrapped, which has no HTTP transport and refuses it", async () => {
    const { codes, stdout } = await invoke(["--http", "--json"])
    expect(JSON.parse(stdout)).toEqual({
      code: "COMMAND_NOT_FOUND",
      message: "'--http' is not a command for 'smthrs'.",
      cta: {
        description: "Suggested command:",
        commands: [{ command: "smthrs --help", description: "see all available commands" }]
      }
    })
    expect(codes).toEqual([1])
  })

  it("suggests against human discovery and answers -h with human help", async () => {
    const refused = await invoke(["stauts"], { environment: {} }, { humanHelp: true })
    expect(refused.stdout.trimEnd().endsWith("Could not ask Jev for a suggestion: unconfigured")).toBe(true)
    const short = await invoke(["-h"], { environment: {} }, { humanHelp: true })
    const long = await invoke(["--help"], { environment: {} }, { humanHelp: true })
    expect(short.stdout).toContain("smthrs")
    expect(short.stdout).toBe(long.stdout)
  })

  it.each(["mcp doctor --help", "mcp -h"])("leaves `%s` to Incur's integration help", async (line) => {
    const { codes, stdout } = await invoke(line.split(" "))
    expect(stdout).toContain("doctor")
    expect(codes).toEqual([])
  })
})

describe("process boundaries of host commands", () => {
  const fixture = async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "smthrs-cli-host-")))
    roots.push(root)
    const commands = join(root, "commands")
    await mkdir(commands)
    const receipt = join(root, "receipt.json")
    // The TUI in an environment runs `smthrs` there; this one records its argv.
    await writeFile(
      join(commands, "smthrs"),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${
        JSON.stringify(receipt)
      },JSON.stringify(process.argv.slice(2)));process.exit(7)\n`,
      { mode: 0o700 }
    )
    const environment = {
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      PATH: `${commands}:${process.env.PATH ?? ""}`,
      SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
      ...temporaryEnvironment()
    }
    return { root, receipt, environment }
  }

  it("runs the TUI inside a saved environment and exits with its status", async () => {
    const { root, receipt, environment } = await fixture()
    const added = await invoke(["environment", "add", "dev", "--local", "--directory", root], { environment })
    expect(added.codes).toEqual([])
    const tui = await invoke(["tui", "--environment", "dev", "-p", "hello", "--approve", "deny"], { environment })
    expect(tui.codes).toEqual([7])
    expect(JSON.parse(await readFile(receipt, "utf8"))).toEqual(["tui", "--print", "hello", "--approve", "deny"])
  })

  it("forwards an environment exec literal tail as the command's arguments", async () => {
    const { root, environment } = await fixture()
    await invoke(["environment", "add", "dev", "--local", "--directory", root], { environment })
    const ran = await invoke(
      ["environment", "exec", "dev", "--", process.execPath, "-e", "process.exit(6)"],
      { environment }
    )
    expect(ran.codes).toEqual([6])
  })

  it("prints manual MCP setup to process stderr when the host supplies no writer", async () => {
    const { root } = await fixture()
    // A file where the home directory belongs makes every registration fail.
    const home = join(root, "home-file")
    await writeFile(home, "")
    const written: Array<string> = []
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk))
      return true
    })
    const { codes, stdout } = await invoke(["mcp", "add", "--json"], { environment: { HOME: home } })
    expect(JSON.parse(stdout)).toMatchObject({ message: "Could not register the MCP server" })
    expect(codes).toEqual([1])
    expect(written.join("")).toContain(Agents.manualInstructions(Agents.agents.map((agent) => agent.id)))
  })
})
