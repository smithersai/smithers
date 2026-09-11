import { describe, expect, test } from "bun:test"
import {
  harnessPolicy,
  loaderPolicy,
  lspPolicy,
  privateAliases,
  probePolicy,
  renderProfile,
  SANDBOX_EXEC,
  sandboxEnforced,
  sandboxPolicies,
  terminalPolicy,
  wrapSandbox
} from "./Sandbox"
import type { SandboxHost } from "./Sandbox"

const paths = { repo: "/work/force", home: "/Users/u", tmpdir: "/var/folders/xx/T" }

const host = (overrides: Partial<SandboxHost> = {}): SandboxHost & { readonly lines: Array<string> } => {
  const lines: Array<string> = []
  return { platform: "darwin", disabled: false, log: (line) => lines.push(line), lines, ...overrides }
}

describe("sandbox policies are data", () => {
  test("the loader denies the network and writes only .flows and scratch", () => {
    const policy = loaderPolicy(paths)
    expect(policy.network).toBe("deny")
    expect(policy.writableDirs).toEqual(["/work/force/.flows", "/var/folders/xx/T", "/private/var/folders/xx/T", "/private/tmp"])
    expect(policy.writableFiles).toEqual([])
    expect(policy.writablePrefixes).toEqual([])
  })

  test("scratch dirs under /var, /tmp and /etc carry their /private twin (seatbelt matches the resolved path)", () => {
    expect(privateAliases(["/var/folders/xx/T", "/private/tmp", "/tmp", "/Users/u/.cache"])).toEqual([
      "/var/folders/xx/T",
      "/private/var/folders/xx/T",
      "/private/tmp",
      "/tmp",
      "/Users/u/.cache"
    ])
  })

  test("a probe denies the network and writes only scratch (no repo, no $HOME)", () => {
    const policy = probePolicy({ tmpdir: "/var/folders/xx/T" })
    expect(policy.id).toBe("probe")
    expect(policy.network).toBe("deny")
    expect(policy.writableDirs).toEqual(["/var/folders/xx/T", "/private/var/folders/xx/T", "/private/tmp"])
    expect(policy.writableFiles).toEqual([])
    expect(policy.writablePrefixes).toEqual([])
  })

  test("the probe profile denies writes everywhere but scratch and the device nodes", () => {
    const profile = renderProfile(probePolicy({ tmpdir: "/var/folders/xx/T" }))
    expect(profile).toContain("(deny network*)")
    expect(profile).toContain("(deny file-write*)")
    expect(profile).toContain("(allow file-write* (subpath \"/private/var/folders/xx/T\"))")
    expect(profile).toContain("(allow file-write* (subpath \"/private/tmp\"))")
    expect(profile).not.toContain("subpath \"/Users")
    expect(profile).not.toContain("subpath \"/work")
  })

  test("a language server denies the network and writes only scratch: never the repo, never $HOME", () => {
    const policy = lspPolicy(paths)
    expect(policy.id).toBe("lsp")
    expect(policy.network).toBe("deny")
    expect(policy.writableDirs).toEqual(["/var/folders/xx/T", "/private/var/folders/xx/T", "/private/tmp"])
    expect(policy.writableFiles).toEqual([])
    expect(policy.writablePrefixes).toEqual([])
    expect(sandboxPolicies.lsp).toBe(lspPolicy)
  })

  test("the lsp profile is the probe's confinement under its own id", () => {
    const profile = renderProfile(lspPolicy(paths))
    expect(profile).toBe(renderProfile(probePolicy(paths)).replace("; smithers local app: probe", "; smithers local app: lsp"))
    expect(profile).toContain("(deny network*)")
    expect(profile).not.toContain("subpath \"/work")
    expect(profile).not.toContain("subpath \"/Users")
  })

  test("a harness keeps the network and writes the repo, its config dirs and scratch", () => {
    const policy = harnessPolicy(paths)
    expect(policy.network).toBe("allow")
    expect(policy.writableDirs).toEqual([
      "/work/force",
      "/Users/u/.claude",
      "/Users/u/.codex",
      "/Users/u/.gemini",
      "/Users/u/.kimi",
      "/Users/u/.config",
      "/Users/u/.cache",
      "/Users/u/.local",
      "/var/folders/xx/T",
      "/private/var/folders/xx/T",
      "/private/tmp"
    ])
    expect(policy.writableFiles).toEqual(["/Users/u/.claude.json"])
    // Claude Code saves ~/.claude.json through ~/.claude.json.tmp.<pid>.<random> + rename.
    expect(policy.writablePrefixes).toEqual(["/Users/u/.claude.json"])
  })

  test("a terminal is confined like a harness plus zsh's history and completion dump", () => {
    expect(terminalPolicy(paths)).toEqual({
      ...harnessPolicy(paths),
      id: "terminal",
      writablePrefixes: ["/Users/u/.claude.json", "/Users/u/.zsh_history", "/Users/u/.zcompdump"]
    })
  })
})

