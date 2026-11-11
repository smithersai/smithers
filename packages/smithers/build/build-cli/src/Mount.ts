/**
 * Mount materialization: run an overlay repository's automation against an
 * upstream repository it never forks.
 *
 * An overlay repository's `.smithers/config.ts` default-exports `S.Mounts`.
 * A command run from the overlay materializes the named mount before it
 * plans: it fetches the pinned upstream commit into `.mounts/<name>` at the
 * overlay root, applies the declared patches as commits on top of the pin,
 * and lays the overlay's `.smithers/` over the checkout. The command then
 * plans against the checkout, so every `//` label and every relative upstream
 * config resolves as if the overlay's `.smithers/` lived upstream.
 *
 * The checkout is derived state. Materialization never discards work: edits
 * and commits to upstream files survive while the pin and patches hold still
 * and block a re-materialization that would replace them, and an edit to a
 * laid `.smithers/` file blocks the next lay. Laying never writes through a
 * symbolic link or file upstream tracks under `.smithers/`. The upstream
 * repository is only ever read. See `docs/concepts/mounts.md` for the design
 * and its alternatives.
 *
 * @since 1.0.0
 */

import * as MountDeclaration from "@smthrs/targets/Mount"
import * as Data from "effect/Data"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import * as Diagnostic from "./Diagnostic.ts"
import { importDeclarationModule } from "./effect-resolution.js"
import * as PackageDiscovery from "./PackageDiscovery.ts"

const executeFile = promisify(execFile)

/**
 * The overlay-relative directory every checkout lives under.
 *
 * @category constants
 * @since 1.0.0
 */
export const checkoutsDirectory = ".mounts"

/**
 * The receipt a checkout's `.git` directory holds, naming what was
 * materialized so the next command can tell whether anything moved.
 *
 * @category constants
 * @since 1.0.0
 */
export const receiptFile = "smithers-mount.json"

/**
 * Why a mount could not be materialized.
 *
 * - `mount_config_invalid`: `.smithers/config.ts` failed to evaluate, does
 *   not default-export `S.Mounts`, or names a missing patch file.
 * - `mount_ambiguous`: the overlay declares several mounts and the command
 *   did not name one.
 * - `mount_fetch_failed`: the pinned commit could not be fetched.
 * - `mount_drift`: the drift policy refused the tracked branch's state.
 * - `mount_patch_failed`: a declared patch does not apply to its base.
 * - `mount_dirty`: re-materializing would discard edits in the checkout.
 * - `mount_overlay_edited`: a laid `.smithers/` file was edited in the
 *   checkout, so laying the overlay again would discard the edit.
 * - `mount_overlay_collision`: an overlay file would replace a file the
 *   upstream repository tracks.
 *
 * @category errors
 * @since 1.0.0
 */
export class MountError extends Data.TaggedError("smithers-build/MountError")<{
  readonly code:
    | "mount_config_invalid"
    | "mount_ambiguous"
    | "mount_fetch_failed"
    | "mount_drift"
    | "mount_patch_failed"
    | "mount_dirty"
    | "mount_overlay_edited"
    | "mount_overlay_collision"
  readonly message: string
}> {}

/**
 * How the tracked branch relates to the materialized commit.
 *
 * `untracked` means the mount names no branch; `unknown` means the branch
 * could not be read under the `warn` policy.
 *
 * @category models
 * @since 1.0.0
 */
export interface Drift {
  readonly state: "untracked" | "current" | "behind" | "unknown"
  readonly track?: string | undefined
  readonly tip?: string | undefined
}

/**
 * One materialized mount.
 *
 * `pin` is the declared commit, `base` the commit checked out (the pin, or
 * the tracked tip under `follow`), and `head` the commit after the patches.
 *
 * @category models
 * @since 1.0.0
 */
export interface Materialized {
  readonly name: string
  readonly root: string
  readonly overlayRoot: string
  readonly repository: string
  readonly pin: string
  readonly base: string
  readonly head: string
  readonly patches: ReadonlyArray<string>
  readonly drift: Drift
}

