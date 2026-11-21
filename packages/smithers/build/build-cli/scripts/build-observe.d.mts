/**
 * Types for `build-observe.mjs`, consumed by the build-cli vitest suite.
 */

/** The zig release `smthrs-observe` is built with. */
export declare const zigVersion: string

/** Each platform the release ships, with zig's target for it. */
export declare const observeTargets: ReadonlyArray<readonly [string, string]>

/** zig's own archive of the pinned release by `${platform}-${arch}`: its name and published sha256. */
export declare const zigArchives: Readonly<Record<string, readonly [string, string]>>

/** Where a fetched zig is kept. */
export declare const zigCache: (env?: Readonly<Record<string, string | undefined>>) => string

/** Why `zig` cannot build smthrs-observe, or `undefined` when it is the pinned release. */
export declare const zigProblem: (zig?: string) => string | undefined

/** The zig that builds smthrs-observe, or why there is none. */
export declare const findZig: (options?: {
  readonly named?: string | undefined
  readonly onPath?: string
  readonly host?: string
  readonly cache?: string
  readonly downloads?: string
  readonly archives?: Readonly<Record<string, readonly [string, string]>>
}) => { readonly zig: string; readonly problem?: undefined } | { readonly problem: string; readonly zig?: undefined }

/** The file in `native/out` that says why nothing was built there. */
export declare const notBuilt: string

/** Builds both programs; the paths it wrote, or none where no zig can be had and the build is not required. */
export declare const buildObserve: (options?: {
  readonly root?: string
  readonly named?: string | undefined
  readonly required?: boolean
  readonly log?: (line: string) => void
  readonly find?: typeof findZig
}) => ReadonlyArray<string>
