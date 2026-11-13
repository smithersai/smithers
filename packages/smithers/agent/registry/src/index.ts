/**
 * Flow discovery and the catalog a model is shown: portable descriptors
 * scanned off a filesystem, disclosed to an agent in a compact form, and
 * resolved back to a runnable body on demand.
 *
 * Discovery is metadata-only. Scanning a source reads and hashes each entry
 * file whole, up to `Discovery.entrySizeLimit`, then parses at most its first
 * 64 KiB for markdown frontmatter or module metadata.
 *
 * For module entries, discovery also scans the complete source and walks its
 * import closure, bounded to 512 modules and 16 MiB per entry. It reads ancestor
 * `package.json`, `tsconfig.json` and `jsconfig.json` files to resolve project
 * aliases, and compiles `.mdx` helpers with `@mdx-js/mdx`. It never evaluates a
 * discovered flow module.
 * TypeScript and VibeLang sources containing `import(...)` are also parsed with
 * `@babel/parser` to identify erased import types.
 * No prompt body reaches the result. A body is
 * loaded when a flow is actually invoked, and its bytes are checked against the
 * content address discovery recorded.
 *
 * Governing contract: `packages/smithers/agent/registry/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/registry.
 *
 * @since 0.1.0
 */

/**
 * @category errors
 * @since 0.1.0
 */
export * as RegistryError from "./RegistryError.ts"

/**
 * @category models
 * @since 0.1.0
 */
export * as Descriptor from "./Descriptor.ts"

/**
 * @category services
 * @since 0.1.0
 */
export * as Discovery from "./Discovery.ts"

/**
 * @category markdown
 * @since 0.1.0
 */
export * as MarkdownFlow from "./MarkdownFlow.ts"

/**
 * @category modules
 * @since 1.0.0-rc.16
 */
export * as ModuleFlow from "./ModuleFlow.ts"

/**
 * @category markdown
 * @since 1.0.0-rc.1
 */
export * as Prompt from "./Prompt.ts"

/**
 * @category conversions
 * @since 0.1.0
 */
export * as Disclosure from "./Disclosure.ts"

/**
 * @category constructors
 * @since 0.1.0
 */
export * as Executable from "./Executable.ts"

/**
 * @category models
 * @since 0.1.0
 */
export * as Pack from "./Pack.ts"

/**
 * @category services
 * @since 0.1.0
 */
export * as Registry from "./Registry.ts"

/** @category services @since 1.0.0-rc.1 */
export * as ExecutionSnapshot from "./ExecutionSnapshot.ts"

/** Run-time decisions for loads no scan can read. @category services @since 1.0.0 */
export * as LoadGuard from "./LoadGuard.ts"

/** Bundled host declarations without filesystem discovery. @since 1.0.0 */
export * as Bundled from "./Bundled.vibe"
