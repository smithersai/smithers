/**
 * `smthrs mcp add`.
 *
 * The two things worth pinning: writing is additive and idempotent, so an
 * operator's own configuration survives, and the launch command registered is
 * this executable rather than a package runner — 0.x registered
 * `bunx smthrs --mcp`, which pointed every agent at the last published build
 * regardless of what the operator was running.
 */
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import * as Agents from "../src/Agents.ts"
import { claudePath } from "./support/claude-cli.ts"

const staged: Array<string> = []

describe("codexConfigString", () => {
  it.each([
    ["DEL", "before\u007fafter", "\"before\\u007fafter\""],
    ["quotes and newline", "say \"hello\"\nnext", "\"say \\\"hello\\\"\\nnext\""],
    ["astral Unicode", "🦄", "\"🦄\""]
  ])("encodes %s as a valid TOML basic string", (_name, text, expected) => {
    expect(Agents.codexConfigString(text)).toBe(expected)
    expect(JSON.parse(Agents.codexConfigString(text))).toBe(text)
  })

  it.each(["\ud800", "\udfff"])("refuses a lone surrogate %j", (text) => {
    expect(() => Agents.codexConfigString(text)).toThrow(RangeError)
    expect(() => Agents.codexConfigString(text)).toThrow("malformed Unicode")
  })
})

const home = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-agents-"))
  staged.push(directory)
  return directory
}

afterEach(() => {
  while (staged.length > 0) rmSync(staged.pop()!, { recursive: true, force: true })
})

/**
 * A pid that is provably gone: a child this process has already reaped.
 *
 * Naming a pid that never ran would prove nothing, because the kernel is free
 * to hand that number to a live process at any moment.
 */
const departedPid = (): number => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { pid } = spawnSync(process.execPath, ["-e", ""])
    if (pid === undefined) continue
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid
    }
  }
  throw new Error("could not observe an exited pid")
}

describe("the known agents", () => {
  it("is Claude Code and Codex, and nothing that moved to the plugins repository", () => {
    expect(Agents.agents.map((agent) => agent.id)).toEqual(["claude", "codex"])
    expect(Agents.find("claude")?.mcpConfig).toEqual([".claude.json"])
    expect(Agents.find("hermes")).toBeUndefined()
  })

  it("registers this executable, not a package runner", () => {
    const launch = Agents.launchCommand("/usr/bin/node", "/opt/smithers/bin/smithers.mjs")

    expect(launch).toEqual({ command: "/usr/bin/node", args: ["/opt/smithers/bin/smithers.mjs", "--mcp"] })
    expect(Agents.launchCommand().args).toContain("--mcp")
  })
})

