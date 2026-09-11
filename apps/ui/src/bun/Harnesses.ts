/*
 * Harness detection (LOCAL-APP.md, "Harness detection"): which agent CLIs
 * are installed and which account each is signed into. A dependency-free
 * port of the DETECTORS table in smithers/apps/cli/src/agent-detection.js
 * and the identity readers in agent-commands/accountIdentity.js.
 *
 * Binaries are probed at explicit candidate dirs before PATH, because a
 * Finder launch gets the launchd PATH. Every host read is injectable
 * (`HarnessHost`) so the table can be asserted without a machine's installs.
 * Version probes run in parallel under one timeout so the route never waits
 * on a slow CLI.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, delimiter, join, resolve } from "node:path"
import type { HarnessModelSpec } from "@smthrs/rpc/AgentRoles"
import { HARNESS_IDS } from "@smthrs/rpc/LocalApp"
import type { Harness } from "@smthrs/rpc/LocalApp"
import { currentSandboxHost, probePolicy, wrapSandbox } from "./Sandbox"
import type { SandboxHost } from "./Sandbox"

export type HarnessId = (typeof HARNESS_IDS)[number]

export interface HarnessHost {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  readonly platform: string
  /** Entries of a directory, or [] when it does not exist. */
  readonly listDir: (dir: string) => ReadonlyArray<string>
  /** True for an existing regular file (a symlink to one counts). */
  readonly isFile: (path: string) => boolean
  /** File text, or null when it cannot be read. */
  readonly readText: (path: string) => string | null
  /** `<binary> --version`, or null when it fails or exceeds the timeout. */
  readonly version: (binary: string) => Promise<string | null>
}

/** How long one `--version` may take before it is reported as null. */
export const VERSION_TIMEOUT_MS = 3000

/**
 * The explicit candidate dirs, in order, before PATH. `~/.opencode/bin` is
 * where the opencode installer puts its binary; the rest follow the contract.
 */
export const harnessCandidateDirs = (host: Pick<HarnessHost, "home" | "listDir">): ReadonlyArray<string> => {
  const nvmRoot = join(host.home, ".nvm", "versions", "node")
  const nvm = [...host.listDir(nvmRoot)]
    .filter((entry) => /^v?\d+\.\d+\.\d+/.test(entry))
    .sort((left, right) => compareSemver(right, left))
    .map((entry) => join(nvmRoot, entry, "bin"))
  return [
    join(host.home, ".local", "bin"),
    join(host.home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...nvm,
    join(host.home, ".cargo", "bin"),
    join(host.home, ".opencode", "bin")
  ]
}

const compareSemver = (left: string, right: string): number => {
  const parse = (value: string): [number, number, number] => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value)
    return match === null ? [0, 0, 0] : [Number(match[1]), Number(match[2]), Number(match[3])]
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0)
  }
  return 0
}

/** The first candidate dir, then PATH entry, that holds the binary. */
export const findBinary = (name: string, host: HarnessHost): string | null => {
  const fromPath = (host.env.PATH ?? "").split(delimiter).filter((dir) => dir !== "")
  for (const dir of [...harnessCandidateDirs(host), ...fromPath]) {
    const candidate = join(dir, name)
    if (host.isFile(candidate)) return candidate
  }
  return null
}

