/*
 * The sandbox policy for every process the local app spawns (LOCAL-APP.md,
 * "Sandbox"). Policies are data: a policy names what a spawn may write and
 * whether it may reach the network, `renderProfile` turns it into seatbelt
 * text, and `wrapSandbox` prefixes an argv with `/usr/bin/sandbox-exec`.
 *
 * `wrapSandbox` reads only its arguments. The host facts it needs (platform,
 * the SMITHERS_SANDBOX switch) arrive as a `SandboxHost`, so tests can assert
 * the generated profile and the unenforced branches without touching the
 * process environment.
 */

export type SandboxPolicyId = "loader" | "harness" | "terminal" | "probe" | "lsp"

export interface SandboxPolicy {
  readonly id: SandboxPolicyId
  readonly network: "allow" | "deny"
  /** Directories the spawn may write anywhere below. Absolute paths. */
  readonly writableDirs: ReadonlyArray<string>
  /** Single files the spawn may write. Absolute paths. */
  readonly writableFiles: ReadonlyArray<string>
  /**
   * Path prefixes the spawn may write: the file itself and every sibling
   * that extends its name. Atomic saves write `<file>.tmp.<pid>` then
   * rename, and zsh keeps `<HISTFILE>.new`, `<HISTFILE>.LOCK` and one
   * `.zcompdump-<host>-<version>` per shell version, so a literal rule
   * for the file alone breaks the save.
   */
  readonly writablePrefixes: ReadonlyArray<string>
}

/** What a policy is built from: the repository and the host's well-known dirs. */
export interface SandboxPaths {
  readonly repo: string
  readonly home: string
  readonly tmpdir: string
}

const HOME_DOT_DIRS = [".claude", ".codex", ".gemini", ".kimi", ".config", ".cache", ".local"] as const
const HOME_DOT_FILES = [".claude.json"] as const
/** Claude Code saves `~/.claude.json` through `~/.claude.json.tmp.<pid>.<random>` plus rename. */
const HOME_DOT_PREFIXES = [".claude.json"] as const
/** zsh's history (`HISTFILE`, its `.new` and `.LOCK` siblings) and the completion dump. */
const ZSH_PREFIXES = [".zsh_history", ".zcompdump"] as const

const unique = (paths: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(paths.filter((path) => path !== ""))]

/**
 * macOS keeps `/var`, `/tmp` and `/etc` as symlinks into `/private`, and
 * seatbelt matches the resolved path, so a rule for `$TMPDIR`
 * (`/var/folders/...`) only holds when its `/private` twin is listed too.
 */
export const privateAliases = (dirs: ReadonlyArray<string>): ReadonlyArray<string> =>
  unique(dirs.flatMap((dir) => (/^\/(var|tmp|etc)(\/|$)/.test(dir) ? [dir, `/private${dir}`] : [dir])))

const scratchDirs = (paths: SandboxPaths): ReadonlyArray<string> => privateAliases([paths.tmpdir, "/private/tmp"])

const homeDotDirs = (paths: SandboxPaths): ReadonlyArray<string> => HOME_DOT_DIRS.map((dir) => `${paths.home}/${dir}`)

const homeDotFiles = (paths: SandboxPaths): ReadonlyArray<string> => HOME_DOT_FILES.map((file) => `${paths.home}/${file}`)

const homeDotPrefixes = (paths: SandboxPaths): ReadonlyArray<string> =>
  HOME_DOT_PREFIXES.map((prefix) => `${paths.home}/${prefix}`)

const zshPrefixes = (paths: SandboxPaths): ReadonlyArray<string> => ZSH_PREFIXES.map((prefix) => `${paths.home}/${prefix}`)

/** `smithers-build query`: no network; writes only the repo's `.flows` cache and scratch. */
export const loaderPolicy = (paths: SandboxPaths): SandboxPolicy => ({
  id: "loader",
  network: "deny",
  writableDirs: unique([`${paths.repo}/.flows`, ...scratchDirs(paths)]),
  writableFiles: [],
  writablePrefixes: []
})

/**
 * A read-only probe (`git -C` repo facts, `<bin> --version`): no network;
 * writes only scratch. The probe has no repo, so only `tmpdir` is read.
 */
export const probePolicy = (paths: Pick<SandboxPaths, "tmpdir">): SandboxPolicy => ({
  id: "probe",
  network: "deny",
  writableDirs: privateAliases([paths.tmpdir, "/private/tmp"]),
  writableFiles: [],
  writablePrefixes: []
})