describe("the seatbelt profile", () => {
  test("starts with (version 1), denies writes, then re-allows the policy's paths", () => {
    const profile = renderProfile(loaderPolicy(paths))
    const lines = profile.trim().split("\n")
    expect(lines[0]).toBe("(version 1)")
    expect(lines).toContain("(allow default)")
    expect(lines).toContain("(deny network*)")
    expect(lines).toContain("(deny file-write*)")
    expect(lines).toContain("(allow file-write* (subpath \"/work/force/.flows\"))")
    expect(lines).toContain("(allow file-write* (subpath \"/private/tmp\"))")
    // Order matters: later rules win, so the deny precedes every allow.
    expect(lines.indexOf("(deny file-write*)")).toBeLessThan(
      lines.indexOf("(allow file-write* (subpath \"/work/force/.flows\"))")
    )
  })

  test("a network-allow policy emits no network rule and lists literal files and prefix regexes", () => {
    const profile = renderProfile(harnessPolicy(paths))
    expect(profile).not.toContain("(deny network*)")
    expect(profile).toContain("(allow file-write* (literal \"/Users/u/.claude.json\"))")
    expect(profile).toContain("(allow file-write* (regex #\"^/Users/u/\\.claude\\.json\"))")
    expect(profile).toContain("(allow file-write* (subpath \"/private/var/folders/xx/T\"))")
    expect(profile).not.toContain("zsh_history")
  })

  test("the terminal profile re-allows the shell's history and compdump by prefix, never the rest of $HOME", () => {
    const profile = renderProfile(terminalPolicy(paths))
    expect(profile).toContain("(allow file-write* (regex #\"^/Users/u/\\.zsh_history\"))")
    expect(profile).toContain("(allow file-write* (regex #\"^/Users/u/\\.zcompdump\"))")
    expect(profile).not.toContain("(allow file-write* (subpath \"/Users/u\"))")
    // The deny still precedes every allow.
    const lines = profile.trim().split("\n")
    expect(lines.indexOf("(deny file-write*)")).toBeLessThan(lines.findIndex((line) => line.includes("zsh_history")))
  })

  test("every device node an interactive child needs is re-allowed", () => {
    const profile = renderProfile(terminalPolicy(paths))
    expect(profile).toContain("(regex #\"^/dev/tty\")")
    expect(profile).toContain("(regex #\"^/dev/pty\")")
    expect(profile).toContain("(literal \"/dev/null\")")
  })

  test("quotes in paths are escaped", () => {
    const profile = renderProfile(loaderPolicy({ ...paths, repo: "/work/a\"b" }))
    expect(profile).toContain("(subpath \"/work/a\\\"b/.flows\")")
  })
})

describe("wrapSandbox", () => {
  test("on macOS wraps with sandbox-exec -p <profile>", () => {
    const h = host()
    const wrapped = wrapSandbox(["node", "cli.js", "query"], loaderPolicy(paths), h)
    expect(wrapped.enforced).toBe(true)
    expect(wrapped.argv.slice(0, 2)).toEqual([SANDBOX_EXEC, "-p"])
    expect(wrapped.argv[2]).toBe(renderProfile(loaderPolicy(paths)))
    expect(wrapped.argv.slice(3)).toEqual(["node", "cli.js", "query"])
    expect(h.lines).toEqual([])
    expect(sandboxEnforced(h)).toBe(true)
  })

  test("elsewhere returns argv unchanged with one log line", () => {
    const h = host({ platform: "linux" })
    const argv = ["bash"]
    const wrapped = wrapSandbox(argv, terminalPolicy(paths), h)
    expect(wrapped).toEqual({ argv, enforced: false })
    expect(h.lines).toEqual(["sandbox: unenforced on this platform"])
    expect(sandboxEnforced(h)).toBe(false)
  })

  test("SMITHERS_SANDBOX=off disables wrapping everywhere, logged", () => {
    const h = host({ disabled: true })
    const wrapped = wrapSandbox(["claude"], harnessPolicy(paths), h)
    expect(wrapped).toEqual({ argv: ["claude"], enforced: false })
    expect(h.lines).toEqual(["sandbox: disabled by SMITHERS_SANDBOX=off (harness)"])
    expect(sandboxEnforced(h)).toBe(false)
  })
})
