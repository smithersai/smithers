/**
 * Public declarations for the CLI's single-instance Effect resolver.
 *
 * @since 0.1.0
 */

/**
 * Installs the remaining ESM identity/bootstrap resolvers and tsx's supported
 * ESM loader once. Explicit declaration imports register a namespaced
 * CommonJS bridge; ordinary CommonJS dependencies use Node resolution.
 * `deferTypeScript` lets a Node-native executable load its own modules first;
 * call again without it before running commands. Explicit declaration imports
 * also complete installation. Deferring never removes an installed loader.
 * Promotion retains the first resolver's ownership; legacy installations stay intact.
 *
 * @category loading
 * @since 0.1.0
 * @slop
 */
export declare const installEffectResolution: (
  packages?: Readonly<Record<string, string>>,
  options?: { readonly deferTypeScript?: boolean }
) => void

/**
 * The files changed since a revision, by absolute path, and the text of each
 * one the revision holds.
 *
 * @category loading
 * @since 1.0.0
 */
export interface DeclarationRevision {
  readonly changed: ReadonlySet<string>
  readonly texts: ReadonlyMap<string, string>
}

/**
 * Evaluates one declaration module through tsx with the CLI's resolver in
 * front of tsx's namespace loader, so the module and the CLI share one Effect
 * instance. With `revision`, every changed file is read as the revision held
 * it, and a changed file the revision holds no text for is refused.
 *
 * @category loading
 * @since 0.1.0
 * @slop
 */
export declare const importDeclarationModule: (
  url: string,
  parentURL: string,
  source?: string,
  revision?: DeclarationRevision
) => Promise<unknown>

/**
 * Marks one admitted declaration URL for ES-module evaluation.
 *
 * @category loading
 * @since 0.1.0
 * @slop
 */
export declare const buildModuleUrl: (url: string) => string
