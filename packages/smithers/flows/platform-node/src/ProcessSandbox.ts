/**
 * The one operating-system sandbox every confined process goes through.
 *
 * A caller resolves what a run may touch, a {@link Request}: the network
 * posture, the read and write sets, and optionally which mechanism it wants.
 * This module turns the request into an argv the host enforces, or into an
 * {@link Unenforceable} refusal naming what the host lacks. Two callers share
 * it: the build graph confines every target's tool run under its declared
 * inputs and outputs (`@smthrs/targets/ExecSandbox`), and the Node
 * `ProcessConfinement` confines every approved agent command under the
 * grants in force.
 *
 * Three mechanisms, one contract:
 *
 * - Linux: bubblewrap. An empty root contains only enumerated system/runtime
 *   paths and declared reads and writes. The workspace and root are remounted
 *   read-only after mounting grants, unless the request asks for a scratch
 *   layer that takes undeclared workspace writes and is discarded with the
 *   run. A private tmp supplies HOME. The network
 *   namespace is unshared unless explicitly opened; loopback-only is refused.
 * - macOS: seatbelt (`sandbox-exec`). Host reads are denied except enumerated
 *   system/runtime paths, declared inputs, external reads, writes and private
 *   tmp. Host credential locations are re-closed under broad grants. Writes
 *   and network access are denied except what the request opens.
 * - Docker: `docker run` with a read-only root, declared reads mounted
 *   read-only at their host paths, declared writes read-write, `--network
 *   none` unless the request opens it. The image supplies the toolchain. It is
 *   the path on Windows and on any host without the native mechanism.
 *
 * Every declared confinement is enforced or the caller fails closed. Nothing
 * here logs "unenforced" and carries on; the one caller that may run
 * unconfined when no mechanism exists, `ProcessConfinement`, says so in its
 * own options and never on this module's behalf.
 *
 * @since 1.0.0-rc.1
 */

import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { destinationBrokerRoot } from "./internal/DestinationBrokerRoot.ts"

/**
 * The network posture a run is confined to. `"none"` closes IP networking.
 * Build tools retain host Unix sockets by default. Native agent confinement
 * additionally closes host Unix sockets regardless of the IP posture, except
 * macOS's system DNS resolver endpoint when IP networking is open, and
 * refuses all Linux socket creation when IP networking is closed;
 * socketpair remains available for communication inside the process family.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export type Network = "none" | "loopback" | "open"

/**
 * Which mechanism a request asks for. Absent means the platform's native
 * mechanism: bubblewrap on Linux, seatbelt on macOS.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export type Selection =
  | { readonly _tag: "bubblewrap" }
  | { readonly _tag: "docker"; readonly image: string }

/**
 * What a caller asks for: the network posture, the mechanism choice, and the
 * read and write sets. Every path is workspace-relative and posix-shaped;
 * a read may name a file or a directory, a write names a directory. A
 * `readOnly` entry re-closes a subtree under a declared write.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Request {
  readonly network: Network
  /**
   * Symbolic links the run sees as links: each exists at its path with its
   * target string, and grants nothing through it. A request names the path
   * workspace-relative; a plan names it absolute.
   */
  readonly links?: ReadonlyArray<Link> | undefined
  /** Whether host Unix sockets are permitted; defaults to true for build tools. */
  readonly unixSockets?: boolean | undefined
  /** Closed-by-default process and IPC policy for untrusted native commands. */
  readonly strict?: boolean | undefined
  readonly mechanism?: Selection | undefined
  readonly reads: ReadonlyArray<string>
  readonly writes: ReadonlyArray<string>
  /**
   * Declared outputs whose leaf is a file rather than a directory. A file
   * cannot be bound writable on its own and does not exist before the tool
   * writes it, so its parent directory becomes the writable bind. Kept apart
   * from `writes` because only the caller knows which of the two a
   * declaration meant: inferring it from the path would hand a not-yet-created
   * `.cargo-home` or `dist.new` its parent, and a parent that is the
   * workspace root opens the whole workspace for the run.
   */
  readonly writeFiles?: ReadonlyArray<string> | undefined
  readonly readOnly?: ReadonlyArray<string> | undefined
  /**
   * Absolute host paths outside the workspace the tool reads: a git
   * submodule's local source repository, for one. Bound read-only where the
   * mechanism would otherwise hide them; a path that does not exist, or that
   * sits or resolves inside the workspace, is dropped.
   */
  readonly externalReads?: ReadonlyArray<string> | undefined
  /**
   * Whether an undeclared write under the workspace lands in a private layer
   * that is discarded with the run, instead of failing.
   *
   * A check whose product is its exit code can run a tool that leaves files
   * beside its inputs: a compiler sidecar, a bundled config, a coverage
   * report. With the layer the tool writes them, reads them back, and none
   * reaches the host. Declared reads stay read-only binds and nothing
   * undeclared becomes readable, so the layer changes what a write does and
   * never what a read sees. Only bubblewrap has such a layer; a request for
   * one under any other mechanism is refused.
   */
  readonly scratch?: boolean | undefined
  /**
   * Host links outside the workspace the run sees as links, each at its
   * absolute path with its target string: the links a tool on `PATH` is
   * reached through. A link grants nothing; see {@link Toolchain.links}.
   */
  readonly externalLinks?: ReadonlyArray<Link> | undefined
  /**
   * Links placed in the run's private directories; see
   * {@link Toolchain.privateLinks}.
   */
  readonly privateLinks?: ReadonlyArray<Link> | undefined
}

/**
 * The host facts mechanism selection reads. Injectable so every platform's
 * argv can be tested on every other platform.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Host {
  readonly platform: NodeJS.Platform
  /** Selected Xcode developer tree on a macOS runner. */
  readonly developerDirectory?: string | undefined
  /** The real host home, used to mask credentials and locate runtime caches. */
  readonly home?: string | undefined
  /** Resolves an executable name on `PATH` to an absolute path, or nothing. */
  readonly executable: (name: string) => string | undefined
  /** Whether a host path exists. */
  readonly exists: (path: string) => boolean
  /** Distinguishes a named package root from a nested module-format scope. */
  readonly packageDirectory?: ((directory: string) => boolean) | undefined
  /** Whether a host path is a directory. */
  readonly isDirectory: (path: string) => boolean
  /** Tests the entry itself, including dangling links; defaults to the real host. */
  readonly isSymbolicLink?: ((path: string) => boolean) | undefined
  /**
   * The names of a directory's direct children, or undefined when the host
   * cannot list it. Only the hidden-entry search uses it; read grants never
   * depend on a listing.
   */
  readonly entries?: ((directory: string) => ReadonlyArray<string> | undefined) | undefined
  /**
   * Where a path's bytes actually live once every symbolic link on it is
   * followed, or `undefined` when the host cannot say. Write validation uses
   * the real host when this probe is omitted and refuses unresolved existing
   * paths. Explicit external read aliases use this probe when supplied.
   */
  readonly realpath?: ((path: string) => string | undefined) | undefined
  /**
   * The target string of a symbolic link, exactly as stored, or `undefined`
   * when the path is not a link the host can read. Defaults to the real host.
   */
  readonly readlink?: ((path: string) => string | undefined) | undefined
  /**
   * The program a package-manager shim script runs: the absolute path on the
   * `# cmd-shim-target=` line pnpm's cmd-shim writes, or `undefined` for any
   * other file. Optional: a host without it treats a shim as the program.
   */
  readonly shimTarget?: ((path: string) => string | undefined) | undefined
  readonly uid: number | undefined
  readonly gid: number | undefined
}

/**
 * One selected enforcement mechanism.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export type Mechanism =
  | { readonly _tag: "bubblewrap"; readonly executable: string }
  | { readonly _tag: "seatbelt"; readonly executable: string }
  | { readonly _tag: "docker"; readonly executable: string; readonly image: string }
  | { readonly _tag: "none" }

/**
 * The refusal a host that cannot enforce a declared confinement produces.
 * `mechanism` names what was selected, `missing` what the host lacks.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Unenforceable {
  readonly _tag: "@smthrs/platform-node/SandboxUnenforceable"
  readonly platform: NodeJS.Platform
  readonly mechanism: string
  readonly missing: string
  readonly message: string
}

/**
 * Checks for an {@link Unenforceable} refusal.
 *
 * @category guards
 * @since 1.0.0-rc.1
 */
export const isUnenforceable = (value: unknown): value is Unenforceable =>
  typeof value === "object" && value !== null &&
  (value as { readonly _tag?: unknown })._tag === "@smthrs/platform-node/SandboxUnenforceable"

/**
 * Builds an {@link Unenforceable} refusal.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const unenforceable = (
  platform: NodeJS.Platform,
  mechanism: string,
  missing: string,
  detail: string
): Unenforceable => ({
  _tag: "@smthrs/platform-node/SandboxUnenforceable",
  platform,
  mechanism,
  missing,
  message: `sandbox: the declared confinement cannot be enforced on this ${platform} host: ${detail}.`
})

/**
 * One symbolic link a confined run sees: its path and its target string,
 * exactly as `readlink` returns it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Link {
  readonly path: string
  readonly target: string
}

/**
 * The resolved confinement one spawn runs under. Every path is absolute and
 * canonical.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Plan {
  /** Host-owned broker socket restored only after all broader mounts are masked. */
  readonly destinationSocket?: string | undefined
  readonly mechanism: Exclude<Mechanism, { readonly _tag: "none" }>
  readonly network: Network
  /** Whether host Unix sockets are permitted; defaults to true for build tools. */
  readonly unixSockets?: boolean | undefined
  /** Closed-by-default process and IPC policy for untrusted native commands. */
  readonly strict?: boolean | undefined
  readonly workspaceRoot: string
  readonly cwd: string
  readonly reads: ReadonlyArray<string>
  /**
   * Symbolic links placed as links. Each path is absolute and inside the
   * workspace, and each target is relative and resolves, lexically, inside it.
   * A link is never a read: what it points at is readable only when a read
   * grants it. Bubblewrap creates each link that no read or write already
   * covers; seatbelt grants the link itself, which the host already holds.
   */
  readonly links?: ReadonlyArray<Link> | undefined
  /**
   * Paths re-closed after the read grants. {@link plan} never produces any:
   * every declared file stays its own read, so nothing needs re-closing.
   * Seatbelt renders paths a caller supplies as deny rules after the grants;
   * the other mechanisms have no deny rules and ignore them.
   */
  readonly readDenies: ReadonlyArray<string>
  readonly writes: ReadonlyArray<string>
  readonly readOnly: ReadonlyArray<string>
  /**
   * Where a declared read's bytes actually live when the path reaches them
   * through a symbolic link that leaves the workspace.
   *
   * Bubblewrap needs them because it replaces `/tmp` with a private tmpfs, so
   * a link into the host's `/tmp` (the scratch tree's `node_modules`, which
   * points back at the real workspace) resolves to nothing inside the sandbox.
   * Binding the real location read-only makes the link resolve to the same
   * bytes the host sees, which is what declaring the read asked for. Docker
   * mounts them for the same reason: the image supplies everything outside
   * the workspace, and these paths are on the host. Seatbelt leaves the host
   * filesystem in place but must grant the resolved spelling too. The
   * request's own `externalReads` land here too.
   */
  readonly externalReads: ReadonlyArray<string>
  /** Workspace entries closed by name under every grant; see {@link Hidden}. */
  readonly hidden?: Hidden | undefined
  /** Undeclared workspace writes land in a private, discarded layer; see {@link Request.scratch}. */
  readonly scratch?: boolean | undefined
  /** The run's declared files gathered in one directory mounted at the workspace root; see {@link Stage}. */
  readonly stage?: Stage | undefined
  /**
   * Host links outside the workspace, placed as links. Bubblewrap creates each
   * one no bound path already holds; seatbelt grants the link itself. Docker
   * takes its tools from the image and ignores them.
   */
  readonly externalLinks?: ReadonlyArray<Link> | undefined
  /**
   * Links in the run's private directories. Each path is relative to the
   * private temporary directory (`home/.volta`, `data/mise`). Bubblewrap
   * creates them under its own `/tmp`; under seatbelt the caller creates them
   * below {@link Plan.tmp} before the run starts.
   */
  readonly privateLinks?: ReadonlyArray<Link> | undefined
  /** A host directory the run may scribble in; created by the caller, removed after. */
  readonly tmp: string
  readonly uid: number | undefined
  readonly gid: number | undefined
}

