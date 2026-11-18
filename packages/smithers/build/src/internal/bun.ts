/**
 * What the install reads out of Bun's own files, with no host access.
 *
 * Three files decide what a Bun install does and none of them is frozen by a
 * flag: `bun.lock` names the workspace manifests and patch files Bun opens,
 * `bunfig.toml` can move the cache, skip the work, or carry a credential, and
 * the `.env` files Bun always loads can set any variable Bun reads. Each
 * function here takes the text of one such file and returns either the facts
 * the install needs or a {@link Refusal} naming a setting, never a value.
 * Nothing here throws.
 *
 * Nothing here is reachable from outside the package: the export map maps
 * `./internal/*` to `null`.
 *
 * @since 1.0.0
 */

import { parse as parseJsonc, type ParseError } from "jsonc-parser"
import { parse as parseToml } from "smol-toml"

/**
 * Why one of Bun's files was refused.
 *
 * `code` is one of the package-manager error codes; the caller turns the
 * value into a `PackageManagerError` without rewriting the message.
 *
 * @private
 * @since 1.0.0
 */
export interface Refusal {
  readonly _tag: "Refusal"
  readonly code: "lockfile_unreadable" | "unsafe_configuration" | "unsupported"
  readonly message: string
}

const refuse = (code: Refusal["code"], message: string): Refusal => ({ _tag: "Refusal", code, message })

/**
 * Whether a reader answered with a {@link Refusal}.
 *
 * @private
 * @since 1.0.0
 */
export const isRefusal = (value: unknown): value is Refusal =>
  typeof value === "object" && value !== null && (value as { readonly _tag?: unknown })._tag === "Refusal"

/**
 * The paths a `bun.lock` makes Bun open besides the lockfile itself.
 *
 * @private
 * @since 1.0.0
 */
export interface Lockfile {
  /** Workspace member directories, sorted; the root is not listed. */
  readonly members: ReadonlyArray<string>
  /** Patch files named by `patchedDependencies`, sorted and distinct. */
  readonly patches: ReadonlyArray<string>
}

/**
 * The most workspace members or patch files one lockfile may name.
 *
 * @private
 * @since 1.0.0
 */
export const maximumLockfilePaths = 4096

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Whether a path a lockfile supplied is safe to join to the project root.
 *
 * The lockfile is repository content, so a path is admitted only when it
 * names something below the root in plain segments: no absolute path, no
 * drive, no backslash, no `.` or `..`, nothing inside `node_modules`, and
 * nothing inside the install store. The two names are compared without case,
 * because on a case-insensitive filesystem `NODE_MODULES` is `node_modules`.
 */
const plainPath = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 1024 && value.isWellFormed() &&
  !/[\u0000-\u001f\u007f\\]/.test(value) && !/^[A-Za-z]:/.test(value) &&
  value.split("/").every((segment) =>
    segment !== "" && segment !== "." && segment !== ".." && segment.toLowerCase() !== "node_modules"
  ) && value.split("/")[0]!.toLowerCase() !== ".flows"

/** The resolution half of a `name@resolution` package identifier. */
const resolutionOf = (identifier: string): string =>
  identifier.slice(identifier.indexOf("@", identifier.startsWith("@") ? 1 : 0) + 1)

/**
 * Reads the workspace members and patch files a Bun text lockfile names.
 *
 * The fetch runs in a staging tree that holds copies of exactly these files,
 * so the lockfile is the list of what to copy. A package resolved from a
 * local folder, link, or tarball is refused: the staging tree holds no copy
 * of it, and copying arbitrary directories would make the fetch's read set
 * whatever the lockfile says it is.
 *
 * Returns a {@link Refusal} with `lockfile_unreadable` when the text is not a
 * Bun text lockfile, names an unusable path, or holds a workspace package
 * outside its workspaces, and with `unsupported` for a patch file that does
 * not end in `.patch` or a package resolved from anything but a registry
 * version, an `http(s)` tarball, or a git source.
 *
 * @private
 * @since 1.0.0
 */
