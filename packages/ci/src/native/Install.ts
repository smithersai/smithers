/**
 * How a checkout of a repository that builds with Smithers build gets its
 * dependencies, and where its own `smthrs` is afterwards.
 *
 * @since 0.1.0
 */

/**
 * A package manager: the lockfiles that mean a directory is installed with
 * it, and the command that installs exactly what the lockfile pins.
 *
 * @category models
 * @since 0.1.0
 */
export interface Manager {
  readonly lockfiles: ReadonlyArray<string>
  readonly command: readonly [string, ...Array<string>]
}

/**
 * The package managers an install is run with, in the order their lockfiles
 * are looked for.
 *
 * @category constants
 * @since 0.1.0
 */
export const managers: ReadonlyArray<Manager> = [
  { lockfiles: ["pnpm-lock.yaml"], command: ["pnpm", "install", "--frozen-lockfile", "--prefer-offline"] },
  { lockfiles: ["bun.lock", "bun.lockb"], command: ["bun", "install", "--frozen-lockfile"] },
  { lockfiles: ["package-lock.json"], command: ["npm", "ci", "--no-audit", "--no-fund"] }
]

/**
 * The manager whose lockfile is among a directory's file names.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const managerFor = (names: ReadonlyArray<string>): Manager | undefined =>
  managers.find((manager) => manager.lockfiles.some((lockfile) => names.includes(lockfile)))

/**
 * The directories installed, from the repository root: the one that holds
 * the workspace file, then the root.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const installDirectories = (workspaceFile: string): ReadonlyArray<string> => {
  const directory = workspaceFile.includes("/") ? workspaceFile.slice(0, workspaceFile.lastIndexOf("/")) : ""
  return directory === "" ? [""] : [directory, ""]
}

/**
 * Where a package manager leaves the `smthrs` a directory depends on.
 *
 * @category constants
 * @since 0.1.0
 */
export const smthrsBin = "node_modules/.bin/smthrs"

/**
 * The label of the result that stands for a commit whose install failed. No
 * target ran, so the commit is failed in every mode.
 *
 * @category constants
 * @since 0.1.0
 */
export const installLabel = "(install)"

/**
 * What an install made of a checkout: its own `smthrs`, or why there is none.
 *
 * @category models
 * @since 0.1.0
 */
export type Installed =
  | { readonly ok: true; readonly smthrs: string }
  | { readonly ok: false; readonly reason: string }

/**
 * Why an install command failed. Its output is left out: it may hold a
 * registry credential.
 *
 * @throws {never}
 * @category constructors
 * @since 0.1.0
 */
export const commandFailed = (command: ReadonlyArray<string>, directory: string, exitCode: number): string =>
  `${command.join(" ")} exited ${exitCode} in ${directory === "" ? "the repository root" : directory}`

/**
 * Why a checkout has no `smthrs` after its installs.
 *
 * @throws {never}
 * @category constructors
 * @since 0.1.0
 */
export const noSmthrs = (directories: ReadonlyArray<string>): string =>
  `no ${smthrsBin} in ${
    directories.map((directory) => (directory === "" ? "the repository root" : directory)).join(" or ")
  } after the install; the repository must depend on @smthrs/cli`