/**
 * The host seams materialization reads: the environment git runs under,
 * the sink for the one-line mount report, and cancellation.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly report: (line: string) => void
  readonly signal?: AbortSignal | undefined
}

/**
 * Where a command plans: the workspace directory to open, and the mount
 * materialized for it when the command ran from an overlay.
 *
 * @category models
 * @since 1.0.0
 */
export interface Resolved {
  readonly workspace: string
  readonly mount: Materialized | undefined
}

interface Receipt {
  readonly version: 1
  readonly repository: string
  readonly base: string
  readonly head: string
  readonly patches: ReadonlyArray<{ readonly path: string; readonly digest: string }>
  readonly laid: Readonly<Record<string, string>>
}

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

const isFile = (path: string): Promise<boolean> => Fs.lstat(path).then((stats) => stats.isFile(), () => false)

const readDigest = (path: string): Promise<string | undefined> => Fs.readFile(path).then(digest, () => undefined)

const posix = (path: string): string => path.split(NodePath.sep).join("/")

const short = (commit: string): string => commit.slice(0, 12)

/** Whether `path` is `parent` or lies beneath it. */
const within = (parent: string, path: string): boolean => {
  const relative = NodePath.relative(parent, path)
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative))
}

const tail = (text: string): string => {
  const trimmed = text.trim()
  return trimmed.length <= 2048 ? trimmed : trimmed.slice(trimmed.length - 2048)
}

class GitFailure extends Error {}

/** Runs one git command without a shell and never prompts for credentials. */
const git = async (cwd: string, args: ReadonlyArray<string>, options: Options): Promise<string> => {
  try {
    const result = await executeFile("git", [...args], {
      cwd,
      env: { ...options.environment, GIT_TERMINAL_PROMPT: "0" },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      signal: options.signal
    })
    return result.stdout
  } catch (cause) {
    const failed = cause as { readonly stderr?: unknown; readonly message?: unknown }
    throw new GitFailure(`git ${args[0]} failed: ${tail(String(failed.stderr || failed.message || cause))}`)
  }
}