export const readLockfile = (text: string): Lockfile | Refusal => {
  const errors: Array<ParseError> = []
  const document: unknown = parseJsonc(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || !isRecord(document) || typeof document.lockfileVersion !== "number") {
    return refuse("lockfile_unreadable", "bun.lock is not a Bun text lockfile")
  }
  const workspaces = document.workspaces
  if (!isRecord(workspaces) || !Object.hasOwn(workspaces, "")) {
    return refuse("lockfile_unreadable", "bun.lock declares no root workspace")
  }
  const patched = document.patchedDependencies ?? {}
  const packages = document.packages ?? {}
  if (!isRecord(patched) || !isRecord(packages)) {
    return refuse("lockfile_unreadable", "bun.lock patchedDependencies and packages must be tables")
  }
  const members = Object.keys(workspaces).filter((path) => path !== "").sort()
  const patches = [...new Set(Object.values(patched))].sort()
  if (members.length > maximumLockfilePaths || patches.length > maximumLockfilePaths) {
    return refuse("lockfile_unreadable", `bun.lock names more than ${maximumLockfilePaths} workspaces or patch files`)
  }
  if (!members.every(plainPath) || !patches.every(plainPath)) {
    return refuse("lockfile_unreadable", "bun.lock names a workspace or patch path outside the workspace sources")
  }
  // The fetch and link read declarations name patch files by this suffix.
  const misnamed = patches.find((path) => !path.endsWith(".patch"))
  if (misnamed !== undefined) {
    return refuse("unsupported", `bun.lock names the patch file ${misnamed}; a patch file must end in .patch`)
  }
  for (const [name, entry] of Object.entries(packages)) {
    const identifier: unknown = Array.isArray(entry) ? entry[0] : undefined
    if (typeof identifier !== "string") {
      return refuse("lockfile_unreadable", "bun.lock holds a package entry without an identifier")
    }
    const resolution = resolutionOf(identifier)
    if (resolution.startsWith("workspace:")) {
      // A workspace package lives where a workspace is declared, or nowhere.
      if (members.includes(resolution.slice("workspace:".length))) continue
      return refuse("lockfile_unreadable", "bun.lock holds a workspace package outside its workspaces")
    }
    // Everything the staging copy can install comes from a network source: an
    // exact registry version, an `http(s)` tarball, or a git source. A folder,
    // a link, or a local tarball is spelled as a path, with or without
    // `file:`, and a tarball named `1.0.0.tgz` is still a path.
    if (
      !/^(?:\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$|https?:\/\/|github:|git\+https:\/\/|git\+ssh:\/\/)/.test(resolution)
    ) {
      return refuse(
        "unsupported",
        `bun.lock resolves ${name.slice(0, 214)} from a source the fetch does not install; registry versions, ` +
          "workspace members, http(s) tarballs, and github:, git+https: and git+ssh: sources install, and file:, " +
          "link:, and local tarball dependencies do not"
      )
    }
  }
  return { members, patches }
}

/**
 * The `[install]` settings of `bunfig.toml` the install knows.
 *
 * The list is Bun 1.4's documented set. A setting outside it is refused: its
 * effect on the store, the lockfile, or the network is unknown here, and the
 * flags the install passes cannot be assumed to outrank it.
 */
const installSettings: ReadonlySet<string> = new Set([
  "auto",
  "ca",
  "cache",
  "cafile",
  "concurrentScripts",
  "dev",
  "dryRun",
  "exact",
  "frozenLockfile",
  "globalBinDir",
  "globalDir",
  "globalStore",
  "hoist",
  "hoistPattern",
  "ignoreScripts",
  "linkWorkspacePackages",
  "linker",
  "lockfile",
  "logLevel",
  "minimumReleaseAge",
  "minimumReleaseAgeExcludes",
  "offline",
  "optional",
  "peer",
  "prefer",
  "production",
  "publicHoistPattern",
  "registry",
  "saveTextLockfile",
  "scopes",
  "security"
])

const unsafe = (message: string): Refusal => refuse("unsafe_configuration", `bunfig.toml ${message}`)

/**
 * Finds a credential or an environment placeholder anywhere in a table.
 *
 * Bun expands `$NAME` in `bunfig.toml` from the child environment, which
 * holds the operator's proxy values and any forwarded registry credential, so
 * a placeholder would send one to a server the repository names. The file is
 * also digested into install key material, so it cannot hold a literal
 * credential either. Registry credentials belong in `.npmrc`.
 */
const findSecret = (value: unknown, path: string): Refusal | undefined => {
  if (typeof value === "string") {
    if (value.includes("$")) {
      return unsafe(`setting ${path} uses an environment placeholder; put registry credentials in .npmrc`)
    }
    return /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@\s]+@/.test(value)
      ? unsafe(`setting ${path} embeds a credential; put registry credentials in .npmrc`)
      : undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  for (const [key, member] of Object.entries(value)) {
    if (key.includes("$")) return unsafe(`table ${path} has a setting name with an environment placeholder`)
    if (/^(?:token|username|password|_auth|_authtoken|_password)$/i.test(key)) {
      return unsafe(`setting ${path}.${key} embeds a credential; put registry credentials in .npmrc`)
    }
    const found = findSecret(member, `${path}.${key}`)
    if (found !== undefined) return found
  }
  return undefined
}

/** Checks one registry value: a URL, or a table holding only `url`. */
const checkRegistry = (value: unknown, path: string, credential: boolean): Refusal | undefined => {
  const url = isRecord(value) && Object.keys(value).length === 1 ? value.url : value
  if (typeof url !== "string") return unsafe(`setting ${path} must be a registry URL`)
  return credential && !/^https:\/\//i.test(url)
    ? unsafe(`setting ${path} changes how a forwarded credential travels; registries must be https`)
    : undefined
}

