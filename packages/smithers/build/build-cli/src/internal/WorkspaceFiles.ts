/**
 * The names a workspace declaration has.
 *
 * @since 1.0.0
 */

/**
 * The plain workspace declaration: a JavaScript module under `.smithers/`
 * with a name no type checker, linter or formatter reads as one of its own
 * files. It may export `Package`, the root package, so a workspace can keep
 * its whole declaration in `.smithers/`.
 *
 * @category discovery
 * @since 1.0.0
 */
export const plainWorkspaceFile = ".smithers/WORKSPACE.smithers"

/**
 * Where a workspace declaration may be, in the order discovery looks. The two
 * files under `.smithers/` never stand together: discovery refuses a root
 * that holds both.
 *
 * @category discovery
 * @since 1.0.0
 */
export const workspaceFiles: ReadonlyArray<string> = [".smithers/WORKSPACE.ts", plainWorkspaceFile, "WORKSPACE.ts"]

/** The base names a workspace declaration has. */
const names: ReadonlySet<string> = new Set(workspaceFiles.map((file) => file.slice(file.lastIndexOf("/") + 1)))

/**
 * The base names a workspace declaration has: `WORKSPACE.ts` and
 * `WORKSPACE.smithers`.
 *
 * @category discovery
 * @since 1.0.0
 */
export const workspaceFileNames: ReadonlyArray<string> = [...names]

/**
 * Checks whether a base name is one a workspace declaration has.
 *
 * @category discovery
 * @since 1.0.0
 */
export const isWorkspaceFileName = (name: string): boolean => names.has(name)