const readJson = (host: HarnessHost, path: string): Record<string, unknown> | null => {
  const text = host.readText(path)
  if (text === null) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const readJsonAny = (host: HarnessHost, path: string): unknown => {
  const text = host.readText(path)
  if (text === null) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim() !== ""

/** True when the JSON value holds at least one non-empty string anywhere below. */
const hasNonEmptyStringDeep = (value: unknown, depth = 0): boolean => {
  if (depth > 8) return false
  if (nonEmptyString(value)) return true
  if (Array.isArray(value)) return value.some((entry) => hasNonEmptyStringDeep(entry, depth + 1))
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((entry) => hasNonEmptyStringDeep(entry, depth + 1))
  }
  return false
}

/**
 * A JWT's payload, decoded without verification: the vendor CLI wrote the
 * token into a file only this user can read, and the claims only label the
 * account for the human. Never returns the token itself.
 */
export const decodeJwtClaims = (token: unknown): Record<string, unknown> | null => {
  if (typeof token !== "string") return null
  const payload = token.split(".")[1]
  if (payload === undefined || payload === "") return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const firstEnv = (env: HarnessHost["env"], names: ReadonlyArray<string>): string | undefined =>
  names.find((name) => nonEmptyString(env[name]))

const envDir = (host: HarnessHost, name: string, fallback: string): string => {
  const value = host.env[name]
  return nonEmptyString(value) ? resolve(value) : fallback
}

/** Sign-in state and account, before the binary is considered. */
interface Signal {
  readonly status: Exclude<Harness["status"], "unavailable">
  readonly account: Harness["account"]
}

const binaryOnly: Signal = { status: "binary-only", account: null }

/** The Kimi model OpenCode's "Kimi For Coding" provider serves (`opencode models kimi-for-coding`). */
export const OPENCODE_KIMI_MODEL = "kimi-for-coding/k3"
/** The Cerebras model OpenCode serves for the fast-ui role (`opencode models cerebras`). */
export const OPENCODE_CEREBRAS_MODEL = "cerebras/gpt-oss-120b"

const apiKey = (name: string): Signal => ({ status: "api-key", account: { label: name } })

/** `~/x` for a path below home, so a label stays short. */
const tilde = (host: HarnessHost, path: string): string => (path.startsWith(`${host.home}/`) ? `~${path.slice(host.home.length)}` : path)

/**
 * How a harness takes a model on its command line (docs/workbench-lanes/
 * custom-agents.md): the flag before the model id, the model ids the app has
 * verified for it, and — where the binary has one — the argv that prints one
 * model per line. Every entry is read off the installed binary's own
 * `--help` (2026-09-03, this machine); a harness whose help names no model
 * flag has no entry and never runs as a custom agent (NO INVENTION).
 */
export interface HarnessModels {
  readonly flag: ReadonlyArray<string>
  readonly suggestions: ReadonlyArray<string>
  /** argv[0] is the binary name; the output is one model id per line. */
  readonly list?: ReadonlyArray<string>
}

interface Detector {
  readonly id: HarnessId
  readonly displayName: string
  readonly binary: string
  readonly launch: ReadonlyArray<string>
  readonly models?: HarnessModels
  readonly signal: (host: HarnessHost) => Signal
}

export const DETECTORS: ReadonlyArray<Detector> = [
  {
    id: "claude",
    displayName: "Claude Code",
    binary: "claude",
    launch: ["claude"],
    /* `claude --help`: "--model <model> … an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name (e.g. 'claude-fable-5')". */
    models: { flag: ["--model"], suggestions: ["claude-fable-5", "fable", "opus", "sonnet"] },
    signal: (host) => {
      const state = readJson(host, join(host.home, ".claude.json"))
      const oauth = state?.oauthAccount
      const configDir = envDir(host, "CLAUDE_CONFIG_DIR", join(host.home, ".claude"))
      if (typeof oauth === "object" && oauth !== null) {
        const { emailAddress, organizationName } = oauth as Record<string, unknown>
        return {
          status: "signed-in",
          account: {
            ...(nonEmptyString(emailAddress) ? { email: emailAddress } : {}),
            ...(nonEmptyString(organizationName) ? { label: organizationName } : {})
          }
        }
      }
      if (host.isFile(join(configDir, ".credentials.json"))) return { status: "signed-in", account: null }
      const key = firstEnv(host.env, ["ANTHROPIC_API_KEY"])
      return key === undefined ? binaryOnly : apiKey(key)
    }
  },
  {
    id: "codex",
    displayName: "Codex",
    binary: "codex",
    launch: ["codex"],
    /* `codex --help`: "-m, --model <MODEL>"; the ids are the GPT-5.6 family packages/smithers/agent/model/src/DeferredTools.ts lists. */
    models: { flag: ["-m"], suggestions: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] },
    signal: (host) => {
      const auth = readJson(host, join(envDir(host, "CODEX_HOME", join(host.home, ".codex")), "auth.json"))
      const tokens = auth?.tokens
      if (typeof tokens === "object" && tokens !== null) {
        const { id_token, access_token } = tokens as Record<string, unknown>
        const claims = decodeJwtClaims(id_token)
        const email = claims?.email
        if (nonEmptyString(email)) return { status: "signed-in", account: { email } }
        if (nonEmptyString(id_token) || nonEmptyString(access_token)) return { status: "signed-in", account: null }
      }
      if (nonEmptyString(auth?.OPENAI_API_KEY)) return { status: "api-key", account: { label: "auth.json OPENAI_API_KEY" } }
      const key = firstEnv(host.env, ["OPENAI_API_KEY"])
      return key === undefined ? binaryOnly : apiKey(key)
    }
  },
  {
    id: "gemini",
    displayName: "Gemini",
    binary: "gemini",
    launch: ["gemini"],
    /* `gemini --help`: "-m, --model  Model [string]"; it names no ids, so the field is free text. */
    models: { flag: ["--model"], suggestions: [] },
    signal: (host) => {
      const root = envDir(host, "GEMINI_DIR", join(host.home, ".gemini"))
      if (host.isFile(join(root, "oauth_creds.json"))) {
        const accounts = readJson(host, join(root, "google_accounts.json"))
        const active = accounts?.active
        return { status: "signed-in", account: nonEmptyString(active) ? { email: active } : null }
      }
      const key = firstEnv(host.env, ["GEMINI_API_KEY", "GOOGLE_API_KEY"])
      return key === undefined ? binaryOnly : apiKey(key)
    }
  },
  {
    id: "kimi",
    displayName: "Kimi",
    binary: "kimi",
    launch: ["kimi"],
    /* `kimi --help`: "--model -m TEXT  LLM model to use"; it names no ids. */
    models: { flag: ["--model"], suggestions: [] },
    signal: (host) => {
      const share = envDir(host, "KIMI_SHARE_DIR", join(host.home, ".kimi"))
      if (host.isFile(join(share, "credentials", "kimi-code.json"))) {
        return { status: "signed-in", account: { label: "kimi-code" } }
      }
      return binaryOnly
    }
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    binary: "opencode",
    launch: ["opencode"],
    /* `opencode --model provider/model`; `opencode models` prints every provider/model it can serve, one per line. */
    models: { flag: ["--model"], suggestions: [OPENCODE_KIMI_MODEL, OPENCODE_CEREBRAS_MODEL], list: ["opencode", "models"] },
    signal: (host) => {
      const auth = readJson(host, join(host.home, ".local", "share", "opencode", "auth.json"))
      const providers = auth === null ? [] : Object.keys(auth).filter((id) => hasNonEmptyStringDeep(auth[id]))
      if (providers.length > 0) return { status: "signed-in", account: { label: providers.join(", ") } }
      const key = firstEnv(host.env, [
        "OPENCODE_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "KIMI_API_KEY"
      ])
      return key === undefined ? binaryOnly : apiKey(key)
    }
  },
  /*
   * OpenCode on the Kimi credential. `opencode providers list` (1.18.22)
   * names the provider "Kimi For Coding", read from KIMI_API_KEY, and
   * `opencode models kimi-for-coding` lists k3 as its model; `-m` takes
   * provider/model. Same binary as `opencode`, so an absent binary reads
   * unavailable exactly like the plain entry, and a present binary with no
   * Kimi credential is binary-only rather than a launch that fails inside.
   */
  {
    id: "opencode-kimi",
    displayName: "OpenCode · Kimi",
    binary: "opencode",
    launch: ["opencode", "--model", OPENCODE_KIMI_MODEL],
    models: { flag: ["--model"], suggestions: [OPENCODE_KIMI_MODEL], list: ["opencode", "models", "kimi-for-coding"] },
    signal: (host) => {
      const auth = readJson(host, join(host.home, ".local", "share", "opencode", "auth.json"))
      if (auth !== null && hasNonEmptyStringDeep(auth["kimi-for-coding"])) {
        return { status: "signed-in", account: { label: "kimi-for-coding" } }
      }
      const key = firstEnv(host.env, ["KIMI_API_KEY"])
      return key === undefined ? binaryOnly : apiKey(key)
    }
  },
  /*
   * OpenCode on the Cerebras credential (the "fast-ui" role): `opencode
   * providers list` (1.18.22) names "Cerebras", read from CEREBRAS_API_KEY,
   * and `opencode models cerebras` lists gpt-oss-120b and gemma-4-31b.
   */
  {
    id: "opencode-cerebras",
    displayName: "OpenCode · Cerebras",
    binary: "opencode",
    launch: ["opencode", "--model", OPENCODE_CEREBRAS_MODEL],
    models: { flag: ["--model"], suggestions: [OPENCODE_CEREBRAS_MODEL, "cerebras/gemma-4-31b"], list: ["opencode", "models", "cerebras"] },
    signal: (host) => {
      const auth = readJson(host, join(host.home, ".local", "share", "opencode", "auth.json"))
      if (auth !== null && hasNonEmptyStringDeep(auth["cerebras"])) {
        return { status: "signed-in", account: { label: "cerebras" } }
      }
      const key = firstEnv(host.env, ["CEREBRAS_API_KEY"])
      return key === undefined ? binaryOnly : apiKey(key)
    }
  },
  {
    id: "crush",
    displayName: "Crush",
    binary: "crush",
    launch: ["crush"],
    signal: (host) => {
      const key = firstEnv(host.env, ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"])
      if (key !== undefined) return apiKey(key)
      const configs = [
        join(host.home, ".local", "share", "crush", "providers.json"),
        join(host.home, ".config", "crush", "crush.json")
      ]
      const found = configs.find((path) => hasNonEmptyStringDeep(readJsonAny(host, path)))
      return found === undefined ? binaryOnly : { status: "signed-in", account: { label: tilde(host, found) } }
    }
  },
  {
    id: "amp",
    displayName: "Amp",
    binary: "amp",
    launch: ["amp"],
    signal: (host) => {
      const key = firstEnv(host.env, ["AMP_API_KEY"])
      if (key !== undefined) return apiKey(key)
      const secrets = join(host.home, ".config", "amp", "secrets.json")
      return hasNonEmptyStringDeep(readJsonAny(host, secrets))
        ? { status: "signed-in", account: { label: tilde(host, secrets) } }
        : binaryOnly
    }
  },
  {
    id: "cursor-agent",
    displayName: "Cursor Agent",
    binary: "cursor-agent",
    launch: ["cursor-agent"],
    /* `cursor-agent --help`: "--model <model>  Model to use (e.g., gpt-5, sonnet-4, sonnet-4-thinking)". */
    models: { flag: ["--model"], suggestions: ["gpt-5", "sonnet-4", "sonnet-4-thinking"] },
    signal: (host) => {
      const key = firstEnv(host.env, ["CURSOR_API_KEY"])
      if (key !== undefined) return apiKey(key)
      const auth = host.platform === "darwin"
        ? join(host.home, ".cursor", "auth.json")
        : join(envDir(host, "XDG_CONFIG_HOME", join(host.home, ".config")), "cursor", "auth.json")
      return hasNonEmptyStringDeep(readJsonAny(host, auth))
        ? { status: "signed-in", account: { label: tilde(host, auth) } }
        : binaryOnly
    }
  },
  {
    id: "hermes",
    displayName: "Hermes",
    binary: "hermes",
    launch: ["hermes"],
    /* `hermes --help`: "-m MODEL, --model MODEL  Model override for this invocation (e.g. anthropic/claude-sonnet-4.6)"; `hermes model` is an interactive picker, not a list. */
    models: { flag: ["--model"], suggestions: ["anthropic/claude-sonnet-4.6"] },
    signal: (host) => {
      const auth = join(host.home, ".hermes", "auth.json")
      if (hasNonEmptyStringDeep(readJsonAny(host, auth))) return { status: "signed-in", account: { label: tilde(host, auth) } }
      const config = join(host.home, ".hermes", "config.yaml")
      return host.isFile(config) ? { status: "signed-in", account: { label: tilde(host, config) } } : binaryOnly
    }
  },
  {
    id: "pi",
    displayName: "Pi",
    binary: "pi",
    launch: ["pi"],
    signal: (host) => {
      const auth = join(host.home, ".pi", "agent", "auth.json")
      return hasNonEmptyStringDeep(readJsonAny(host, auth))
        ? { status: "signed-in", account: { label: tilde(host, auth) } }
        : binaryOnly
    }
  }
]

/** "2.1.247 (Claude Code)" -> "2.1.247"; "crush version v0.1.11" -> "0.1.11"; else the first line. */
export const parseVersionLine = (output: string): string | null => {
  const firstLine = output.split("\n").map((line) => line.trim()).find((line) => line !== "")
  if (firstLine === undefined) return null
  const match = /\d+\.\d+(?:\.\d+)?[0-9A-Za-z.+-]*/.exec(firstLine)
  return match === null ? firstLine : match[0]
}

/** The model table for one harness id, or undefined when its help names no model flag the app verified. */
export const harnessModels = (id: string): HarnessModels | undefined => DETECTORS.find((detector) => detector.id === id)?.models

/** What `roleLaunchArgv` composes with: the harness's binary name and its model flag. */
export const harnessModelSpec = (id: string): HarnessModelSpec | undefined => {
  const detector = DETECTORS.find((candidate) => candidate.id === id)
  return detector?.models === undefined ? undefined : { binary: detector.binary, flag: detector.models.flag }
}

/** The harness table for one host: every id, in contract order, whether installed or not. */
export const detectHarnessesWith = async (host: HarnessHost): Promise<Array<Harness>> => {
  const found = DETECTORS.map((detector) => ({ detector, binary: findBinary(detector.binary, host) }))
  const versions = await Promise.all(found.map(({ binary }) => (binary === null ? Promise.resolve(null) : host.version(binary))))
  return found.map(({ detector, binary }, index) => {
    const signal = binary === null ? null : detector.signal(host)
    return {
      id: detector.id,
      displayName: detector.displayName,
      binary,
      version: versions[index] ?? null,
      status: signal === null ? "unavailable" : signal.status,
      account: signal === null ? null : signal.account,
      launch: { argv: [...detector.launch] },
      ...(detector.models === undefined
        ? {}
        : { models: { suggestions: [...detector.models.suggestions], listable: detector.models.list !== undefined } })
    }
  })
}

/** Versions change with a reinstall, not between two menu opens: one probe per binary path per process. */
const versionCache = new Map<string, Promise<string | null>>()

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

/**
 * The environment a probe child gets: these keys and nothing else, so a
 * session token (SMITHERS_CLOUD_TOKEN, GITHUB_TOKEN) never reaches a CLI
 * that only reports its version or its models.
 */
export const PROBE_ENV_KEYS = [
  // Resolving the binary, its interpreter (`#!/usr/bin/env node`) and its own config.
  "HOME",
  "PATH",
  "TMPDIR",
  // Output encoding.
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  // Where opencode keeps its config, auth.json and model cache.
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "OPENCODE_CONFIG",
  // `opencode models` lists a provider only when its credential is present; these are the ones DETECTORS reads.
  "OPENCODE_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "KIMI_API_KEY",
  "CEREBRAS_API_KEY",
  "OPENROUTER_API_KEY"
] as const

/** The probe child environment: PROBE_ENV_KEYS from `source`, plus NO_COLOR. */
export const probeEnv = (source: Readonly<Record<string, string | undefined>>): Record<string, string> => {
  const env: Record<string, string> = { NO_COLOR: "1" }
  for (const key of PROBE_ENV_KEYS) {
    const value = source[key]
    if (value !== undefined && value !== "") env[key] = value
  }
  return env
}

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