/** The nearest ancestor of `start` whose `.smithers/` holds `config.ts`. */
const overlayRootOf = async (start: string): Promise<string | undefined> => {
  let directory = start
  while (true) {
    if (await isFile(NodePath.join(directory, ".smithers", "config.ts"))) return directory
    const parent = NodePath.dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/**
 * Evaluates an overlay's `.smithers/config.ts` and returns its mounts.
 *
 * @category loading
 * @since 1.0.0
 */
export const loadConfig = async (overlayRoot: string): Promise<MountDeclaration.Mounts> => {
  let namespace: unknown
  try {
    namespace = await importDeclarationModule(
      pathToFileURL(NodePath.join(overlayRoot, ".smithers", "config.ts")).href,
      import.meta.url
    )
  } catch (cause) {
    throw new MountError({
      code: "mount_config_invalid",
      message: `evaluating .smithers/config.ts failed: ${Diagnostic.describe(cause)}`
    })
  }
  const value = typeof namespace === "object" && namespace !== null
    ? (namespace as { readonly default?: unknown }).default
    : undefined
  if (!MountDeclaration.isMounts(value)) {
    throw new MountError({
      code: "mount_config_invalid",
      message: ".smithers/config.ts must default-export S.Mounts({ <name>: S.Mount({ ... }) })"
    })
  }
  return value
}

/** Reads the tracked branch's tip, or undefined when it cannot be read. */
const tipOf = async (repository: string, track: string, cwd: string, options: Options) => {
  try {
    const listing = await git(cwd, ["ls-remote", "--heads", repository, `refs/heads/${track}`], options)
    const line = listing.split("\n").find((entry) => entry.endsWith(`\trefs/heads/${track}`))
    return line?.split("\t")[0]
  } catch {
    return undefined
  }
}

const hasCommit = (checkout: string, commit: string, options: Options): Promise<boolean> =>
  git(checkout, ["cat-file", "-e", `${commit}^{commit}`], options).then(() => true, () => false)

/** Fetches one commit: shallow by id first, then every branch for servers that refuse a bare id. */
const fetchCommit = async (checkout: string, commit: string, options: Options): Promise<void> => {
  if (await hasCommit(checkout, commit, options)) return
  try {
    await git(checkout, ["fetch", "--quiet", "--depth", "1", "--no-tags", "origin", commit], options)
  } catch {
    await git(checkout, ["fetch", "--quiet", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*"], options)
      .catch((cause: unknown) => {
        throw new MountError({
          code: "mount_fetch_failed",
          message: `could not fetch ${short(commit)}: ${cause instanceof Error ? cause.message : String(cause)}`
        })
      })
  }
  if (!(await hasCommit(checkout, commit, options))) {
    throw new MountError({ code: "mount_fetch_failed", message: `the upstream repository has no commit ${commit}` })
  }
}

const readReceipt = async (checkout: string): Promise<Receipt | undefined> => {
  try {
    const parsed = JSON.parse(await Fs.readFile(NodePath.join(checkout, ".git", receiptFile), "utf8")) as Receipt
    return parsed.version === 1 ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Every regular file under `directory`, as posix paths relative to it, skipping `skip`. */
const filesUnder = async (
  directory: string,
  skip: (relative: string) => boolean,
  relative = ""
): Promise<Array<string>> => {
  const entries = await Fs.readdir(NodePath.join(directory, relative), { withFileTypes: true })
  const found: Array<string> = []
  for (const entry of entries) {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`
    if (skip(path)) continue
    if (entry.isSymbolicLink()) {
      throw new MountError({
        code: "mount_config_invalid",
        message: `overlay file .smithers/${path} is a symbolic link; an overlay holds regular files`
      })
    }
    if (entry.isDirectory()) found.push(...await filesUnder(directory, skip, path))
    else if (entry.isFile()) found.push(path)
  }
  return found.sort()
}

const skippedNames: ReadonlySet<string> = new Set(["node_modules", ".flows", ".git", ".jj", checkoutsDirectory])

/**
 * The overlay files one mount lays, keyed by their path under the checkout's
 * `.smithers/`. `config.ts`, declared patches, and other mounts' overlay
 * directories stay in the overlay.
 */
const overlayFiles = async (
  overlayRoot: string,
  name: string,
  mounts: MountDeclaration.Mounts
): Promise<ReadonlyMap<string, string>> => {
  const smithers = NodePath.join(overlayRoot, ".smithers")
  const mount = mounts.mounts[name]!
  const base = mount.overlay === "." ? "" : mount.overlay
  const excluded = new Set<string>(["config.ts"])
  for (const [other, declaration] of Object.entries(mounts.mounts)) {
    for (const patch of declaration.patches) excluded.add(patch)
    if (other !== name && declaration.overlay !== ".") excluded.add(declaration.overlay)
  }
  const directory = NodePath.join(smithers, ...base.split("/").filter(Boolean))
  const present = await Fs.stat(directory).then((stats) => stats.isDirectory(), () => false)
  if (!present) {
    throw new MountError({
      code: "mount_config_invalid",
      message: `mount ${name} overlay directory .smithers/${base} does not exist`
    })
  }
  const files = await filesUnder(directory, (relative) => {
    const fromSmithers = base === "" ? relative : `${base}/${relative}`
    return skippedNames.has(NodePath.posix.basename(relative)) || excluded.has(fromSmithers)
  })
  return new Map(files.map((relative) => [relative, NodePath.join(directory, ...relative.split("/"))]))
}

/**
 * Refuses a laid path the checkout would redirect: every existing component
 * from `.smithers` down must be a real directory and the file itself a
 * regular file, so an upstream symbolic link or file at `.smithers/` or below
 * cannot send a write or a removal outside the checkout.
 */
const refuseIndirection = async (checkout: string, display: string, relative: string): Promise<void> => {
  const components = [".smithers", ...relative.split("/")]
  for (let index = 0; index < components.length; index++) {
    const path = components.slice(0, index + 1).join("/")
    const stats = await Fs.lstat(NodePath.join(checkout, ...components.slice(0, index + 1))).catch(() => undefined)
    if (stats === undefined) return
    if (index === components.length - 1 ? stats.isFile() : stats.isDirectory()) continue
    throw new MountError({
      code: "mount_overlay_collision",
      message: `overlay file .smithers/${relative} would be laid through ${path} in ${display}, which is a ${
        stats.isSymbolicLink() ? "symbolic link" : stats.isDirectory() ? "directory" : "file"
      }; change upstream with a patch instead`
    })
  }
}

/**
 * Lays the overlay over the checkout's `.smithers/`: copies new and changed
 * files, removes files an earlier lay placed that the overlay no longer has,
 * and refuses before writing anything when a destination holds an edit.
 */
const lay = async (
  checkout: string,
  display: string,
  files: ReadonlyMap<string, string>,
  previous: Readonly<Record<string, string>>,
  options: Options
): Promise<Record<string, string>> => {
  const tracked = new Set(
    (await git(checkout, ["ls-files", "-z", "--", ".smithers"], options)).split("\0").filter(Boolean)
  )
  for (const relative of new Set([...Object.keys(previous), ...files.keys()])) {
    await refuseIndirection(checkout, display, relative)
  }
  const laid: Record<string, string> = {}
  const sources = new Map<string, Buffer>()
  for (const [relative, source] of files) {
    const destination = `.smithers/${relative}`
    if (tracked.has(destination)) {
      throw new MountError({
        code: "mount_overlay_collision",
        message: `overlay file ${destination} would replace a file upstream tracks; change it with a patch instead`
      })
    }
    const bytes = await Fs.readFile(source)
    sources.set(relative, bytes)
    laid[relative] = digest(bytes)
  }
  const destinations = new Set([...Object.keys(previous), ...sources.keys()])
  for (const relative of destinations) {
    const current = await readDigest(NodePath.join(checkout, ".smithers", ...relative.split("/")))
    if (current === undefined || current === laid[relative] || current === previous[relative]) continue
    throw new MountError({
      code: "mount_overlay_edited",
      message: `.smithers/${relative} in ${display} was edited after it was laid; ` +
        "move the edit into the overlay, or delete the file to discard it"
    })
  }
  for (const relative of Object.keys(previous)) {
    if (!sources.has(relative)) {
      await Fs.rm(NodePath.join(checkout, ".smithers", ...relative.split("/")), { force: true })
    }
  }
  for (const [relative, bytes] of sources) {
    const destination = NodePath.join(checkout, ".smithers", ...relative.split("/"))
    if ((await readDigest(destination)) === laid[relative]) continue
    await Fs.mkdir(NodePath.dirname(destination), { recursive: true })
    await Fs.writeFile(destination, bytes)
  }
  return laid
}

/** The patch files a mount declares, with their digests, in order. */
const patchesOf = async (overlayRoot: string, name: string, mount: MountDeclaration.Declaration) =>
  Promise.all(mount.patches.map(async (path) => {
    const value = await readDigest(NodePath.join(overlayRoot, ".smithers", ...path.split("/")))
    if (value === undefined) {
      throw new MountError({
        code: "mount_config_invalid",
        message: `mount ${name} patch .smithers/${path} is missing`
      })
    }
    return { path, digest: value }
  }))

const identity = ["-c", "user.name=Smithers", "-c", "user.email=mount@smithers.invalid", "-c", "commit.gpgsign=false"]

/** The first ten items, joined, and how many more there are. */
const listed = (items: ReadonlyArray<string>): string =>
  `${items.slice(0, 10).join(", ")}${items.length > 10 ? `, and ${items.length - 10} more` : ""}`

/**
 * Checks out `base` and commits each patch on top of it; returns the new
 * head. An existing checkout must hold no edits and no commits beyond the
 * `materialized` head its receipt names.
 */
const checkout = async (
  root: string,
  repository: string,
  base: string,
  overlayRoot: string,
  patches: ReadonlyArray<{ readonly path: string }>,
  materialized: string | undefined,
  options: Options
): Promise<string> => {
  if (!(await isFile(NodePath.join(root, ".git", "HEAD")))) {
    await Fs.mkdir(root, { recursive: true })
    await git(root, ["init", "--quiet"], options)
    await git(root, ["remote", "add", "origin", repository], options)
  } else {
    await git(root, ["remote", "set-url", "origin", repository], options)
    const location = posix(NodePath.relative(overlayRoot, root))
    const status = await git(root, ["status", "--porcelain", "--untracked-files=all"], options)
    const edited = status.split("\n").filter(Boolean).map((line) => line.slice(3))
    if (edited.length > 0) {
      throw new MountError({
        code: "mount_dirty",
        message: `re-materializing would discard edits in ${location}: ${
          listed(edited)
        }; save them as a patch or discard them`
      })
    }
    if (materialized !== undefined) {
      const log = await git(root, ["log", "--format=%h %s", "HEAD", "--not", materialized], options)
      const commits = log.split("\n").filter(Boolean)
      if (commits.length > 0) {
        throw new MountError({
          code: "mount_dirty",
          message: `re-materializing would drop commits in ${location} on top of ${short(materialized)}: ${
            listed(commits)
          }; push them or save them as a patch, then reset the checkout to ${short(materialized)}`
        })
      }
    }
  }
  await Fs.mkdir(NodePath.join(root, ".git", "info"), { recursive: true })
  await Fs.writeFile(NodePath.join(root, ".git", "info", "exclude"), "/.smithers/\n/.flows/\n")
  await fetchCommit(root, base, options)
  await git(root, ["checkout", "--quiet", "--force", "--detach", base], options)
  for (const patch of patches) {
    const file = NodePath.join(overlayRoot, ".smithers", ...patch.path.split("/"))
    try {
      await git(root, ["apply", "--index", "--whitespace=nowarn", file], options)
    } catch (cause) {
      throw new MountError({
        code: "mount_patch_failed",
        message: `patch .smithers/${patch.path} does not apply to ${short(base)}: ${
          cause instanceof Error ? cause.message : String(cause)
        }`
      })
    }
    await git(
      root,
      [...identity, "commit", "--quiet", "--no-verify", "-m", `smithers mount: apply ${patch.path}`],
      options
    )
  }
  return (await git(root, ["rev-parse", "HEAD"], options)).trim()
}

/**
 * Materializes one named mount of an overlay and returns what was checked
 * out. The call is idempotent: with the pin, patches, and overlay unchanged
 * it fetches nothing and rewrites nothing.
 *
 * @category materialization
 * @since 1.0.0
 */
export const materialize = async (overlayRoot: string, name: string, options: Options): Promise<Materialized> => {
  const mounts = await loadConfig(overlayRoot)
  const mount = mounts.mounts[name]
  if (mount === undefined) {
    throw new MountError({
      code: "mount_ambiguous",
      message: `.smithers/config.ts declares no mount ${JSON.stringify(name)}; it declares ${
        Object.keys(mounts.mounts).join(", ")
      }`
    })
  }
  const directory = NodePath.join(overlayRoot, checkoutsDirectory)
  const root = NodePath.join(directory, name)
  await Fs.mkdir(directory, { recursive: true })
  await Fs.writeFile(NodePath.join(directory, ".gitignore"), "*\n")

  let drift: Drift = { state: "untracked" }
  let base = mount.ref
  if (mount.track !== undefined) {
    const tip = await tipOf(mount.repository, mount.track, directory, options)
    if (tip === undefined && mount.drift !== "warn") {
      throw new MountError({
        code: "mount_drift",
        message: `mount ${name} could not read ${mount.track} from ${mount.repository}; drift ${mount.drift} needs it`
      })
    }
    if (mount.drift === "refuse" && tip !== undefined && tip !== mount.ref) {
      throw new MountError({
        code: "mount_drift",
        message: `mount ${name} pins ${mount.ref}, but ${mount.track} is at ${tip}; move the pin to ${tip}`
      })
    }
    if (mount.drift === "follow" && tip !== undefined) base = tip
    drift = { state: tip === undefined ? "unknown" : tip === base ? "current" : "behind", track: mount.track, tip }
  }

  const patches = await patchesOf(overlayRoot, name, mount)
  const files = await overlayFiles(overlayRoot, name, mounts)
  const receipt = await readReceipt(root)
  // Commits made in the checkout on top of the materialized head keep it current.
  const current = receipt !== undefined &&
    receipt.repository === mount.repository &&
    receipt.base === base &&
    JSON.stringify(receipt.patches) === JSON.stringify(patches) &&
    await git(root, ["merge-base", "--is-ancestor", receipt.head, "HEAD"], options).then(() => true, () => false)
  let head: string
  try {
    head = current
      ? receipt.head
      : await checkout(root, mount.repository, base, overlayRoot, patches, receipt?.head, options)
  } catch (cause) {
    if (cause instanceof GitFailure) throw new MountError({ code: "mount_fetch_failed", message: cause.message })
    throw cause
  }
  const laid = await lay(root, `${checkoutsDirectory}/${name}`, files, receipt?.laid ?? {}, options)
  const next: Receipt = { version: 1, repository: mount.repository, base, head, patches, laid }
  await Fs.writeFile(NodePath.join(root, ".git", receiptFile), `${JSON.stringify(next, null, 2)}\n`)
  return {
    name,
    root,
    overlayRoot,
    repository: mount.repository,
    pin: mount.ref,
    base,
    head,
    patches: patches.map((patch) => patch.path),
    drift
  }
}

/**
 * The one-line report a command prints after materializing a mount.
 *
 * @category presentation
 * @since 1.0.0
 */
export const summary = (mount: Materialized): string => {
  const patches = mount.patches.length === 1 ? "1 patch" : `${mount.patches.length} patches`
  const location = posix(NodePath.relative(mount.overlayRoot, mount.root))
  const head = `mount ${mount.name}: ${short(mount.base)} + ${patches} from ${mount.repository} at ${location}`
  const { state, track, tip } = mount.drift
  switch (state) {
    case "untracked":
      return head
    case "unknown":
      return `${head}; ${track} could not be read`
    case "current":
      return mount.base === mount.pin
        ? `${head}; ${track} is current`
        : `${head}; following ${track} past the pin ${short(mount.pin)}`
    case "behind":
      return `${head}; ${track} moved to ${short(tip!)}, past the pin`
  }
}

/**
 * Decides where a command plans. From inside an overlay repository, the
 * selected mount is materialized and the command plans in its checkout, at
 * the same relative directory when the checkout has it. An overlay with one
 * mount selects it; an overlay with several selects the mount whose overlay
 * directory holds the starting directory. Anywhere else, including inside a
 * materialized checkout, the directory is returned as is.
 *
 * @category materialization
 * @since 1.0.0
 */
export const resolveWorkspace = async (start: string, options: Options): Promise<Resolved> => {
  const directory = NodePath.resolve(start)
  const overlayRoot = await overlayRootOf(directory)
  if (overlayRoot === undefined) return { workspace: directory, mount: undefined }
  // A workspace nested in the overlay, such as a materialized checkout, is
  // ordinary; the overlay's own `.smithers/` never is one.
  const workspaceRoot = await PackageDiscovery.findWorkspaceRoot(directory)
  if (
    workspaceRoot !== undefined && workspaceRoot !== overlayRoot && within(overlayRoot, workspaceRoot) &&
    !within(NodePath.join(overlayRoot, ".smithers"), workspaceRoot)
  ) {
    return { workspace: directory, mount: undefined }
  }
  const declared = Object.entries((await loadConfig(overlayRoot)).mounts)
  const selected = declared.length === 1
    ? declared[0]![0]
    : declared.find(([, mount]) =>
      mount.overlay !== "." && within(NodePath.join(overlayRoot, ".smithers", ...mount.overlay.split("/")), directory)
    )?.[0]
  if (selected === undefined) {
    throw new MountError({
      code: "mount_ambiguous",
      message: `.smithers/config.ts declares mounts ${
        declared.map(([name]) => name).join(", ")
      }; run from one mount's overlay directory, such as .smithers/${declared[0]![1].overlay}`
    })
  }
  const mount = await materialize(overlayRoot, selected, options)
  options.report(summary(mount))
  const relative = NodePath.relative(overlayRoot, directory)
  const mapped = NodePath.join(mount.root, relative)
  const present = relative !== "" && await Fs.stat(mapped).then((stats) => stats.isDirectory(), () => false)
  return { workspace: present ? mapped : mount.root, mount }
}