/** Names the first key of a table outside the ones the install knows. */
const unknownKey = (value: unknown, path: string, keys: ReadonlyArray<string>): Refusal | undefined => {
  if (!isRecord(value)) return unsafe(`setting ${path} must be a table`)
  const unknown = Object.keys(value).find((key) => !keys.includes(key))
  return unknown === undefined
    ? undefined
    : unsafe(`setting ${path}.${unknown.slice(0, 64)} is not a setting the install knows`)
}

/** Checks one `[install]` setting whose value can defeat a boundary. */
const checkSetting = (key: string, value: unknown, credential: boolean): Refusal | undefined => {
  switch (key) {
    case "dryRun":
    case "offline":
      return value === false
        ? undefined
        : unsafe(`setting install.${key} would stop the fetch from populating the store`)
    case "cache": {
      if (value === true) return undefined
      const unknown = value === false
        ? undefined
        : unknownKey(value, "install.cache", ["dir", "disable", "disableManifest"])
      if (unknown !== undefined) return unknown
      return value === false || (value as { readonly disable?: unknown }).disable === true
        ? unsafe("setting install.cache disables the cache the offline link installs from")
        : undefined
    }
    case "lockfile": {
      const unknown = unknownKey(value, "install.lockfile", ["save", "print"])
      if (unknown !== undefined) return unknown
      // Bun writes the printed lockfile into its working directory even when
      // the install is frozen, which at link is the project root.
      return (value as { readonly print?: unknown }).print === undefined
        ? undefined
        : unsafe("setting install.lockfile.print writes a second lockfile into the project")
    }
    case "security":
      return unsafe("setting install.security runs a scanner package during the install")
    case "ca":
    case "cafile":
      return credential
        ? unsafe(`setting install.${key} changes how a forwarded credential travels; TLS settings come from the host`)
        : undefined
    case "registry":
      return checkRegistry(value, "install.registry", credential)
    case "scopes": {
      if (!isRecord(value)) return unsafe("setting install.scopes must be a table")
      for (const [scope, registry] of Object.entries(value)) {
        const refused = checkRegistry(registry, `install.scopes.${scope.slice(0, 64)}`, credential)
        if (refused !== undefined) return refused
      }
      return undefined
    }
    default:
      return undefined
  }
}

/**
 * Holds a `bunfig.toml` to the settings the install can keep its boundaries
 * under.
 *
 * Only the `[install]` table is checked; the other tables configure the
 * runtime, the test runner, and scripts, and `bun install` does not read them.
 * `credential` says a project `.npmrc` forwards a host credential, which
 * tightens transport: registries must be https and the repository may not
 * supply a certificate authority.
 *
 * Returns a {@link Refusal} with `unsafe_configuration` when the file cannot
 * be parsed, names a setting outside the known set, would skip or redirect
 * the install (`dryRun`, `offline`, a disabled cache), writes a file outside
 * the install's trees (`lockfile.print`), runs code (`security`), holds a
 * credential or an environment placeholder, or loosens transport while a
 * credential is forwarded. Messages name settings and
 * never values.
 *
 * @private
 * @since 1.0.0
 */
export const checkBunfig = (text: string, credential: boolean): Refusal | undefined => {
  let install: unknown
  try {
    install = parseToml(text, { maxDepth: 32 }).install
  } catch {
    return unsafe("cannot be safely parsed")
  }
  if (install === undefined) return undefined
  if (!isRecord(install)) return unsafe("setting install must be a table")
  const secret = findSecret(install, "install")
  if (secret !== undefined) return secret
  for (const [key, value] of Object.entries(install)) {
    if (!installSettings.has(key)) {
      return unsafe(`setting install.${key.slice(0, 64)} is not a setting the install knows`)
    }
    const refused = checkSetting(key, value, credential)
    if (refused !== undefined) return refused
  }
  return undefined
}

/**
 * The environment files Bun loads from the project root on every command.
 *
 * `bun install` has no switch that stops it loading them, and a variable set
 * in the process environment outranks the same name in a file. The install
 * pins what it can that way and refuses the rest with
 * {@link reservedAssignment}.
 *
 * @private
 * @since 1.0.0
 */
export const envFileNames = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
  ".env.test",
  ".env.test.local"
] as const

/**
 * The first variable an environment file assigns that configures Bun's
 * installer, or `undefined`.
 *
 * Any `BUN_` or `NPM_CONFIG_` name is reserved: the documented ones skip the
 * install, ignore the lockfile, move the cache, or name a registry, and an
 * undocumented one is assumed to. Only names are read; a value is never
 * returned, digested, or logged.
 *
 * @private
 * @since 1.0.0
 */
export const reservedAssignment = (text: string): string | undefined => {
  for (const match of text.matchAll(/^[ \t]*(?:export[ \t]+)?["']?([A-Za-z_][A-Za-z0-9_]*)["']?[ \t]*[=:]/gm)) {
    if (/^(?:BUN_|NPM_CONFIG_)/i.test(match[1]!)) return match[1]
  }
  return undefined
}
