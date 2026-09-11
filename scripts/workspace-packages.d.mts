/** The workspace inventory shared by package declarations and release scripts. */
export interface WorkspacePackage {
  readonly dir: string
  readonly name: string
  readonly manifestPath: string
  readonly manifest: Readonly<Record<string, unknown>>
}

export const repoRoot: string
export const isMain: (meta: ImportMeta) => boolean
export const readWorkspacePatterns: (path?: string) => ReadonlyArray<string>
export const workspacePackages: (root?: string) => ReadonlyArray<WorkspacePackage>
export const libraryPackages: (root?: string) => ReadonlyArray<WorkspacePackage>
export const packageKey: (entry: Pick<WorkspacePackage, "dir">) => string
