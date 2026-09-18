/*
 * The Bun adapter for harness detection (LOCAL-APP.md, "Harness detection").
 *
 * The table itself — which CLIs exist, which account each is signed into,
 * how each takes a model — is `@smthrs/harness-detect`, which reads nothing
 * and spawns nothing. This file is the half that touches the machine: Bun's
 * environment, `node:fs`, and a `--version` child under the app's probe
 * seatbelt.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename } from "node:path"
import { detectHarnessesWith, parseVersionLine, probeEnv, VERSION_TIMEOUT_MS } from "@smthrs/harness-detect"
import type { HarnessHost } from "@smthrs/harness-detect"
import type { Harness } from "@smthrs/rpc/LocalApp"
import { currentSandboxHost, probePolicy, wrapSandbox } from "./Sandbox"
import type { SandboxHost } from "./Sandbox"

/**
 * Probes that fail under the probe seatbelt profile and run unwrapped
 * instead. An entry is a binary basename (every probe of it) or
 * `<basename> <subcommand>` (that probe only).
 * amp: writes under `~/.cache` (beyond `~/.cache/amp`) on every invocation
 * and aborts when `(deny file-write*)` blocks it.
 * opencode models: opens `~/.local/share/opencode/log/opencode.log` for
 * writing and exits 1 when the profile blocks it (1.18.30); its
 * `--version` runs sandboxed.
 */
const PROBE_SANDBOX_EXCEPTIONS: ReadonlySet<string> = new Set(["amp", "opencode models"])

/** Seatbelt matches resolved paths, so the scratch dir the probe may write is canonicalised. */
const probeTmpdir = (): string => {
  try {
    return realpathSync(tmpdir())
  } catch {
    return tmpdir()
  }
}

/**
 * A read-only probe argv (`<binary> --version`, `<binary> models`) under the
 * probe policy: no network, writes confined to scratch. A PROBE_SANDBOX_EXCEPTIONS
 * entry runs unwrapped.
 */
export const wrapProbe = (argv: ReadonlyArray<string>, host: SandboxHost = currentSandboxHost()): ReadonlyArray<string> => {
  const name = basename(argv[0] ?? "")
  if (PROBE_SANDBOX_EXCEPTIONS.has(name) || PROBE_SANDBOX_EXCEPTIONS.has(`${name} ${argv[1] ?? ""}`)) return argv
  return wrapSandbox(argv, probePolicy({ tmpdir: probeTmpdir() }), host).argv
}

/** Versions change with a reinstall, not between two menu opens: one probe per binary path per process. */
const versionCache = new Map<string, Promise<string | null>>()

const runVersion = (binary: string): Promise<string | null> => {
  const cached = versionCache.get(binary)
  if (cached !== undefined) return cached
  const probe = (async (): Promise<string | null> => {
    try {
      const child = Bun.spawn([...wrapProbe([binary, "--version"])], {
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
        timeout: VERSION_TIMEOUT_MS,
        killSignal: "SIGKILL",
        env: probeEnv(process.env)
      })
      const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
      return code === 0 ? parseVersionLine(stdout) : null
    } catch {
      return null
    }
  })()
  versionCache.set(binary, probe)
  // A failed or timed-out probe is retried on the next call.
  void probe.then((version) => {
    if (version === null) versionCache.delete(binary)
  })
  return probe
}

/** This process's filesystem, environment and version probe as a `HarnessHost`. */
export const currentHarnessHost = (env: Readonly<Record<string, string | undefined>> = Bun.env): HarnessHost => ({
  env,
  home: env.HOME ?? homedir(),
  platform: process.platform,
  listDir: (dir) => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  },
  isFile: (path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
  readText: (path) => {
    try {
      return readFileSync(path, "utf8")
    } catch {
      return null
    }
  },
  version: runVersion
})

export const detectHarnesses = (env?: Readonly<Record<string, string | undefined>>): Promise<Array<Harness>> =>
  detectHarnessesWith(currentHarnessHost(env))