/**
 * A language server (`typescript-language-server --stdio`, lsp/LspHost.ts):
 * no network (typings acquisition is off; a missing server is stated, never
 * installed) and writes only scratch. It reads the repository; it never
 * writes it, and the repository is not part of the policy.
 */
export const lspPolicy = (paths: Pick<SandboxPaths, "tmpdir">): SandboxPolicy => ({
  ...probePolicy(paths),
  id: "lsp"
})

/** A harness tab (claude, codex, ...): network on; writes the repo, its config dirs and scratch. */
export const harnessPolicy = (paths: SandboxPaths): SandboxPolicy => ({
  id: "harness",
  network: "allow",
  writableDirs: unique([paths.repo, ...homeDotDirs(paths), ...scratchDirs(paths)]),
  writableFiles: unique(homeDotFiles(paths)),
  writablePrefixes: unique(homeDotPrefixes(paths))
})

/** A terminal tab: the harness confinement plus the shell's own history and completion dump. */
export const terminalPolicy = (paths: SandboxPaths): SandboxPolicy => ({
  id: "terminal",
  network: "allow",
  writableDirs: unique([paths.repo, ...homeDotDirs(paths), ...scratchDirs(paths)]),
  writableFiles: unique(homeDotFiles(paths)),
  writablePrefixes: unique([...homeDotPrefixes(paths), ...zshPrefixes(paths)])
})

export const sandboxPolicies: Readonly<Record<SandboxPolicyId, (paths: SandboxPaths) => SandboxPolicy>> = {
  loader: loaderPolicy,
  harness: harnessPolicy,
  terminal: terminalPolicy,
  probe: probePolicy,
  lsp: lspPolicy
}

/** Seatbelt string literal: backslashes and double quotes escaped. */
const seatbeltString = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`

/** Seatbelt regex literal anchored at the start of the path: metacharacters escaped, quotes too. */
const seatbeltPrefixRegex = (value: string): string =>
  `#"^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/"/g, "\\\"")}"`

/**
 * The seatbelt profile for a policy. Later rules win in seatbelt, so the
 * profile allows everything, denies every write (and the network when the
 * policy says so), then re-allows the policy's writable paths plus the
 * device nodes an interactive process needs.
 */
export const renderProfile = (policy: SandboxPolicy): string => {
  const lines = [
    "(version 1)",
    `; smithers local app: ${policy.id}`,
    "(allow default)",
    ...(policy.network === "deny" ? ["(deny network*)"] : []),
    "(deny file-write*)",
    "(allow file-write* (literal \"/dev/null\") (regex #\"^/dev/tty\") (regex #\"^/dev/pty\") (regex #\"^/dev/fd/\"))",
    ...policy.writableDirs.map((dir) => `(allow file-write* (subpath ${seatbeltString(dir)}))`),
    ...policy.writableFiles.map((file) => `(allow file-write* (literal ${seatbeltString(file)}))`),
    ...policy.writablePrefixes.map((prefix) => `(allow file-write* (regex ${seatbeltPrefixRegex(prefix)}))`)
  ]
  return `${lines.join("\n")}\n`
}

export interface SandboxHost {
  /** `process.platform`. Only "darwin" enforces. */
  readonly platform: string
  /** `SMITHERS_SANDBOX=off` disables wrapping everywhere. */
  readonly disabled: boolean
  readonly log: (line: string) => void
}

export const currentSandboxHost = (env: Record<string, string | undefined> = Bun.env): SandboxHost => ({
  platform: process.platform,
  disabled: env.SMITHERS_SANDBOX === "off",
  log: (line) => console.error(line)
})

export interface WrappedSpawn {
  readonly argv: ReadonlyArray<string>
  readonly enforced: boolean
}

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec"

/** Whether spawns on this host run under seatbelt. */
export const sandboxEnforced = (host: SandboxHost): boolean => host.platform === "darwin" && !host.disabled

export const wrapSandbox = (
  argv: ReadonlyArray<string>,
  policy: SandboxPolicy,
  host: SandboxHost = currentSandboxHost()
): WrappedSpawn => {
  if (host.disabled) {
    host.log(`sandbox: disabled by SMITHERS_SANDBOX=off (${policy.id})`)
    return { argv, enforced: false }
  }
  if (host.platform !== "darwin") {
    host.log("sandbox: unenforced on this platform")
    return { argv, enforced: false }
  }
  return { argv: [SANDBOX_EXEC, "-p", renderProfile(policy), ...argv], enforced: true }
}