/**
 * A confined run's declared files gathered in one private directory, mounted
 * at the workspace root in place of the empty one, for a run with more paths
 * than bubblewrap accepts as binds. The run sees exactly the staged paths at
 * their own places; the directory holds nothing else, so it grants nothing a
 * bind of each would not.
 *
 * @category models
 * @since 1.0.0
 */
export interface Stage {
  /** The host directory mounted at the workspace root, holding each staged path at its own relative path. */
  readonly directory: string
  /**
   * Whether the mount is writable. A run with a scratch layer needs it: its
   * stray writes land in the directory and go with it. Its files are then
   * copies the run may not write. Otherwise the mount is read-only.
   */
  readonly writable: boolean
  /** The declared files the directory holds; bubblewrap binds none of them on its own. */
  readonly files: ReadonlyArray<string>
  /** The links the directory holds; bubblewrap creates none of them. */
  readonly links: ReadonlyArray<string>
}

/**
 * The most arguments bubblewrap accepts. It counts the arguments it reads
 * through `--args <fd>` against the same total, so a run that would bind more
 * paths is given a {@link Stage} instead. Measured on bubblewrap 0.9.0: 8,900
 * arguments start, and 9,100 are refused on the command line and through
 * `--args` alike, with "Exceeded maximum number of arguments 9000".
 *
 * @category constants
 * @since 1.0.0
 */
export const bubblewrapArgumentLimit = 9_000

/**
 * Workspace entries a run may neither read nor write, whatever tree a grant
 * opened around them: dotenv files, for one.
 *
 * An entry is hidden by its name, wherever it sits below the workspace root
 * and in every ASCII case spelling. Seatbelt enforces `prefixes` as a path
 * pattern, so a rename of a parent directory or a hard link does not reopen
 * an entry, in the workspace or in the run's temporary directory. Bubblewrap
 * has no pattern rule: it masks each of `paths`, the
 * entries {@link hiddenEntries} found before the spawn, with an empty
 * read-only mount, which stays on the entry when a parent is renamed.
 * `restored` names the entries the operator opened again, for reading only.
 *
 * @category models
 * @since 1.0.0
 */
export interface Hidden {
  /** Name prefixes, each made of letters, digits, `.`, `_`, and `-`. */
  readonly prefixes: ReadonlyArray<string>
  /** The existing entries those prefixes name: absolute, canonical, none below another. */
  readonly paths: ReadonlyArray<string>
  /** Absolute canonical workspace paths reopened for reading, a hidden entry or a tree holding some. */
  readonly restored: ReadonlyArray<string>
}

const pathSeparator = (platform: NodeJS.Platform): string => platform === "win32" ? ";" : ":"

/** Ambient host environment for runtime lookup and cache locations. */
const ambientEnvironment = (): Readonly<Record<string, string | undefined>> => process.env

let ambientHost: Host | undefined

/**
 * The real host: platform, `PATH` lookup, and filesystem probes.
 * Ambient host facts are discovered once on first use. An explicit environment
 * creates a fresh snapshot with its own tool lookup and developer directory.
 *
 * @category resolution
 * @since 0.1.0
 */
export const host = (env?: Readonly<Record<string, string | undefined>>): Host => {
  if (env === undefined) return ambientHost ??= host(ambientEnvironment())
  const platform = process.platform
  let developerDirectory = env["DEVELOPER_DIR"]
  if (platform === "darwin" && developerDirectory === undefined) {
    try {
      developerDirectory = execFileSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8", timeout: 2_000 }).trim()
    } catch {
      // A host without Xcode needs no developer-tree grant.
    }
  }
  // A relative entry names a directory below whatever the current directory
  // is, often the workspace a confined run may write; it is never searched.
  const entries = (env["PATH"] ?? "").split(pathSeparator(platform)).filter((entry) => NodePath.isAbsolute(entry))
  const extensions = platform === "win32" ? (env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";") : [""]
  return {
    platform,
    developerDirectory,
    home: NodeOs.homedir(),
    executable: (name) => {
      if (NodePath.isAbsolute(name)) return isExecutable(name) ? name : undefined
      for (const entry of entries) {
        for (const extension of extensions) {
          const candidate = NodePath.join(entry, name + extension)
          if (isExecutable(candidate)) return candidate
        }
      }
      return undefined
    },
    exists: (path) => NodeFs.existsSync(path),
    packageDirectory: (directory) => {
      try {
        const manifest = JSON.parse(NodeFs.readFileSync(NodePath.join(directory, "package.json"), "utf8")) as
          | { readonly name?: unknown }
          | null
        return typeof manifest?.name === "string" && manifest.name.length > 0
      } catch {
        return false
      }
    },
    isSymbolicLink,
    isDirectory: (path) => {
      try {
        return NodeFs.statSync(path).isDirectory()
      } catch {
        return false
      }
    },
    entries: (directory) => {
      try {
        return NodeFs.readdirSync(directory)
      } catch {
        return undefined
      }
    },
    realpath: (path) => {
      try {
        return NodeFs.realpathSync(path)
      } catch {
        return undefined
      }
    },
    readlink,
    shimTarget,
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    gid: typeof process.getgid === "function" ? process.getgid() : undefined
  }
}

const readlink = (path: string): string | undefined => {
  try {
    return NodeFs.readlinkSync(path)
  } catch {
    return undefined
  }
}

/** A cmd-shim is a page of shell; a larger file is some other program. */
const shimLimit = 64 * 1024

const shimTarget = (path: string): string | undefined => {
  try {
    if (NodeFs.statSync(path).size > shimLimit) return undefined
    const text = NodeFs.readFileSync(path, "utf8")
    if (!text.startsWith("#!")) return undefined
    const target = /^# cmd-shim-target=(.+)$/m.exec(text)?.[1]
    return target !== undefined && NodePath.isAbsolute(target) ? target : undefined
  } catch {
    return undefined
  }
}

