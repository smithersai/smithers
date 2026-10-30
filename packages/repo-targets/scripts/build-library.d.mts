/** Copies every `.d.ts` under `source` to the same relative path under `destination`. */
export declare const copyInputDeclarations: (source: string, destination: string) => void
/** Copies declarations to `dist/cjs` and writes its CommonJS boundary with rebased package imports. */
export declare const copyCommonJsDeclarations: (packageRoot: string) => void
/** Whether a source tree holds a `.vibe` module, outside `node_modules` and `dist`. */
export declare const hasVibeSources: (directory: string) => boolean
/** A package whose `src` holds VibeLang sources, by manifest name and real path. */
export interface VibeSourcePackage {
  readonly name: string
  readonly root: string
}
/** The package and the linked packages it depends on, transitively, whose `src` holds `.vibe` modules. */
export declare const vibeSourcePackages: (packageRoot: string) => Array<VibeSourcePackage>
/** The compiler a package builds with: `vibelang` when VibeLang sources are in reach, else `tsc`. */
export interface PackageCompiler {
  readonly name: "tsc" | "vibelang"
  /** The compiler's Node entry point, resolved from the package. */
  readonly path: string
  /** The VibeLang source packages that selected `vibelang`; empty for `tsc`. */
  readonly sources: ReadonlyArray<VibeSourcePackage>
}
export declare const packageCompiler: (packageRoot: string) => PackageCompiler
/** Runs the package compiler over `tsconfig.json`; throws when it fails or times out. */
export declare const compilePackage: (
  packageRoot: string,
  options?: { readonly timeoutMs?: number }
) => PackageCompiler
/** Builds `dist/esm` with the package compiler and `dist/cjs` with esbuild, from the package's own toolchain. */
export declare const buildLibrary: (
  packageRoot: string,
  options?: { readonly esmOnly?: ReadonlyArray<string>; readonly declarationTimeoutMs?: number }
) => Promise<void>
