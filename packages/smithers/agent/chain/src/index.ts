/**
 * @since 0.1.0
 *
 * `@smthrs/chain` — the Agent Chain spine.
 *
 * An append-only journal of typed events, keyed replayable calls, and the
 * trampoline that runs model-authored flow scripts. The journal is the only
 * state; everything else is a pure fold. Governing design:
 * https://chain.smithers.sh/contract/.
 */

/**
 * The author seat — the one thing the chain needs from a model.
 *
 * @category namespace exports
 * @since 0.1.0
 * @slop
 */
export * as Author from "./Author.ts"

/**
 * The author entry's declaration: the name, description, digest, and
 * capability claim both the trampoline and the prompt read.
 *
 * @category namespace exports
 * @since 0.1.0
 * @slop
 */
export * as AuthorDeclaration from "./AuthorDeclaration.ts"

/**
 * Gate 4's seam: per-call authorization against the capabilities an entry
 * declares.
 *
 * @category namespace exports
 * @since 0.1.0
 * @slop
 */
export * as Authorize from "./Authorize.ts"

/**
 * The durable identity of one settled call within a link.
 *
 * @category namespace exports
 * @since 0.1.0
 * @slop
 */
export * as CallKey from "./CallKey.ts"

/**
 * The catalog of entries a script may call.
 *
 * @category namespace exports
 * @since 0.1.0
 * @slop
 */
export * as Catalog from "./Catalog.ts"

/**
 * The chain trampoline: bootstrap, links, gates, and prefix replay.
 *
 * @category namespace exports
 * @since 0.1.0
 * @slop
 */
export * as Chain from "./Chain.ts"

/**
 * The journal event vocabulary and the pure folds over it.
 *
 * @category namespace exports
 * @since 0.1.0
 * @slop
 */
export * as Event from "./Event.ts"

/**
 * The memory door: remember and recall as catalog entries.
 *
 * @category namespace exports
 * @since 0.1.0
 * @slop
 */
export * as MemoryEntries from "./MemoryEntries.ts"

/**
 * The model-backed author seat over `Model.Model`.
 *
 * @category namespace exports
 * @since 0.1.0
 * @slop
 */
export * as ModelAuthor from "./ModelAuthor.ts"

/**
 * The append-only journal port and its in-memory layer.
 *
 * @category namespace exports
 * @since 0.1.0
 * @slop
 */
export * as Journal from "./Journal.ts"

/**
 * The gate both runner bindings answer to: the strict JSON boundary, its
 * limits, the outcome decode, and the messages both bindings refuse with.
 *
 * @category namespace exports
 * @since 0.1.0
 * @slop
 */
export * as JsonBoundary from "./JsonBoundary.ts"

/**
 * Typed, journaled gate observations.
 *
 * @category namespace exports
 * @since 0.1.0
 * @slop
 */
export * as Observation from "./Observation.ts"

/**
 * The trampoline outcomes a link can end with.
 *
 * @category namespace exports
 * @since 0.1.0
 * @slop
 */
export * as Outcome from "./Outcome.ts"

/**
 * The stable author-call prefix, assembled as a pure value.
 *
 * @category namespace exports
 * @since 0.1.0
 * @slop
 */
export * as Prompt from "./Prompt.ts"

/**
 * The QuickJS-WASM script runner — the production sealed interpreter.
 *
 * @category namespace exports
 * @since 0.1.0
 * @slop
 */
export * as QuickJsRunner from "./QuickJsRunner.ts"

/**
 * The registry-backed catalog projection.
 *
 * @category namespace exports
 * @since 0.1.0
 * @slop
 */
export * as RegistryCatalog from "./RegistryCatalog.ts"

/**
 * The authored artifact of one link and the shape gate over raw output.
 *
 * @category namespace exports
 * @since 0.1.0
 * @slop
 */
export * as Script from "./Script.ts"

/**
 * The script interpreter port and its in-process implementation.
 *
 * @category namespace exports
 * @since 0.1.0
 * @slop
 */
export * as ScriptRunner from "./ScriptRunner.ts"

/**
 * The steering port: outside messages drained at link boundaries.
 *
 * @category namespace exports
 * @since 0.1.0
 * @slop
 */
export * as Steering from "./Steering.ts"

/**
 * Sub-agents as an ordinary recursive catalog entry.
 *
 * @category namespace exports
 * @since 0.1.0
 * @slop
 */
export * as SubChains from "./SubChains.ts"