const isExecutable = (path: string): boolean => {
  try {
    NodeFs.accessSync(path, NodeFs.constants.X_OK)
    return NodeFs.statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Selects the mechanism a request runs under on a host.
 *
 * A docker selection is honored when `docker` is on `PATH` and refused
 * otherwise; a bubblewrap selection is refused off Linux. With no selection
 * the platform decides: bubblewrap on Linux, seatbelt on macOS, and a refusal
 * elsewhere, because Windows has no user-level process sandbox and Docker
 * needs an image only the caller can name.
 *
 * @category resolution
 * @since 1.0.0-rc.1
 */
export const select = (
  request: Pick<Request, "network" | "mechanism">,
  hostFacts: Host
): Exclude<Mechanism, { readonly _tag: "none" }> | Unenforceable => {
  const declared = request.mechanism
  const platform = hostFacts.platform
  if (declared !== undefined && declared._tag === "docker") {
    if (request.network === "loopback") {
      return unenforceable(platform, "docker", "network: true", "docker cannot expose only the host loopback interface")
    }
    const executable = hostFacts.executable("docker")
    if (executable === undefined) {
      return unenforceable(platform, "docker", "docker", "a docker mechanism is selected but docker is not on PATH")
    }
    return { _tag: "docker", executable, image: declared.image }
  }
  if (declared !== undefined && platform !== "linux") {
    return unenforceable(
      platform,
      "bubblewrap",
      "linux",
      "bubblewrap is selected but runs only on Linux; on macOS the seatbelt mechanism is selected when no mechanism is named"
    )
  }
  if (platform === "linux") {
    const executable = hostFacts.executable("bwrap")
    if (executable === undefined) {
      return unenforceable(platform, "bubblewrap", "bwrap", "bwrap is not on PATH (install the bubblewrap package)")
    }
    if (request.network === "loopback") {
      return unenforceable(
        platform,
        "bubblewrap",
        "network: true",
        "bubblewrap cannot expose only the host loopback interface: sharing that interface also grants full host networking; " +
          "open the whole network to opt into that access"
      )
    }
    return { _tag: "bubblewrap", executable }
  }
  if (platform === "darwin") {
    const executable = hostFacts.executable("/usr/bin/sandbox-exec")
    if (executable === undefined) {
      return unenforceable(platform, "seatbelt", "/usr/bin/sandbox-exec", "/usr/bin/sandbox-exec is missing")
    }
    return { _tag: "seatbelt", executable }
  }
  return unenforceable(
    platform,
    "docker",
    "docker image",
    `${platform} has no process sandbox of its own; select a docker mechanism with an image`
  )
}

// A plan can describe a foreign host. Absolute paths carry their dialect;
// resolving a POSIX root with win32 would silently add the current drive.
const pathApi = (path: string): typeof NodePath.posix =>
  /^(?:[a-z]:[\\/]|\\\\)/i.test(path) ? NodePath.win32 : NodePath.posix

const toPosix = (path: string): string => path.split(pathApi(path).sep).join("/")

/**
 * The path with the symlinks of its existing ancestors resolved. A path that
 * does not exist yet keeps its unresolved tail below the deepest ancestor
 * that does; a path with no existing ancestor is returned as given.
 */
const realized = (path: string): string => {
  let head = path
  const tail: Array<string> = []
  while (head !== pathApi(head).dirname(head)) {
    try {
      const real = NodeFs.realpathSync(head)
      return tail.length === 0 ? real : pathApi(real).join(real, ...tail)
    } catch {
      tail.unshift(pathApi(head).basename(head))
      head = pathApi(head).dirname(head)
    }
  }
  return path
}

const insideRoot = (root: string, candidate: string): boolean => {
  const relative = pathApi(root).relative(root, candidate)
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${pathApi(root).sep}`) && !pathApi(relative).isAbsolute(relative))
}

/** Unlike exists/stat, lstat sees dangling links and does not follow them. */
const isSymbolicLink = (path: string): boolean => {
  try {
    return NodeFs.lstatSync(path).isSymbolicLink()
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false
    throw cause
  }
}

/** Check each component, including existing ancestors of a missing output. */
const safeWrite = (root: string, path: string, hostFacts: Host): boolean => {
  if (!insideRoot(root, path)) return false
  try {
    const realpath = hostFacts.realpath ?? NodeFs.realpathSync
    const link = hostFacts.isSymbolicLink ?? isSymbolicLink
    if (realpath(root) !== root) return false
    let current = root
    for (const component of pathApi(root).relative(root, path).split(pathApi(root).sep).filter(Boolean)) {
      current = pathApi(current).join(current, component)
      if (link(current)) return false
      if (hostFacts.exists(current) && realpath(current) !== current) return false
    }
    return true
  } catch {
    return false
  }
}

const unsafeWrite = (platform: NodeJS.Platform, mechanism: string, path: string): Unenforceable =>
  unenforceable(
    platform,
    mechanism,
    "canonical workspace write path",
    `write path ${path} has a symbolic link, an unresolved ancestor, or leaves the canonical workspace`
  )

/**
 * Rechecks write grants before directory creation and before rendering. Throws
 * an {@link Unenforceable} refusal if a path changed since planning. Callers
 * must keep the workspace stable until the operating system consumes mounts.
 *
 * @category resolution
 * @since 0.1.0
 */
export const validateWrites = (confinement: Plan, hostFacts: Host = host()): void => {
  for (const write of confinement.writes) {
    if (!safeWrite(confinement.workspaceRoot, write, hostFacts)) {
      throw unsafeWrite(hostFacts.platform, confinement.mechanism._tag, write)
    }
  }
}

/**
 * Orders paths so that every subtree is contiguous and its root comes first.
 *
 * Comparing on the path plus its separator is what makes that hold: `a/b` and
 * `a/b/c` sort around `a/b.ts`, because `.` precedes `/`, and a plain
 * comparison would then put a sibling between an ancestor and its child.
 */
const bySubtree = (left: string, right: string): number => {
  const leftKey = left + pathApi(left).sep
  const rightKey = right + pathApi(right).sep
  return leftKey < rightKey ? -1 : 1
}

/**
 * Drops a path covered by another entry of the same set, keeping the set ordered.
 *
 * One sweep in subtree order carries the shallowest kept ancestor forward,
 * because searching the kept set per path is quadratic in the sibling files a
 * bubblewrap or Docker plan declares one by one.
 */
const collapse = (paths: ReadonlyArray<string>): ReadonlyArray<string> => {
  const unique = [...new Set(paths)]
  const kept = new Set<string>()
  let ancestor: string | undefined
  for (const path of [...unique].sort(bySubtree)) {
    if (ancestor !== undefined && path.startsWith(ancestor + pathApi(ancestor).sep)) continue
    kept.add(path)
    ancestor = path
  }
  return unique.filter((path) => kept.has(path)).sort((left, right) =>
    left.length - right.length || (left < right ? -1 : 1)
  )
}

/**
 * Resolves a request against a workspace into a {@link Plan}, or refuses.
 *
 * Every relative path is anchored at the canonical workspace root; one that
 * escapes the workspace is dropped, because the sandbox never grants anything
 * outside the tree the key covers. Reads that do not exist are dropped too:
 * bubblewrap cannot bind a missing path, and a declared input that vanished is
 * the executor's measurement failure, not this module's. A write containing
 * any symbolic link below the canonical root is refused, including a missing
 * output below a linked ancestor. A read resolving outside the root requires
 * an explicit external read covering its target.
 *
 * @category resolution
 * @since 0.1.0
 */
export const plan = (
  request: Request,
  location: { readonly workspaceRoot: string; readonly cwd: string; readonly tmp: string },
  hostFacts: Host
): Plan | Unenforceable => {
  const selected = select(request, hostFacts)
  if (isUnenforceable(selected)) return selected
  if (request.scratch === true && selected._tag !== "bubblewrap") {
    return unenforceable(
      hostFacts.platform,
      selected._tag,
      "bubblewrap",
      `a discarded scratch layer needs bubblewrap; under ${selected._tag} an undeclared write would reach the host`
    )
  }
  let root: string
  try {
    const canonical = (hostFacts.realpath ?? NodeFs.realpathSync)(location.workspaceRoot)
    if (canonical === undefined) return unsafeWrite(hostFacts.platform, selected._tag, location.workspaceRoot)
    root = canonical
  } catch {
    return unsafeWrite(hostFacts.platform, selected._tag, location.workspaceRoot)
  }
  // The mechanism's program runs on the host outside any confinement. A
  // `PATH` entry inside the workspace, such as the `node_modules/.bin` that
  // `pnpm run` puts first, would let a confined write choose that program.
  // The real host never returns a relative program: it skips relative entries.
  const launcher = selected.executable
  if (
    [launcher, hostFacts.realpath?.(launcher) ?? launcher].some((path) =>
      pathApi(root).isAbsolute(path) && insideRoot(root, path)
    )
  ) {
    return unenforceable(
      hostFacts.platform,
      selected._tag,
      "launcher outside the workspace",
      `the ${selected._tag} program ${launcher} is inside the workspace; ` +
        "remove the workspace directory from the host PATH ahead of it"
    )
  }
  const anchor = (relative: string): string | undefined => {
    const absolute = pathApi(root).resolve(root, ...relative.split("/"))
    return insideRoot(root, absolute) ? absolute : undefined
  }
  const declared: Array<string> = []
  // Only explicit externalReads may grant authority outside the workspace.
  const externalReads: Array<string> = []
  const linkedReads: Array<string> = []
  for (const relative of request.reads) {
    const absolute = anchor(relative)
    if (absolute === undefined || !hostFacts.exists(absolute)) continue
    declared.push(absolute)
    const real = (hostFacts.realpath ?? realized)(absolute)
    if (real !== undefined && !insideRoot(root, real)) linkedReads.push(real)
  }
  for (const path of request.externalReads ?? []) {
    if (!pathApi(path).isAbsolute(path) || insideRoot(root, path) || !hostFacts.exists(path)) continue
    // An alias or link outside the tree can resolve into it; granting that
    // real location would open the workspace past its declared reads.
    const real = hostFacts.realpath?.(path) ?? path
    if (!insideRoot(root, real)) externalReads.push(real)
  }
  // A link is placed, never followed, so its target is checked as a string:
  // an absolute target, or one that climbs out of the workspace, would make
  // the run's view depend on the host rather than on the declaration.
  const links: Array<Link> = []
  for (const link of request.links ?? []) {
    const absolute = anchor(link.path)
    const api = pathApi(root)
    const resolved = absolute === undefined || api.isAbsolute(link.target) || /^[A-Za-z]:|^\\/.test(link.target)
      ? undefined
      : api.resolve(api.dirname(absolute), ...link.target.split("/"))
    if (absolute === undefined || resolved === undefined || !insideRoot(root, resolved)) {
      return unenforceable(
        hostFacts.platform,
        selected._tag,
        "workspace link target",
        `the link input ${link.path} -> ${link.target} must name a relative target inside the workspace`
      )
    }
    links.push({ path: absolute, target: link.target })
  }
  if (links.length > 0 && selected._tag === "docker") {
    return unenforceable(
      hostFacts.platform,
      "docker",
      "bubblewrap or seatbelt",
      `docker binds paths and cannot place the link input ${links[0]!.path} as a link; ` +
        "a bind of the link would grant what it points at"
    )
  }
  for (const target of linkedReads) {
    if (!externalReads.some((read) => insideRoot(read, target))) {
      return unenforceable(
        hostFacts.platform,
        selected._tag,
        "explicit external read",
        "a workspace read resolves outside its declared root"
      )
    }
  }
  // A write names a directory the tool may fill, and is bound as declared
  // whether or not it exists yet: a name is never read as a file, because a
  // dot in `.cargo-home` or `dist.new` would otherwise widen the bind to the
  // parent, and a parent that is the workspace root opens every file in it.
  // Existing files are refused rather than widening the declaration.
  const writes: Array<string> = []
  const add = (absolute: string): Unenforceable | undefined => {
    if (!safeWrite(root, absolute, hostFacts)) return unsafeWrite(hostFacts.platform, selected._tag, absolute)
    writes.push(absolute)
    return undefined
  }
  for (const relative of request.writes) {
    const absolute = anchor(relative)
    if (absolute === undefined) continue
    if (!safeWrite(root, absolute, hostFacts)) return unsafeWrite(hostFacts.platform, selected._tag, absolute)
    if (hostFacts.exists(absolute) && !hostFacts.isDirectory(absolute)) {
      return unenforceable(
        hostFacts.platform,
        selected._tag,
        "directory write",
        "the declared write is not a directory tree"
      )
    }
    const refusal = add(absolute)
    if (refusal !== undefined) return refusal
  }
  // A declared output file opens its parent: a file cannot be bound before it
  // exists, and a tool that writes by rename needs the directory anyway.
  for (const relative of request.writeFiles ?? []) {
    const absolute = anchor(relative)
    if (absolute === undefined) continue
    if (!safeWrite(root, absolute, hostFacts)) return unsafeWrite(hostFacts.platform, selected._tag, absolute)
    const refusal = add(
      hostFacts.exists(absolute) && hostFacts.isDirectory(absolute) ? absolute : pathApi(absolute).dirname(absolute)
    )
    if (refusal !== undefined) return refusal
  }
  const readOnly: Array<string> = []
  for (const relative of request.readOnly ?? []) {
    const absolute = anchor(relative)
    if (absolute !== undefined) readOnly.push(absolute)
  }
  // A host link is placed outside the workspace only: inside it, the
  // declaration alone decides what exists.
  const externalLinks = (request.externalLinks ?? []).filter((link) =>
    pathApi(link.path).isAbsolute(link.path) && !insideRoot(root, link.path)
  )
  // A private link stays below the private directory it is named in.
  const privateLinks = (request.privateLinks ?? []).filter((link) =>
    !pathApi(link.path).isAbsolute(link.path) && !link.path.split("/").includes("..")
  )
  return {
    mechanism: selected,
    network: request.network,
    unixSockets: request.unixSockets,
    strict: request.strict,
    workspaceRoot: root,
    cwd: location.cwd,
    reads: collapse(declared),
    ...(links.length === 0 ? {} : { links }),
    readDenies: [],
    writes: collapse(writes),
    readOnly: collapse(readOnly),
    externalReads: collapse(externalReads),
    ...(request.scratch === true ? { scratch: true } : {}),
    ...(externalLinks.length === 0 ? {} : { externalLinks }),
    ...(privateLinks.length === 0 ? {} : { privateLinks }),
    tmp: location.tmp,
    uid: hostFacts.uid,
    gid: hostFacts.gid
  }
}

/**
 * Where corepack keeps the package-manager binaries it manages, resolved the
 * way corepack itself resolves it from a host environment.
 *
 * A `pnpm`, `yarn`, or `npm` on `PATH` is often corepack's shim, and the
 * program it execs lives in this directory, not on `PATH`. Redirecting `HOME`
 * and `XDG_CACHE_HOME` to the private tmp moves that directory out from under
 * the shim, which then tries to re-download the package manager from the
 * registry — and a confined run has no network, so every rule that drives the
 * package manager fails with a connect error that names the registry rather
 * than the missing cache.
 */
const corepackHome = (env: Readonly<Record<string, string | undefined>>, home: string): string => {
  const declared = env["COREPACK_HOME"]
  if (declared !== undefined && declared !== "") return declared
  const base = env["XDG_CACHE_HOME"] ?? env["LOCALAPPDATA"] ??
    pathApi(home).join(home, process.platform === "win32" ? "AppData/Local" : ".cache")
  return pathApi(base).join(base, "node", "corepack")
}

/**
 * Environment the confined process receives on top of the tool environment:
 * a private temporary directory and home, so nothing a tool caches lands in
 * the real home or the shared temp directory.
 *
 * `COREPACK_HOME` is the one host cache kept: it holds the package-manager
 * program a corepack shim execs, the run may only read it (the mechanisms
 * deny writes outside the workspace), and without it a confined `pnpm` is a
 * shim with nothing to run. A non-default cache location requires an explicit
 * `externalReads` grant; preserving the variable does not grant access.
 *
 * @category rendering
 * @since 0.1.0
 */
export const environment = (
  confinement: Plan,
  hostEnv: Readonly<Record<string, string | undefined>> = ambientEnvironment(),
  hostHome: string = NodeOs.homedir()
): Readonly<Record<string, string>> => {
  const tmp = confinement.mechanism._tag === "seatbelt" ? confinement.tmp : "/tmp"
  const home = NodePath.posix.join(toPosix(tmp), "home")
  return {
    COREPACK_HOME: corepackHome(hostEnv, hostHome),
    HOME: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    XDG_CACHE_HOME: NodePath.posix.join(toPosix(tmp), "cache"),
    XDG_CONFIG_HOME: NodePath.posix.join(toPosix(tmp), "config"),
    XDG_DATA_HOME: NodePath.posix.join(toPosix(tmp), "data"),
    XDG_STATE_HOME: NodePath.posix.join(toPosix(tmp), "state")
  }
}

/** The system part of the runtime surface: the same on every `PATH`. */
const systemPaths = (hostFacts: Host): Array<string> => {
  const paths = [
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/nix/store",
    "/opt/homebrew",
    // A Smithers machine's toolchain layer: the repository's Node, pnpm, Go,
    // Rust and Python, which the machine's environment puts first on PATH.
    // Never all of /opt/smithers, which holds the machine's environment and
    // helpers.
    "/opt/smithers/toolchain",
    "/opt/smithers/rust",
    "/System/Library",
    "/System/Volumes/Preboot/Cryptexes/OS",
    "/private/var/db/dyld",
    // macOS shell and developer-tool dispatch read these system selectors.
    "/var/select/sh",
    "/private/var/select/sh",
    "/var/select/developer_dir",
    "/private/var/select/developer_dir",
    "/Library/Apple",
    "/Library/Developer",
    "/Applications/Xcode.app/Contents/Developer",
    "/Applications/Xcode.app/Contents/Info.plist",
    "/Applications/Xcode.app/Contents/Frameworks",
    "/Applications/Xcode.app/Contents/SharedFrameworks",
    "/Applications/Xcode.app/Contents/PlugIns",
    "/etc/ld.so.cache",
    "/etc/ld.so.conf",
    "/etc/ld.so.conf.d",
    "/etc/localtime",
    "/etc/ssl",
    "/etc/hosts",
    "/etc/resolv.conf",
    "/etc/nsswitch.conf"
  ]
  const developerDirectory = hostFacts.developerDirectory
  if (
    hostFacts.platform === "darwin" && developerDirectory !== undefined &&
    /^\/Applications\/Xcode[^/]*\.app\/Contents\/Developer$/.test(developerDirectory)
  ) {
    paths.push(developerDirectory)
  }
  if (hostFacts.home !== undefined) paths.push(pathApi(hostFacts.home).join(hostFacts.home, ".cache/node/corepack"))
  return paths
}

/** The paths that exist, under the spelling given and the real one. */
const present = (paths: ReadonlyArray<string>, hostFacts: Host): ReadonlyArray<string> =>
  collapse(
    paths.filter((path) => hostFacts.exists(path)).flatMap((path) => [path, hostFacts.realpath?.(path) ?? path])
  )

/** The fixed runtime surface, never the host root, home, PATH, or arbitrary env paths. */
const runtimeReads = (hostFacts: Host): ReadonlyArray<string> => {
  const paths = systemPaths(hostFacts)
  for (const name of ["node", "bun"]) {
    const executable = hostFacts.executable(name)
    if (executable !== undefined) {
      paths.push(executable)
      const real = hostFacts.realpath?.(executable) ?? executable
      paths.push(real)
      // Node distributions keep npm/corepack here; never grant the install
      // prefix itself, which can be the real home for a custom installation.
      paths.push(pathApi(real).resolve(pathApi(real).dirname(real), "../lib/node_modules"))
    }
  }
  return present(paths, hostFacts)
}

/** Credentials remain closed even when a workspace or runtime grant contains the home. */
const credentialPaths = (hostFacts: Host): ReadonlyArray<string> => {
  const home = hostFacts.home
  if (home === undefined) return []
  return collapse([
    ".aws",
    ".ssh",
    ".gnupg",
    ".azure",
    ".kube",
    ".docker",
    ".config/gcloud",
    ".config/gh",
    ".npmrc",
    ".netrc",
    ".git-credentials",
    ".cargo/credentials",
    ".cargo/credentials.toml"
  ].flatMap((relative) => {
    const path = pathApi(home).join(home, relative)
    return [path, hostFacts.realpath?.(path) ?? path]
  }))
}

/**
 * The program a confined run execs, made reachable inside its empty root.
 *
 * Bubblewrap resolves a bare program name with `execvp` against `PATH` inside
 * the new root, and that root holds only the runtime paths and the declared
 * sets. A package manager installed outside them — pnpm under the
 * `pnpm/action-setup` prefix on a CI runner, a `.bin` link into a
 * `node_modules` tree — is on the host `PATH` and absent from the sandbox, so
 * the run died with `bwrap: execvp pnpm` before the tool started (#3140).
 *
 * A bare name is resolved on the tool's `PATH` (the host's when none is
 * given). A program already inside a runtime path or a granted path is left
 * exactly as spelled, so a multi-call binary keeps the name it dispatches on:
 * `/bin/sh` linked to `/bin/busybox` stays a shell and `unxz` linked to `xz`
 * still decompresses. So is a program inside the workspace, whose reads only
 * the declaration may open. Otherwise the run
 * execs the program's real file, and the nearest package directory holding it
 * (a named `package.json`, at most three levels up, never the home or the root)
 * is bound read-only, because a script like `pnpm.cjs` loads its siblings.
 * Module-format-only manifests inside `bin/` do not stop that search.
 * With no package directory only the real file is bound. A name that resolves
 * nowhere is left for `execvp` to report.
 *
 * A package-manager shim script is followed like a link. `pnpm self-update`
 * under `pnpm/action-setup` installs pnpm as a cmd-shim in `$PNPM_HOME/bin`
 * that runs node on a package in pnpm's global store, a path relative to the
 * script; binding the script alone left that package missing. When the
 * program the shim names is executable, the run execs its real file and binds
 * its package as above.
 *
 * @since 1.0.0
 * @private
 */
export const launcher = (
  program: string,
  searchPath: string | undefined,
  granted: ReadonlyArray<string>,
  workspaceRoot: string,
  hostFacts: Host
): { readonly program: string; readonly reads: ReadonlyArray<string> } => {
  const unchanged = { program, reads: [] }
  if (program.includes("/") && !pathApi(program).isAbsolute(program)) return unchanged
  const found = pathApi(program).isAbsolute(program)
    ? hostFacts.executable(program)
    : searchPath === undefined
    ? hostFacts.executable(program)
    : searchPath.split(":").filter((entry) => pathApi(entry).isAbsolute(entry))
      .map((entry) => hostFacts.executable(pathApi(entry).join(entry, program)))
      .find((candidate) => candidate !== undefined)
  if (found === undefined) return unchanged
  const resolved = hostFacts.realpath?.(found) ?? found
  const named = hostFacts.shimTarget?.(resolved)
  const real = named === undefined || hostFacts.executable(named) === undefined
    ? resolved
    : hostFacts.realpath?.(named) ?? named
  if ([found, resolved, real].some((path) => insideRoot(workspaceRoot, path))) return unchanged
  const runtime = runtimeReads(hostFacts)
  const covered = (path: string) => [...runtime, ...granted].some((parent) => insideRoot(parent, path))
  const withinGrant = covered(found) ? unchanged : { program: real, reads: [] }
  const directory = packageRoot(real, hostFacts)
  if (directory !== undefined) return covered(directory) ? withinGrant : { program: real, reads: [directory] }
  return covered(real) ? withinGrant : { program: real, reads: [real] }
}

/**
 * The nearest package directory holding a file: a named `package.json`, at
 * most three levels up, never the home or the root.
 */
const packageRoot = (file: string, hostFacts: Host): string | undefined => {
  let directory = pathApi(file).dirname(file)
  for (let level = 0; level < 3; level++) {
    if (directory === pathApi(directory).dirname(directory) || directory === hostFacts.home) return undefined
    if (
      hostFacts.packageDirectory?.(directory) ?? hostFacts.exists(pathApi(directory).join(directory, "package.json"))
    ) {
      return directory
    }
    directory = pathApi(directory).dirname(directory)
  }
  return undefined
}

/**
 * The programs a project's own verification starts by name: the JavaScript
 * runtimes and the package managers, with the launchers each one ships.
 */
const toolchainPrograms: ReadonlyArray<string> = [
  "node",
  "npm",
  "npx",
  "pnpm",
  "pnpx",
  "yarn",
  "yarnpkg",
  "bun",
  "bunx",
  "corepack"
]

/**
 * The host paths a project's own toolchain is read from, for a run that
 * starts more programs than the one {@link launcher} resolves: an install
 * whose lifecycle script calls `pnpm`, a test script that calls `npm`.
 *
 * The host chooses them from its own `PATH`, never from anything the confined
 * run wrote. Each absolute `PATH` entry is one, under the spelling `PATH`
 * uses and under its real path, so a name the run looks up resolves inside
 * the sandbox the way it resolves outside. So is the install root of each
 * package manager and runtime `PATH` resolves, found the way {@link launcher}
 * finds one program's: the package directory holding the real file, or the
 * file itself. That covers a version manager's layout under the home
 * directory (nvm, a corepack shim, a pnpm cmd-shim) without opening the home.
 *
 * A path that is the workspace, the home directory, or an ancestor of one is
 * never returned. Neither is a credential location, an ancestor of one, or a
 * path inside one, nor a path that is or resolves inside the workspace: only
 * the run's own declaration opens that tree.
 *
 * @category resolution
 * @since 1.0.0
 */
export const toolchainReads = (
  searchPath: string | undefined,
  workspaceRoot: string,
  hostFacts: Host
): ReadonlyArray<string> => {
  const closed = [
    workspaceRoot,
    ...(hostFacts.home === undefined ? [] : [hostFacts.home]),
    ...credentialPaths(hostFacts)
  ]
  const credentials = credentialPaths(hostFacts)
  const admissible = (path: string): boolean =>
    pathApi(path).isAbsolute(path) && hostFacts.exists(path) && !insideRoot(workspaceRoot, path) &&
    // A link on PATH must not bind a workspace subtree under a second name,
    // where no hidden entry is masked.
    !insideRoot(workspaceRoot, hostFacts.realpath?.(path) ?? path) &&
    !closed.some((kept) => insideRoot(path, kept)) &&
    !credentials.some((kept) => insideRoot(kept, path))
  const found: Array<string> = []
  for (const entry of (searchPath ?? "").split(":")) {
    if (entry === "" || !pathApi(entry).isAbsolute(entry) || !hostFacts.isDirectory(entry)) continue
    found.push(entry, hostFacts.realpath?.(entry) ?? entry)
  }
  for (const program of toolchainPrograms) {
    found.push(...launcher(program, searchPath, [], workspaceRoot, hostFacts).reads)
  }
  return collapse(found.filter(admissible))
}

/**
 * What a confined run is shown of the tools the host has on `PATH`.
 *
 * @category models
 * @since 1.0.0
 */
export interface Toolchain {
  /** Real host paths the run reads: each `PATH` directory and each tool's install root. */
  readonly reads: ReadonlyArray<string>
  /**
   * The links a tool is reached through that no read holds: a `PATH` entry
   * that is itself a link, or a link in a directory the run cannot read
   * (`/etc/alternatives/awk`). Each path is absolute and real up to the link.
   */
  readonly links: ReadonlyArray<Link>
  /**
   * Links that put a version manager's home where its shims look for it once
   * `HOME` is the run's private directory. Each path is relative to the
   * private temporary directory: `home/.volta`, `data/mise`.
   */
  readonly privateLinks: ReadonlyArray<Link>
  /**
   * Readable files whose bytes choose the version a shim runs: Volta's
   * default platform, rustup's settings and `~/.tool-versions`. A caller keys
   * on their bytes.
   */
  readonly selections: ReadonlyArray<string>
}

/** The directory names a tool's programs sit in, below its install prefix. */
const programDirectories: ReadonlyArray<string> = ["bin", "shims"]

/** What a version manager's home holds: asdf and mise, pyenv and rbenv, Volta. */
const managerMarkers: ReadonlyArray<string> = ["installs", "versions", "tools/image"]

/**
 * A tool that keeps its versions in a home directory no `PATH` entry leads
 * to: rustup's proxies in `~/.cargo/bin` run the toolchains in `~/.rustup`.
 */
const companionHomes: ReadonlyArray<{ readonly program: string; readonly home: string; readonly selection: string }> = [
  { program: "rustup", home: ".rustup", selection: "settings.toml" }
]

/** Home directories many programs share; never opened as one tool's prefix. */
const sharedHomeDirectories: ReadonlyArray<string> = [
  ".local",
  ".local/share",
  ".local/state",
  ".config",
  ".cache",
  "Library"
]

/** Where each private directory of {@link environment} sits under a real home. */
const privateDirectories: ReadonlyArray<readonly [home: string, name: string]> = [
  [".local/share/", "data/"],
  [".local/state/", "state/"],
  [".config/", "config/"],
  [".cache/", "cache/"]
]

/**
 * Every symbolic link the host follows to resolve a path, in order, each
 * named by its real location. Nothing when a link cannot be read or the
 * chain does not end.
 */
const followed = (path: string, hostFacts: Host): ReadonlyArray<Link> | undefined => {
  const api = pathApi(path)
  const isLink = hostFacts.isSymbolicLink ?? isSymbolicLink
  const links: Array<Link> = []
  let current = api.parse(path).root
  const pending = path.slice(current.length).split(api.sep)
  while (pending.length > 0) {
    const part = pending.shift()!
    if (part === "" || part === ".") continue
    if (part === "..") {
      current = api.dirname(current)
      continue
    }
    const next = api.join(current, part)
    if (!isLink(next)) {
      current = next
      continue
    }
    const target = (hostFacts.readlink ?? readlink)(next)
    if (target === undefined || links.length === 40) return undefined
    links.push({ path: next, target })
    const targetRoot = api.parse(target).root
    if (targetRoot !== "") current = targetRoot
    pending.unshift(...target.slice(targetRoot.length).split(api.sep))
  }
  return links
}

/**
 * The host tools a confined run finds by name, and what each one needs to
 * run: the same answer `PATH` gives outside the sandbox.
 *
 * Every absolute `PATH` entry that is a directory is read, at its real path.
 * Each program in it that is a link out of the directory brings its install
 * root: the package directory holding the real file (`lib/node_modules/npm`),
 * else the directory holding it (`~/.local/zig-0.17.1`). A package-manager
 * shim script is followed like a link. When a directory is named `bin` or
 * `shims` and its parent is an install prefix (it holds `lib`, or a version
 * manager's `installs`, `versions` or `tools/image`), the parent is read too,
 * so an interpreter finds its library and a shim finds the versions it
 * chooses from. That covers nvm, fnm, Volta, asdf, mise, pyenv, a Go SDK, a
 * plain `~/.local/<tool>/bin`, Bun and Zig, under the home directory or
 * anywhere else. rustup's proxies bring `~/.rustup`, which no link leads to.
 *
 * A shim finds its versions under `HOME`, and a confined run's `HOME` is
 * private. {@link Toolchain.privateLinks} puts each version manager's home at
 * the same place under the private one, and `~/.tool-versions` beside it when
 * asdf or mise is there, so the shim chooses what it chooses on the host.
 *
 * Nothing else of the home directory is read. A path that is the workspace,
 * the home directory, or an ancestor of one is never returned; neither is a
 * credential location, an ancestor of one, or a path inside one, nor a path
 * that is or resolves inside the workspace. The directories programs share
 * (`~/.local`, `~/.config`, `~/.cache`, `~/Library`) and a directory at the
 * top of the filesystem are never taken for a prefix. When the directory
 * holding a linked program cannot be opened, the program's file alone is.
 *
 * A system directory (`/usr/bin`) is already
 * readable, so only what its links leave it for is added.
 *
 * @category resolution
 * @since 1.0.0
 */
export const toolchain = (
  searchPath: string | undefined,
  workspaceRoot: string,
  hostFacts: Host
): Toolchain => {
  const api = pathApi(workspaceRoot)
  const home = hostFacts.home
  const credentials = credentialPaths(hostFacts)
  const closed = [workspaceRoot, ...(home === undefined ? [] : [home]), ...credentials]
  const real = (path: string): string => hostFacts.realpath?.(path) ?? path
  const admissible = (path: string): boolean =>
    hostFacts.exists(path) && !insideRoot(workspaceRoot, path) &&
    !insideRoot(workspaceRoot, real(path)) &&
    !closed.some((kept) => insideRoot(path, kept)) &&
    !credentials.some((kept) => insideRoot(kept, path))
  // Only the system directories count as already readable. What the runtime
  // surface adds for one `node` depends on which `node` leads `PATH`.
  const system = present(systemPaths(hostFacts), hostFacts)
  const covered = (path: string): boolean => system.some((parent) => insideRoot(parent, path))
  const shared = home === undefined ? [] : sharedHomeDirectories.map((relative) => api.join(home, relative))
  const holds = (directory: string, markers: ReadonlyArray<string>): boolean =>
    markers.some((marker) => hostFacts.exists(api.join(directory, marker)))
  // The install prefix above a program directory, or the directory itself.
  const rootOf = (directory: string): string => {
    const prefix = api.dirname(directory)
    return programDirectories.includes(api.basename(directory)) && api.dirname(prefix) !== api.parse(prefix).root &&
        !shared.includes(prefix) && admissible(prefix) && holds(prefix, ["lib", ...managerMarkers])
      ? prefix
      : directory
  }
  // What a program outside its `PATH` directory is installed as.
  const installed = (file: string): string => {
    const root = packageRoot(file, hostFacts) ?? rootOf(api.dirname(file))
    return admissible(root) ? root : file
  }
  const reads: Array<string> = []
  const links = new Map<string, string>()
  const names = new Set<string>()
  const note = (path: string): void => {
    for (const link of followed(path, hostFacts) ?? []) links.set(link.path, link.target)
  }
  const visited = new Set<string>()
  for (const entry of (searchPath ?? "").split(":")) {
    if (entry === "" || !api.isAbsolute(entry) || !hostFacts.isDirectory(entry)) continue
    const directory = real(entry)
    if (visited.has(directory) || !admissible(entry) || !admissible(directory)) continue
    visited.add(directory)
    const open = !covered(directory)
    if (open) reads.push(directory, rootOf(directory))
    if (directory !== entry) note(entry)
    for (const name of [...(hostFacts.entries?.(directory) ?? [])].sort()) {
      const path = api.join(directory, name)
      if (!hostFacts.exists(path) || hostFacts.isDirectory(path)) continue
      const file = real(path)
      names.add(name)
      if (file !== path) note(path)
      // A shim script is read to find its program; a system directory holds none.
      const shim = open ? hostFacts.shimTarget?.(file) : undefined
      const program = shim === undefined || hostFacts.executable(shim) === undefined ? file : real(shim)
      for (const target of new Set([file, program])) {
        if (insideRoot(directory, target) || covered(target)) continue
        const root = installed(target)
        if (admissible(root)) reads.push(root)
      }
    }
  }
  const privateLinks: Array<Link> = []
  const selections: Array<string> = []
  if (home !== undefined) {
    // A version manager's shims look for its home under `HOME`.
    let shims = false
    for (const root of collapse(reads)) {
      if (!insideRoot(home, root) || !holds(root, managerMarkers)) continue
      const relative = toPosix(api.relative(home, root))
      privateLinks.push({ path: `home/${relative}`, target: root })
      for (const [under, name] of privateDirectories) {
        if (relative.startsWith(under)) privateLinks.push({ path: name + relative.slice(under.length), target: root })
      }
      const platform = api.join(root, "tools/user/platform.json")
      if (hostFacts.exists(platform)) selections.push(platform)
      shims ||= hostFacts.exists(api.join(root, "installs"))
    }
    for (const companion of companionHomes) {
      const directory = real(api.join(home, companion.home))
      if (!names.has(companion.program) || !admissible(directory)) continue
      reads.push(directory)
      privateLinks.push({ path: `home/${companion.home}`, target: directory })
      const selection = api.join(directory, companion.selection)
      if (hostFacts.exists(selection)) selections.push(selection)
    }
    // The versions asdf and mise fall back to when the repository names none.
    const versions = real(api.join(home, ".tool-versions"))
    if (shims && admissible(versions)) {
      reads.push(versions)
      privateLinks.push({ path: "home/.tool-versions", target: versions })
      selections.push(versions)
    }
  }
  const opened = collapse(reads)
  return {
    reads: opened,
    // A link inside a read is there as the host's own.
    links: [...links]
      .filter(([path]) =>
        !insideRoot(workspaceRoot, path) && !covered(path) && !opened.some((read) => insideRoot(read, path)) &&
        !credentials.some((kept) => insideRoot(kept, path))
      )
      .map(([path, target]) => ({ path, target })),
    privateLinks,
    selections
  }
}

const hiddenPrefix = /^[A-Za-z0-9._-]+$/

/**
 * The existing workspace entries a set of name prefixes hides.
 *
 * Walks the real tree below the root and returns every entry whose name
 * starts with a prefix, in any ASCII case, without descending into it. A
 * symbolic link is neither followed nor returned: its target is hidden under
 * the target's own name or lies outside what the run may read. Every real
 * directory is searched, a dependency tree included: an earlier run can move
 * a directory anywhere it may write, and the entries below it move with it.
 * An entry at or below a `restored` path is left out, and so is a prefix
 * outside the letters, digits, `.`, `_`, and `-` a pattern rule can carry.
 *
 * Throws when a directory cannot be listed: an entry the search cannot see
 * would stay open, so the caller refuses the run.
 *
 * @category resolution
 * @since 1.0.0
 */
export const hiddenEntries = (
  workspaceRoot: string,
  prefixes: ReadonlyArray<string>,
  restored: ReadonlyArray<string>,
  hostFacts: Host
): ReadonlyArray<string> => {
  const wanted = prefixes.filter((prefix) => hiddenPrefix.test(prefix)).map((prefix) => prefix.toLowerCase())
  if (wanted.length === 0) return []
  const link = hostFacts.isSymbolicLink ?? isSymbolicLink
  const found: Array<string> = []
  const pending = [workspaceRoot]
  while (pending.length > 0) {
    const directory = pending.pop()!
    const names = hostFacts.entries?.(directory)
    if (names === undefined) {
      throw new Error("a workspace directory cannot be listed, so the entries hidden below it cannot be closed")
    }
    for (const name of names) {
      const path = pathApi(directory).join(directory, name)
      if (link(path) || restored.some((open) => insideRoot(open, path))) continue
      if (wanted.some((prefix) => name.toLowerCase().startsWith(prefix))) found.push(path)
      else if (hostFacts.isDirectory(path)) pending.push(path)
    }
  }
  return found.sort()
}

/** A bind at a different lexical path must not reveal a protected broker tree. */
const refuseBrokerAliases = (paths: ReadonlyArray<string>, hostFacts: Host, mechanism: string): void => {
  for (const path of paths) {
    const real = hostFacts.realpath?.(path) ?? path
    if (real !== path && (insideRoot(real, destinationBrokerRoot) || insideRoot(destinationBrokerRoot, real))) {
      throw unenforceable(
        hostFacts.platform,
        mechanism,
        "broker alias isolation",
        "a sandbox grant aliases the private destination broker tree"
      )
    }
  }
}

/**
 * The bubblewrap argv for a plan.
 *
 * Order matters: bubblewrap applies operations in argument order, so the
 * empty root goes first, runtime paths are bound, the workspace tmpfs shadows
 * any broad runtime grant, declared paths are bound on top, and re-closed
 * subtrees are bound read-only over their writable parents. The tmpfs is
 * remounted read-only last so an undeclared write
 * under the workspace fails with `EROFS` instead of vanishing into the tmpfs.
 *
 * @category rendering
 * @since 0.1.0
 */
export const bubblewrap = (
  confinement: Plan,
  argv: ReadonlyArray<string>,
  hostFacts: Host = host(),
  searchPath?: string | undefined
): ReadonlyArray<string> => {
  if (confinement.mechanism._tag !== "bubblewrap") throw new Error("bubblewrap argv needs a bubblewrap plan")
  validateWrites(confinement, hostFacts)
  const home = "/tmp/home"
  const out: Array<string> = [
    confinement.mechanism.executable,
    "--tmpfs",
    "/"
  ]
  const runtime = runtimeReads(hostFacts)
  for (const read of runtime) out.push("--ro-bind", read, read)
  out.push(
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--dir",
    home,
    "--dir",
    "/tmp/cache"
  )
  // A staged run's declared files are one mount: a bind each would pass the
  // argument limit. Every other grant is still bound on top of it.
  const stage = confinement.stage
  if (stage === undefined) out.push("--tmpfs", confinement.workspaceRoot)
  else out.push(stage.writable ? "--bind" : "--ro-bind", stage.directory, confinement.workspaceRoot)
  const stagedFiles = new Set(stage?.files)
  const stagedLinks = new Set(stage?.links)
  out.push("--dir", confinement.cwd)
  // The target of a link that leaves the workspace is bound first, so the
  // link a declared read then binds resolves to the same bytes the host sees
  // even when `/tmp` above the target has just become a private tmpfs.
  for (const real of confinement.externalReads) out.push("--ro-bind", real, real)
  const [program, ...args] = argv
  const launch = program === undefined ? undefined : launcher(
    program,
    searchPath,
    [...confinement.reads, ...confinement.writes, ...confinement.externalReads],
    confinement.workspaceRoot,
    hostFacts
  )
  for (const read of launch?.reads ?? []) out.push("--ro-bind", read, read)
  for (const read of confinement.reads) if (!stagedFiles.has(read)) out.push("--ro-bind", read, read)
  for (const write of confinement.writes) out.push("--bind", write, write)
  // A host link is created where no bound path already holds it: a link
  // inside a bind is there as the host's own, and an older bubblewrap refuses
  // to create one that exists.
  const bound = [
    ...runtime,
    ...confinement.externalReads,
    ...(launch?.reads ?? []),
    ...confinement.reads,
    ...confinement.writes
  ]
  for (const link of confinement.externalLinks ?? []) {
    if (bound.some((path) => insideRoot(path, link.path))) continue
    out.push("--symlink", link.target, link.path)
  }
  for (const link of confinement.privateLinks ?? []) out.push("--symlink", link.target, `/tmp/${link.path}`)
  // A link inside a bound read or write is already there as the host's own
  // link. Every other one is created in the workspace tmpfs, with its parent
  // directories, before the tmpfs is remounted read-only.
  for (const link of confinement.links ?? []) {
    if (stagedLinks.has(link.path)) continue
    if ([...confinement.reads, ...confinement.writes].some((bound) => insideRoot(bound, link.path))) continue
    out.push("--symlink", link.target, link.path)
  }
  for (const closed of confinement.readOnly) {
    if (confinement.writes.some((write) => closed === write || closed.startsWith(write + pathApi(write).sep))) {
      if (!hostFacts.exists(closed)) {
        throw unenforceable(
          hostFacts.platform,
          "bubblewrap",
          "existing readOnly path",
          "a missing readOnly path cannot be sealed beneath a writable mount"
        )
      }
      out.push("--ro-bind", closed, closed)
    }
  }
  // A hidden entry is covered after every grant and seal that could reach it.
  // The mask is a mount on the entry itself, so it follows a renamed parent,
  // refuses a rename or removal of the entry, and cannot be hard-linked.
  const hidden = confinement.hidden ?? { paths: [], restored: [] }
  for (const path of hidden.paths) {
    if (!hostFacts.isDirectory(path)) {
      out.push("--ro-bind", "/dev/null", path)
      continue
    }
    out.push("--tmpfs", path)
    for (const open of hidden.restored) {
      if (insideRoot(path, open) && hostFacts.exists(open)) out.push("--ro-bind", open, open)
    }
    out.push("--remount-ro", path)
  }
  // What the operator reopened is for reading: a writable workspace bind
  // around it would otherwise let the run replace it.
  for (const open of hidden.restored) {
    if (hostFacts.exists(open) && !hidden.paths.some((path) => insideRoot(path, open))) {
      out.push("--ro-bind", open, open)
    }
  }
  const granted = [
    ...runtime,
    ...(launch?.reads ?? []),
    ...confinement.reads,
    ...confinement.writes,
    ...confinement.externalReads
  ]
  for (const path of credentialPaths(hostFacts)) {
    if (!hostFacts.exists(path) || !granted.some((parent) => insideRoot(parent, path))) continue
    // An explicit external read can name a credential or a file inside it.
    // Mask first, then restore only those explicit paths below the mask.
    if (confinement.externalReads.some((parent) => insideRoot(parent, path))) continue
    const directory = hostFacts.isDirectory(path)
    if (directory) out.push("--tmpfs", path)
    else out.push("--ro-bind", "/dev/null", path)
    for (const read of confinement.externalReads) {
      if (insideRoot(path, read)) out.push("--ro-bind", read, read)
    }
    if (directory) out.push("--remount-ro", path)
  }
  refuseBrokerAliases(
    [
      ...runtime,
      ...(launch?.reads ?? []),
      ...confinement.reads,
      ...confinement.writes,
      ...confinement.externalReads,
      ...confinement.readOnly
    ],
    hostFacts,
    "bubblewrap"
  )
  // Unix sockets cross network namespaces. Mask the reserved broker tree
  // after every broad grant, including read-only external mounts; only this
  // run's host-owned socket is then restored.
  out.push("--tmpfs", destinationBrokerRoot)
  if (confinement.destinationSocket !== undefined) {
    const socket = confinement.destinationSocket
    if (
      NodePath.dirname(NodePath.dirname(socket)) !== destinationBrokerRoot ||
      !NodePath.basename(NodePath.dirname(socket)).startsWith("run-") || NodePath.basename(socket) !== "p.sock"
    ) {
      throw unenforceable(
        hostFacts.platform,
        "bubblewrap",
        "private destination broker",
        "invalid destination broker socket"
      )
    }
    out.push("--ro-bind", socket, socket)
  }
  // `--remount-ro` acts on the mount at that exact path. When the root itself
  // is a declared write (a declared output file at the top level opens its
  // parent), that mount is the writable bind, and remounting it would deny
  // every write the declaration admitted; the tmpfs it replaced needs no
  // re-closing. A scratch layer leaves the tmpfs writable: an undeclared write
  // lands in it and is gone with the namespace, while every declared read
  // stays its own read-only bind above it.
  if (confinement.scratch !== true && !confinement.writes.includes(confinement.workspaceRoot)) {
    out.push("--remount-ro", confinement.workspaceRoot)
  }
  out.push("--remount-ro", "/")
  out.push("--chdir", confinement.cwd, "--unshare-all", "--new-session", "--die-with-parent")
  // Bubblewrap cannot expose only the host loopback interface. Planning
  // refuses that posture on Linux, so only an explicit full-network opening
  // reaches `--share-net` here.
  if (confinement.network === "loopback") {
    throw new Error("bubblewrap cannot render loopback-only networking")
  }
  if (confinement.network === "open") out.push("--share-net")
  out.push("--", ...(launch === undefined ? argv : [launch.program, ...args]))
  return out
}

/** Escapes one string for a seatbelt profile literal. */
const sbpl = (value: string): string => `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`

/** Every directory from the workspace root down to the parent of each path. */
const ancestors = (root: string, paths: ReadonlyArray<string>): ReadonlyArray<string> => {
  const found = new Set<string>([root])
  for (const path of paths) {
    let current = pathApi(path).dirname(path)
    while (current.length >= root.length && current !== pathApi(current).dirname(current)) {
      found.add(current)
      if (current === root) break
      current = pathApi(current).dirname(current)
    }
  }
  return [...found].sort()
}

/**
 * The seatbelt profile for a plan.
 *
 * File reads start closed, then enumerated runtime paths and declared sets
 * are opened. The workspace is re-closed before its grants so a workspace
 * under a runtime root does not inherit the broad runtime grant. Credentials
 * are re-closed before explicit external reads, which can opt into them.
 *
 * @category rendering
 * @since 0.1.0
 */
export const seatbelt = (confinement: Plan, hostFacts: Host = host()): string => {
  if (confinement.mechanism._tag !== "seatbelt") throw new Error("a seatbelt profile needs a seatbelt plan")
  validateWrites(confinement, hostFacts)
  const lines: Array<string> = ["(version 1)", confinement.strict === true ? "(deny default)" : "(allow default)"]
  if (confinement.strict === true) {
    // No Mach lookup, Apple Events or LaunchServices grants: work must stay
    // in descendants inheriting this sandbox, never delegated to a host daemon.
    lines.push(
      "(allow process-exec)",
      "(allow process-fork)",
      "(allow signal (target same-sandbox))",
      "(allow process-info* (target same-sandbox))",
      "(allow sysctl-read (sysctl-name-prefix \"hw.\") (sysctl-name-prefix \"machdep.cpu.\") (sysctl-name \"kern.argmax\") (sysctl-name \"kern.hostname\") (sysctl-name \"kern.maxfilesperproc\") (sysctl-name \"kern.maxproc\") (sysctl-name \"kern.osproductversion\") (sysctl-name \"kern.osrelease\") (sysctl-name \"kern.ostype\") (sysctl-name \"kern.osversion\") (sysctl-name \"kern.secure_kernel\") (sysctl-name \"kern.usrstack64\") (sysctl-name \"kern.version\") (sysctl-name \"sysctl.proc_cputype\") (sysctl-name \"vm.loadavg\"))",
      "(allow mach-host*)"
    )
    if (confinement.network === "open") lines.push("(allow network*)")
  }
  if (confinement.network !== "open") {
    lines.push("(deny network*)")
    if (confinement.unixSockets !== false) lines.push("(allow network* (local unix-socket))")
    if (confinement.network === "loopback") {
      lines.push(
        "(allow network-bind (local ip \"localhost:*\"))",
        "(allow network-inbound (local ip \"localhost:*\"))",
        "(allow network-outbound (remote ip \"localhost:*\"))"
      )
    }
  }
  if (confinement.network === "open" && confinement.unixSockets === false) {
    lines.push("(deny network* (local unix-socket))")
    if (confinement.strict === true) {
      // Darwin resolves DNS through this trusted endpoint. Full IP authority
      // permits DNS only; other host daemons remain closed, including Mach IPC.
      lines.push("(allow network-outbound (literal \"/private/var/run/mDNSResponder\"))")
    }
  }
  const writable = [...confinement.writes, confinement.tmp]
  lines.push(
    "(deny file-write*)",
    `(allow file-write* ${confinement.strict === true ? "(literal \"/dev/null\")" : "(subpath \"/dev\")"} ${
      writable.map((path) => `(subpath ${sbpl(path)})`).join(" ")
    })`
  )
  if (confinement.readOnly.length > 0) {
    lines.push(`(deny file-write* ${confinement.readOnly.map((path) => `(subpath ${sbpl(path)})`).join(" ")})`)
  }
  lines.push(
    "(deny file-read*)",
    confinement.strict === true
      ? "(allow file-read* (literal \"/\") (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/random\") (literal \"/dev/urandom\"))"
      : "(allow file-read* (literal \"/\") (subpath \"/dev\"))",
    // macOS's system aliases need readlink access before a shell can execute
    // an admitted file through them. Literal grants expose the links only;
    // their target directories still cannot be listed or read wholesale.
    "(allow file-read* (literal \"/tmp\") (literal \"/var\") (literal \"/etc\"))"
  )
  const runtime = runtimeReads(hostFacts)
  if (runtime.length > 0) lines.push(`(allow file-read* ${runtime.map((path) => `(subpath ${sbpl(path)})`).join(" ")})`)
  const readable = [...confinement.reads, ...confinement.writes, confinement.tmp]
  // Node realpath walks every ancestor, including parents outside the
  // workspace. Grant only their metadata, without listing or reading bytes.
  const externalLinks = (confinement.externalLinks ?? []).map((link) => link.path)
  const traversable = ancestors("/", [...runtime, ...readable, ...confinement.externalReads, ...externalLinks])
    .filter((path) => !insideRoot(confinement.workspaceRoot, path))
  lines.push(`(allow file-read-metadata ${traversable.map((path) => `(literal ${sbpl(path)})`).join(" ")})`)
  const links = (confinement.links ?? []).map((link) => link.path)
  const listable = ancestors(
    confinement.workspaceRoot,
    [...readable.filter((path) => insideRoot(confinement.workspaceRoot, path)), ...links]
  )
  lines.push(
    `(deny file-read* (subpath ${sbpl(confinement.workspaceRoot)}))`
  )
  if (confinement.strict === true) {
    const metadata = [
      ...new Set([
        ...listable,
        ...ancestors(confinement.workspaceRoot, [confinement.cwd]),
        confinement.cwd
      ])
    ].sort()
    lines.push(`(allow file-read-metadata ${metadata.map((path) => `(literal ${sbpl(path)})`).join(" ")})`)
  } else {
    lines.push(`(allow file-read-metadata (subpath ${sbpl(confinement.workspaceRoot)}))`)
  }
  // File discovery (tsc include, Vitest, glob walkers) needs directory data,
  // not just stat access. Open only each declared read's ancestor literal:
  // listing sibling names does not grant their bytes or their subdirectories.
  // The cwd's metadata grant above is not a declaration of readable inputs.
  if (confinement.strict === true && confinement.reads.length + links.length > 0) {
    const directories = ancestors(confinement.workspaceRoot, [...confinement.reads, ...links])
    lines.push(`(allow file-read-data ${directories.map((path) => `(literal ${sbpl(path)})`).join(" ")})`)
  }
  lines.push(
    `(allow file-read* ${
      [
        ...(confinement.strict === true ? [] : listable.map((path) => `(literal ${sbpl(path)})`)),
        ...readable.map((path) => `(subpath ${sbpl(path)})`)
      ].join(" ")
    })`
  )
  if (confinement.readDenies.length > 0) {
    lines.push(`(deny file-read* ${confinement.readDenies.map((path) => `(subpath ${sbpl(path)})`).join(" ")})`)
  }
  // A link is granted as itself, a literal. A strict profile grants metadata
  // only on listed paths, so without this `readlink` fails there. Seatbelt
  // checks a read through the link against the resolved path, so what the
  // link points at stays closed unless a read opens it.
  if (links.length > 0) lines.push(`(allow file-read* ${links.map((path) => `(literal ${sbpl(path)})`).join(" ")})`)
  const credentials = credentialPaths(hostFacts)
  if (credentials.length > 0) {
    lines.push(`(deny file-read* ${credentials.map((path) => `(subpath ${sbpl(path)})`).join(" ")})`)
    if (confinement.strict === true) {
      lines.push(`(deny file-write* ${credentials.map((path) => `(subpath ${sbpl(path)})`).join(" ")})`)
    }
  }
  if (confinement.externalReads.length > 0) {
    lines.push(`(allow file-read* ${confinement.externalReads.map((path) => `(subpath ${sbpl(path)})`).join(" ")})`)
  }
  // A host link is granted as itself; what it points at needs its own read.
  if (externalLinks.length > 0) {
    lines.push(`(allow file-read* ${externalLinks.map((path) => `(literal ${sbpl(path)})`).join(" ")})`)
  }
  const hidden = confinement.hidden
  if (hidden !== undefined && hidden.prefixes.length > 0) {
    // Last, so no grant above reopens a hidden name. A pattern on the whole
    // path holds when a parent directory is renamed, and seatbelt refuses a
    // hard link whose source it may not read. The pattern covers the private
    // temporary directory too: a run may rename a workspace directory there.
    const roots = [confinement.workspaceRoot, confinement.tmp]
    if (roots.some((root) => /["\n\r]/.test(root)) || hidden.prefixes.some((prefix) => !hiddenPrefix.test(prefix))) {
      throw unenforceable(
        hostFacts.platform,
        "seatbelt",
        "expressible hidden name",
        "a hidden entry name or the workspace path cannot be written as a seatbelt pattern"
      )
    }
    const literal = (text: string): string => text.replace(/[.[\]{}()*+?^$|\\]/g, "\\$&")
    const anyCase = (text: string): string =>
      [...text].map((character) =>
        /[A-Za-z]/.test(character) ? `[${character.toLowerCase()}${character.toUpperCase()}]` : literal(character)
      ).join("")
    const names = hidden.prefixes.map(anyCase).join("|")
    lines.push(
      `(deny file-read* file-write* (regex #"^(${roots.map(literal).join("|")})/(.*/)?(${names})[^/]*(/|$)"))`
    )
    if (hidden.restored.length > 0) {
      // Reopened for reading alone: a run that could write there could move
      // a directory in and read the hidden entries below it.
      const reopened = hidden.restored.map((path) => `(subpath ${sbpl(path)})`).join(" ")
      lines.push(`(allow file-read* ${reopened})`, `(deny file-write* ${reopened})`)
    }
  }
  return lines.join("")
}

/**
 * One `key=value` field of a `docker run --mount` value. Docker parses the
 * value as one CSV record, so a field containing a comma, a quote, or a line
 * break is wrapped in quotes with inner quotes doubled; any other field keeps
 * its plain spelling.
 */
const mountField = (key: string, value: string): string => {
  const field = `${key}=${value}`
  return /[",\r\n]/.test(field) ? `"${field.replaceAll("\"", "\"\"")}"` : field
}

const bindMount = (path: string, readonly: boolean): string =>
  ["type=bind", mountField("src", path), mountField("dst", toPosix(path)), ...(readonly ? ["readonly"] : [])].join(",")

/**
 * The `docker run` argv for a plan. Paths keep their host spelling inside the
 * container so an argv that names workspace paths works unchanged; the image
 * supplies everything outside the workspace.
 *
 * @category rendering
 * @since 0.1.0
 */
export const docker = (
  confinement: Plan,
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
  hostFacts: Host = host(),
  containerName: string = `smithers-${randomUUID()}`
): ReadonlyArray<string> => {
  if (confinement.mechanism._tag !== "docker") throw new Error("docker argv needs a docker plan")
  validateWrites(confinement, hostFacts)
  if (confinement.network === "loopback") {
    throw unenforceable(hostFacts.platform, "docker", "network: true", "docker cannot render loopback-only networking")
  }
  const out: Array<string> = [
    confinement.mechanism.executable,
    "run",
    "--rm",
    "--init",
    "--name",
    containerName,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,exec",
    "--network",
    confinement.network === "open" ? "bridge" : "none",
    "--workdir",
    toPosix(confinement.cwd)
  ]
  if (confinement.uid !== undefined && confinement.gid !== undefined) {
    out.push("--user", `${confinement.uid}:${confinement.gid}`)
  }
  for (const real of confinement.externalReads) out.push("--mount", bindMount(real, true))
  for (const read of confinement.reads) out.push("--mount", bindMount(read, true))
  for (const write of confinement.writes) out.push("--mount", bindMount(write, false))
  for (const closed of confinement.readOnly) {
    if (confinement.writes.some((write) => closed === write || closed.startsWith(write + pathApi(write).sep))) {
      out.push("--mount", bindMount(closed, true))
    }
  }
  refuseBrokerAliases(
    [
      ...confinement.reads,
      ...confinement.writes,
      ...confinement.externalReads,
      ...confinement.readOnly
    ],
    hostFacts,
    "docker"
  )
  // A broad workspace/external mount must not reveal native host brokers.
  out.push("--tmpfs", destinationBrokerRoot + ":rw,noexec,nosuid,nodev")
  for (const [name, value] of Object.entries(env).sort(([left], [right]) => (left < right ? -1 : 1))) {
    if (name === "PATH" || name === "HOME") continue
    out.push("--env", `${name}=${value}`)
  }
  out.push("--env", "HOME=/tmp/home", confinement.mechanism.image, ...argv)
  return out
}

/**
 * Wraps a tool argv in the plan's mechanism and reports the environment the
 * wrapper needs the child to carry. Docker runs also return the unique
 * container name the caller must forcibly remove when the client scope closes.
 *
 * @category rendering
 * @since 0.1.0
 */
export const wrap = (
  confinement: Plan,
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
  hostFacts: Host = host()
): {
  readonly argv: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly containerName?: string
} => {
  const extra = environment(confinement)
  switch (confinement.mechanism._tag) {
    case "bubblewrap":
      return { argv: bubblewrap(confinement, argv, hostFacts, env["PATH"]), env: extra }
    case "seatbelt": {
      const profile = seatbelt(confinement, hostFacts)
      return { argv: [confinement.mechanism.executable, "-p", profile, ...argv], env: extra }
    }
    case "docker": {
      const containerName = `smithers-${randomUUID()}`
      return { argv: docker(confinement, argv, { ...env, ...extra }, hostFacts, containerName), env: {}, containerName }
    }
  }
}

/**
 * Each pattern names the path a tool complained about and whether the text
 * proves the denied operation was a write. A confined process never sees an
 * undeclared path: seatbelt answers EPERM, bubblewrap answers ENOENT because
 * the path was never mounted, and dash spells that "Directory nonexistent".
 */
const denialPatterns: ReadonlyArray<{ readonly pattern: RegExp; readonly write: boolean }> = [
  {
    pattern:
      /(?:^|\n)(?:mkdir|touch): ['"]?([^'":\n]+?)['"]?: (?:Operation not permitted|Permission denied|Read-only file system)/g,
    write: true
  },

  { pattern: /\b(?:EACCES|EPERM|ENOENT)\b[^'"\n]*['"]([^'"\n]+)['"]/g, write: false },
  { pattern: /\bEROFS\b[^'"\n]*['"]([^'"\n]+)['"]/g, write: true },
  {
    pattern:
      /(?:^|[\s:])((?:\/|\.{0,2}\/?)[^\s:'"]+): (?:Operation not permitted|Permission denied|No such file or directory|Directory nonexistent|Not a directory)/gm,
    write: false
  },
  { pattern: /(?:^|[\s:])((?:\/|\.{0,2}\/?)[^\s:'"]+): Read-only file system/gm, write: true },
  {
    pattern:
      /(?:Operation not permitted|Permission denied|No such file or directory|Directory nonexistent)[^\n]*?[:\s]['"]?((?:\/|[A-Za-z]:\\)[^'"\s:]+)/g,
    write: false
  },
  { pattern: /Read-only file system[^\n]*?[:\s]['"]?((?:\/|[A-Za-z]:\\)[^'"\s:]+)/g, write: true },
  {
    pattern: /cannot (?:create|write|touch|mkdir|remove) (?:directory )?['"]?((?:\/|[A-Za-z]:\\|\.{0,2}\/?)[^'":\s]+)/g,
    write: true
  },
  { pattern: /cannot (?:open|access|stat|read) ['"]?((?:\/|[A-Za-z]:\\|\.{0,2}\/?)[^'":\s]+)/g, write: false }
]

/**
 * Names, from a failed tool's own output, the paths it touched outside the
 * declared set. The sandbox denies at the kernel, so the only witness is the
 * tool's error text; this reads it back and says which side of the boundary
 * each path fell on.
 *
 * @category diagnostics
 * @since 0.1.0
 */
export const diagnose = (confinement: Plan, text: string): string | undefined => {
  // Path → whether the text proved the denied operation was a write.
  const named = new Map<string, boolean>()
  for (const { pattern, write } of denialPatterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[1]!
      const absolute = pathApi(raw).isAbsolute(raw) ? raw : pathApi(confinement.cwd).resolve(confinement.cwd, raw)
      if (insideRoot(confinement.workspaceRoot, absolute)) named.set(absolute, (named.get(absolute) ?? false) || write)
      if (named.size >= 5) break
    }
    if (named.size >= 5) break
  }
  if (named.size === 0) return undefined
  const covered = (path: string, set: ReadonlyArray<string>): boolean =>
    set.some((entry) => entry === path || path.startsWith(entry + pathApi(entry).sep))
  const lines = [...named.entries()].sort(([left], [right]) => (left < right ? -1 : 1)).map(([path, write]) => {
    const relative = pathApi(confinement.workspaceRoot).relative(confinement.workspaceRoot, path)
      .split(pathApi(confinement.workspaceRoot).sep).join("/")
    // A path that lexically sits in the workspace can still leave it through
    // a symlink in an existing ancestor; the declaration covers the tree, not
    // wherever a link points.
    const real = realized(path)
    const escapes = !insideRoot(confinement.workspaceRoot, real)
    const readable = !escapes && (covered(path, confinement.reads) || covered(path, confinement.writes))
    const writable = !escapes && covered(path, confinement.writes) && !covered(path, confinement.readOnly)
    if (escapes) {
      return `sandbox: ${relative} resolves to ${real}, outside the declared ${write ? "write" : "read"} set`
    }
    if (write) {
      return writable
        ? `sandbox: ${relative} was denied inside the declared set`
        : `sandbox: ${relative} is outside the declared write set`
    }
    if (!readable) return `sandbox: ${relative} is outside the declared read set`
    if (!writable) return `sandbox: ${relative} is outside the declared write set`
    return `sandbox: ${relative} was denied inside the declared set`
  })
  return `${lines.join("\n")}\nsandbox: ${confinement.mechanism._tag}, network ${confinement.network}, ` +
    `${confinement.reads.length} read path(s), ${confinement.writes.length} write path(s)`
}

/**
 * Wraps an argv so that neither the process nor a descendant can write below
 * `paths`, while it keeps every file, the network, the process table and the
 * environment of an unwrapped run.
 *
 * This is not a confinement. A caller uses it to hold a tree still under a
 * run it does not confine: an installed dependency tree a content key has
 * already measured, for one. A write there fails with a read-only file
 * system error, which is what a tool written for one expects.
 *
 * The mechanism is a mount namespace, and it shows in four ways a caller has
 * to know. An unprivileged caller runs in a user namespace with its own user
 * and group mapped, so a file another user owns reads as owned by `nobody`.
 * `no_new_privs` is set, so `sudo` and other setuid programs do not gain
 * privileges. Each protected path is a mount of its own, so a hard link
 * between it and anywhere else fails as a cross-device link. And a tool a
 * signal kills is reported by exit status, 128 plus the signal number.
 *
 * Each path is absolute. A path that does not exist is skipped, because the
 * mechanism cannot bind a missing path and there is nothing there to hold
 * still. Only Linux with bubblewrap has the mechanism: the host is bound as
 * it is, then each path is bound read-only over itself. Nothing is answered
 * on any other host, and the caller runs the argv as it is; see
 * {@link writeProtectionRefusal} for the reason.
 *
 * @category rendering
 * @since 1.0.0
 */
export const writeProtected = (
  paths: ReadonlyArray<string>,
  argv: ReadonlyArray<string>,
  hostFacts: Host = host()
): ReadonlyArray<string> | undefined => {
  const executable = hostFacts.platform === "linux" ? hostFacts.executable("bwrap") : undefined
  if (executable === undefined) return undefined
  const out: Array<string> = [executable, "--dev-bind", "/", "/"]
  for (const path of collapse(paths.filter((path) => hostFacts.exists(path)))) out.push("--ro-bind", path, path)
  // A run as root stays the run it was unwrapped: it keeps its capabilities.
  if (hostFacts.uid === 0) out.push("--cap-add", "ALL")
  out.push("--die-with-parent", "--", ...argv)
  return out
}

/**
 * Why this host cannot write-protect a path under a run, or nothing when it
 * can.
 *
 * Having the program is not enough: a container without user namespaces, or
 * a host whose policy forbids them, has bubblewrap and refuses to start it.
 * So the mechanism is started once, over the directory holding its own
 * program, and its refusal is the answer. `timeoutMs` bounds that start.
 *
 * @category resolution
 * @since 1.0.0
 */
export const writeProtectionRefusal = (hostFacts: Host = host(), timeoutMs = 60_000): string | undefined => {
  if (hostFacts.platform !== "linux") {
    return `write protection needs bubblewrap, which runs only on Linux; this host is ${hostFacts.platform}`
  }
  const executable = hostFacts.executable("bwrap")
  if (executable === undefined) {
    return "write protection needs bubblewrap, and bwrap is not on PATH (install the bubblewrap package)"
  }
  const [program, ...args] = writeProtected([NodePath.dirname(executable)], [executable, "--version"], hostFacts)!
  try {
    execFileSync(program!, args, { stdio: ["ignore", "ignore", "pipe"], timeout: timeoutMs })
    return undefined
  } catch (cause) {
    const stderr = String((cause as { readonly stderr?: unknown }).stderr ?? "").trim().split("\n")[0]!
    return `bubblewrap could not start on this host: ${stderr === "" ? (cause as Error).message : stderr}`
  }
}