describe("registering the MCP server", () => {
  // Claude registrations go through the real Claude Code CLI.
  const ambientPath = process.env.PATH
  beforeAll(() => {
    process.env.PATH = claudePath()
  })
  afterAll(() => {
    process.env.PATH = ambientPath
  })

  it("writes the entry and leaves the rest of the configuration alone", () => {
    const directory = home()
    // Not "dark": Claude Code drops a setting that equals its default when it saves.
    writeFileSync(join(directory, ".claude.json"), JSON.stringify({ theme: "light", mcpServers: { other: {} } }))

    const wired = Agents.addMcp(Agents.find("claude")!, directory)

    expect(wired).toMatchObject({ agent: "claude", status: "written" })
    const document = JSON.parse(readFileSync(wired.path, "utf8")) as Record<string, any>
    expect(document.theme).toBe("light")
    expect(document.mcpServers.other).toEqual({})
    expect(document.mcpServers.smithers.args).toContain("--mcp")
  })

  it("creates Claude's configuration when it has none", () => {
    const directory = home()

    const wired = Agents.addMcp(Agents.find("claude")!, directory)

    expect(wired.status).toBe("written")
    expect(wired.path).toBe(join(directory, ".claude.json"))
    expect(existsSync(wired.path)).toBe(true)
  })

  it("is idempotent", () => {
    const directory = home()
    Agents.addMcp(Agents.find("claude")!, directory)

    expect(Agents.addMcp(Agents.find("claude")!, directory).status).toBe("unchanged")
  })

  it("replaces a stale entry that points somewhere else", () => {
    const directory = home()
    writeFileSync(
      join(directory, ".claude.json"),
      JSON.stringify({ mcpServers: { smithers: { command: "bunx", args: ["smthrs", "--mcp"] } } })
    )

    expect(Agents.addMcp(Agents.find("claude")!, directory).status).toBe("written")
  })

  it("preserves an unparseable configuration byte for byte and refuses to update it", () => {
    const directory = home()
    const path = join(directory, ".claude.json")
    const original = Buffer.from("{ not json\n\u0000operator data")
    writeFileSync(path, original)

    const wired = Agents.addMcp(Agents.find("claude")!, directory)

    // The old test pinned replacement with a Smithers-only document. That
    // made one syntax error destroy the operator's entire agent configuration.
    expect(wired.status).toBe("failed")
    expect(wired.reason).toContain(path)
    expect(wired.reason).toBe(`${path} is not valid JSON. Fix the file, then run this again.`)
    expect(readFileSync(path)).toEqual(original)
  })

  it("preserves and refuses a configuration whose root is an array", () => {
    const directory = home()
    const path = join(directory, ".claude.json")
    const original = "[1, {\"operator\": true}]\n"
    writeFileSync(path, original)

    const wired = Agents.addMcp(Agents.find("claude")!, directory)

    expect(wired).toMatchObject({ status: "failed", path })
    expect(wired.reason).toMatch(/root.*object/i)
    expect(readFileSync(path, "utf8")).toBe(original)
  })

  it("preserves and refuses an array-valued mcpServers member", () => {
    const directory = home()
    const path = join(directory, ".claude.json")
    const original = "{\"theme\":\"dark\",\"mcpServers\":[{\"operator\":true}]}\n"
    writeFileSync(path, original)

    const wired = Agents.addMcp(Agents.find("claude")!, directory)

    expect(wired).toMatchObject({ status: "failed", path })
    expect(wired.reason).toMatch(/mcpServers.*object/i)
    expect(readFileSync(path, "utf8")).toBe(original)
  })

  it("leaves a configuration byte-for-byte unchanged while another writer owns it", () => {
    const directory = home()
    const path = join(directory, ".claude.json")
    const original = "{\"theme\":\"operator-edit\"}\n"
    writeFileSync(path, original)
    writeFileSync(`${path}.smithers.lock`, "another writer")

    const wired = Agents.addMcp(Agents.find("claude")!, directory)

    expect(wired.status).toBe("failed")
    expect(wired.reason).toMatch(/another Smithers process/)
    expect(readFileSync(path, "utf8")).toBe(original)
  })

  it("recovers a lock left behind by a process that is gone", () => {
    const directory = home()
    const path = join(directory, ".claude.json")
    const lockPath = `${path}.smithers.lock`
    writeFileSync(path, "{}\n")
    writeFileSync(lockPath, `${departedPid()}:${Date.now()}:abandoned`, { mode: 0o600 })

    const wired = Agents.addMcp(Agents.find("claude")!, directory)

    // A crash inside the write used to leave a lock no later run could clear,
    // so every registration after it refused for as long as the file existed.
    expect(wired.status).toBe("written")
    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.smithers).toBeDefined()
    expect(existsSync(lockPath)).toBe(false)
  })

  it("refuses while the recorded owner is still running, and names the lock file", () => {
    const directory = home()
    const path = join(directory, ".claude.json")
    const lockPath = `${path}.smithers.lock`
    const original = "{\"theme\":\"operator-edit\"}\n"
    writeFileSync(path, original)
    writeFileSync(lockPath, `${process.pid}:${Date.now()}:live`, { mode: 0o600 })

    const wired = Agents.addMcp(Agents.find("claude")!, directory)

    expect(wired.status).toBe("failed")
    expect(wired.reason).toContain(lockPath)
    expect(wired.reason).toContain(String(process.pid))
    expect(readFileSync(path, "utf8")).toBe(original)
    expect(existsSync(lockPath)).toBe(true)

    // A lock holding nothing but the pid still names that whole pid: reading
    // it a digit short would ask about a process that never took this lock.
    writeFileSync(lockPath, String(process.pid), { mode: 0o600 })

    const bare = Agents.addMcp(Agents.find("claude")!, directory)

    expect(bare.status).toBe("failed")
    expect(bare.reason).toContain(`(pid ${process.pid})`)
    expect(readFileSync(path, "utf8")).toBe(original)
  })

  it("recovers an ownerless lock only once its creator cannot still be writing", () => {
    // What a 0.x lock looks like, and what a kill between creating the lock
    // and recording its owner would leave: a file with nobody to ask about.
    const directory = home()
    const path = join(directory, ".claude.json")
    const lockPath = `${path}.smithers.lock`
    writeFileSync(path, "{}\n")
    writeFileSync(lockPath, "", { mode: 0o600 })

    const fresh = Agents.addMcp(Agents.find("claude")!, directory)

    expect(fresh.status).toBe("failed")
    expect(fresh.reason).toContain(lockPath)
    expect(existsSync(lockPath)).toBe(true)

    const abandoned = new Date(Date.now() - 6 * 60_000)
    utimesSync(lockPath, abandoned, abandoned)

    const wired = Agents.addMcp(Agents.find("claude")!, directory)

    expect(wired.status).toBe("written")
    expect(existsSync(lockPath)).toBe(false)
  })

  it("reports a configuration it cannot write", () => {
    const directory = home()
    // A directory where the file should be: the write fails, and the operator
    // gets the manual instructions instead of a silent success.
    mkdirSync(join(directory, ".claude.json"))

    const wired = Agents.addMcp(Agents.find("claude")!, directory)

    expect(wired.status).toBe("failed")
    // The system code, never `EISDIR: illegal operation on a directory, ...`.
    expect(wired.reason).toBe(
      `${join(directory, ".claude.json")} could not be read (EISDIR). Fix the file, then run this again.`
    )
  })

  it("reports a configuration it cannot even open, and names why", () => {
    const directory = home()
    const path = join(directory, ".claude.json")
    // A path that exists and refuses to open. A self-referential symlink is the
    // deterministic way to say that: `open` answers ELOOP whoever is running,
    // where a mode-stripped file answers nothing at all to root. The point is
    // the arm that is NOT "the file is absent": absence is an empty document
    // this command may write, and every other refusal has to be reported with
    // its reason rather than treated as a fresh configuration and overwritten.
    symlinkSync(path, path)

    const wired = Agents.addMcp(Agents.find("claude")!, directory)

    expect(wired).toMatchObject({ agent: "claude", path, status: "failed" })
    expect(wired.reason).toBe(`${path} could not be read (ELOOP). Fix the file, then run this again.`)
    // The code, never the raw system message.
    expect(wired.reason).not.toContain("too many symbolic links")
    expect(readdirSync(directory)).toEqual([".claude.json"])
  })

  it("writes the profile CLAUDE_CONFIG_DIR selects, not the home directory", () => {
    const directory = home()
    const profile = join(home(), "accounts", "second")

    const wired = Agents.addMcp(Agents.find("claude")!, undefined, {
      HOME: directory,
      CLAUDE_CONFIG_DIR: profile,
      PATH: process.env.PATH
    })

    // Claude Code reads `$CLAUDE_CONFIG_DIR/.claude.json` for such a profile,
    // so an entry under the home directory never reached it.
    expect(wired).toMatchObject({ status: "written", path: join(profile, ".claude.json") })
    expect(JSON.parse(readFileSync(wired.path, "utf8")).mcpServers.smithers.args).toContain("--mcp")
    expect(existsSync(join(directory, ".claude.json"))).toBe(false)
  })

  it("keeps an explicit home separate from an ambient CLAUDE_CONFIG_DIR", () => {
    const directory = home()
    const ambient = home()
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = ambient
    try {
      expect(Agents.addMcp(Agents.find("claude")!, directory).path).toBe(join(directory, ".claude.json"))
      expect(existsSync(join(ambient, ".claude.json"))).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previous
    }
  })

  it("records the memory store the registering environment names, and follows it when it changes", () => {
    const directory = home()
    const claude = Agents.find("claude")!
    const entry = () => JSON.parse(readFileSync(join(directory, ".claude.json"), "utf8")).mcpServers.smithers
    const shared = {
      HOME: directory,
      PATH: process.env.PATH,
      SMITHERS_MEMORY_DB: join(directory, "shared", "memory.db")
    }

    expect(Agents.addMcp(claude, undefined, shared).status).toBe("written")
    expect(entry().env).toEqual({ SMITHERS_MEMORY_DB: join(directory, "shared", "memory.db") })
    expect(Agents.addMcp(claude, undefined, shared).status).toBe("unchanged")

    // A relative store is recorded where it resolves now, not wherever the agent later starts the server.
    expect(Agents.addMcp(claude, undefined, { ...shared, SMITHERS_MEMORY_DB: "relative.db" }).status)
      .toBe("written")
    expect(entry().env).toEqual({ SMITHERS_MEMORY_DB: join(process.cwd(), "relative.db") })

    for (const none of [{ HOME: directory, PATH: process.env.PATH }, { ...shared, SMITHERS_MEMORY_DB: "" }]) {
      Agents.addMcp(claude, undefined, shared)
      expect(Agents.addMcp(claude, undefined, none).status).toBe("written")
      expect(entry()).not.toHaveProperty("env")
    }
  })

  /** A `claude` on PATH that runs `source` for every `mcp` call. */
  const fakeClaude = (source: string): NodeJS.ProcessEnv => {
    const bin = home()
    writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "claude internals: token=abc123" >&2\n${source}\n`)
    chmodSync(join(bin, "claude"), 0o755)
    return { PATH: `${bin}:/usr/bin:/bin` }
  }

  it.each([
    ["claude is missing", undefined, "claude could not be started (ENOENT)"],
    ["mcp add-json fails", "exit 3", "claude mcp add-json failed (exit 3)"],
    ["the entry is not recorded", "exit 0", "Claude Code did not record the Smithers MCP server"],
    [
      "the configuration is unreadable afterwards",
      `printf '[]' > "$HOME/.claude.json"`,
      "Claude Code did not record the Smithers MCP server"
    ]
  ])("reports a failed registration when %s with a Claude sentence, never Claude's own text", (_, source, reason) => {
    const directory = home()
    const environment = source === undefined ? { PATH: "/nonexistent" } : fakeClaude(source)
    const wired = Agents.addMcp(Agents.find("claude")!, undefined, { ...environment, HOME: directory })
    expect(wired).toMatchObject({ agent: "claude", status: "failed", reason })
    expect(wired.reason).not.toMatch(/token|abc123|internals/)
  })

  it("prints instructions that carry the memory store", () => {
    const instructions = Agents.manualInstructions(["claude", "codex"], { SMITHERS_MEMORY_DB: "/srv/memory.db" })

    expect(instructions).toContain("claude mcp add --env SMITHERS_MEMORY_DB=/srv/memory.db smithers -- ")
    expect(instructions).toContain("codex mcp add --env SMITHERS_MEMORY_DB=/srv/memory.db smithers -- ")
    expect(instructions).toContain("\"env\": {\"SMITHERS_MEMORY_DB\":\"/srv/memory.db\"} }")
  })

  it("prints instructions with the separator an agent CLI needs", () => {
    const instructions = Agents.manualInstructions(["claude"])

    // Without `--` the agent's own parser reads `--mcp` as one of its flags
    // and rejects the registration.
    expect(instructions).toContain("claude mcp add smithers -- ")
    expect(instructions).toContain("\"mcpServers\"")
    expect(instructions).toContain(
      "https://github.com/smithersai/smithers/blob/main/packages/smithers/docs/guides/wire-the-mcp-server.md"
    )
    expect(Agents.manualInstructions()).toContain("codex mcp add smithers -- ")
    expect(Agents.manualInstructions(["codex"])).not.toContain("mcpServers")
  })
})

describe("registering with Codex", () => {
  it.each([
    ["no store on either side", undefined, undefined, "unchanged"],
    ["a null store listed and none wanted", null, undefined, "unchanged"],
    ["the same store on both sides", "/srv/memory.db", "/srv/memory.db", "unchanged"],
    ["another store listed", "/srv/other.db", "/srv/memory.db", "failed"],
    ["a store listed and none wanted", "/srv/memory.db", undefined, "failed"],
    ["no store listed and one wanted", undefined, "/srv/memory.db", "failed"]
  ])("compares the listed entry's memory store: %s", (_, listed, wanted, status) => {
    const launch = Agents.launchCommand()
    const bin = home()
    const directory = home()
    // This `codex` lists one fixed entry and accepts every `mcp add` without changing it.
    const servers = [{
      name: "smithers",
      enabled: true,
      transport: {
        type: "stdio",
        command: launch.command,
        args: launch.args,
        ...(listed === undefined ? {} : { env: listed === null ? null : { SMITHERS_MEMORY_DB: listed } })
      }
    }]
    writeFileSync(join(bin, "servers.json"), JSON.stringify(servers))
    writeFileSync(join(bin, "codex"), `#!/bin/sh\nif [ "$2" = "list" ]; then cat "${join(bin, "servers.json")}"; fi\n`)
    chmodSync(join(bin, "codex"), 0o755)

    const wired = Agents.addMcp(Agents.find("codex")!, directory, {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: directory,
      CODEX_HOME: join(directory, ".codex"),
      ...(wanted === undefined ? {} : { SMITHERS_MEMORY_DB: wanted })
    })

    expect(wired.status, wired.reason).toBe(status)
  })

  /** A `codex` on PATH that answers `mcp list --json` with `listed` and exits `status` for `mcp add`. */
  const fakeCodex = (listed: string, status = 0): NodeJS.ProcessEnv => {
    const bin = home()
    const script = join(bin, "codex")
    writeFileSync(
      script,
      `#!/bin/sh\nif [ "$2" = "list" ]; then printf '%s' '${listed}'; exit 0; fi\necho "codex internals: token=abc123" >&2\nexit ${status}\n`
    )
    chmodSync(script, 0o755)
    return { PATH: bin, HOME: home() }
  }

  it.each([
    ["codex is missing", { PATH: "/nonexistent", HOME: "/nonexistent" }, "codex could not be started (ENOENT)"],
    ["mcp add fails", undefined, "codex mcp add failed (exit 3)"],
    ["the server list is not JSON", "not json", "codex mcp list returned an invalid server list"],
    ["the server list is not an array", "{}", "codex mcp list returned an invalid server list"],
    [
      "the entry is not discovered after add",
      "[]",
      "Codex did not discover the enabled Smithers MCP server after registration"
    ]
  ])("reports a failed registration when %s with a Codex sentence, never Codex's own text", (_, input, reason) => {
    const environment = typeof input === "object"
      ? input
      : input === undefined
      ? fakeCodex("[]", 3)
      : fakeCodex(input)
    const directory = home()
    const wired = Agents.addMcp(Agents.find("codex")!, directory, {
      ...environment,
      CODEX_HOME: join(directory, ".codex")
    })
    expect(wired).toMatchObject({ agent: "codex", status: "failed", reason })
    expect(wired.reason).not.toMatch(/token|abc123|internals/)
  })
})
