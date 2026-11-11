/**
 * A Trellis whose generated work inherits one memory policy.
 *
 * `Trellis.make` runs the plans a model authors, one durable round per plan.
 * A plan's leaves are known only when its round runs, so the goals a leaf runs
 * cannot each be handed a namespace at declaration time. The policy is
 * attached to the flows instead: the author, the leaf, and the continuation
 * carry it, and so does every memory flow they declare, which is where the
 * memory bindings in `./Flows.ts` read it back from.
 *
 * An annotation takes no part in flow identity, so the graph a memory trellis
 * plans is the graph the plain trellis plans, node for node. See
 * https://memory.smithers.sh/reference/api/.
 *
 * @since 0.1.0
 */

import * as Trellis from "@smthrs/patterns/Trellis"
import type * as WithMemoryModule from "./WithMemory.vibe"
import { withMemory } from "./WithMemory.vibe"

/**
 * Configuration for {@link make}: everything `Trellis.make` accepts plus the
 * memory policy the authored plan runs under.
 *
 * `Trellis.make` takes its author and its leaf as `Member`, which states only
 * a name and a way to record a call. A policy is an annotation, so a memory
 * trellis asks for the wider thing a `@smthrs/core` signature is: the author
 * and the leaf here are declarations that carry an annotation bag and the
 * collaborator list the policy is inherited through.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions extends Omit<Trellis.MakeOptions, "author" | "leaf" | "continue"> {
  readonly author: WithMemoryModule.Declared & Trellis.MakeOptions<unknown>["author"]
  readonly leaf: WithMemoryModule.Declared & Trellis.MakeOptions<unknown>["leaf"]
  readonly continue?: (WithMemoryModule.Declared & Trellis.MakeOptions<unknown>["author"]) | undefined
  readonly memory: WithMemoryModule.Policy
}

/**
 * The author, leaf, and continuation flows a memory trellis calls, each
 * carrying the policy.
 *
 * Hold these when you compose the author and the leaf yourself, for example in
 * a hand-written round flow: the flows `make` composes are these, and calling
 * the originals instead loses the policy.
 *
 * @category introspection
 * @since 0.1.0
 */
export interface Parts {
  readonly author: WithMemoryModule.Declared & Trellis.MakeOptions<unknown>["author"]
  readonly leaf: WithMemoryModule.Declared & Trellis.MakeOptions<unknown>["leaf"]
  readonly continue?: (WithMemoryModule.Declared & Trellis.MakeOptions<unknown>["author"]) | undefined
}

/**
 * Applies the policy to the author, the leaf, and the continuation when there
 * is one, without composing them.
 *
 * @category constructors
 * @since 0.1.0
 */
export const parts = (options: MakeOptions): Parts => ({
  author: withMemory(options.author, options.memory),
  leaf: withMemory(options.leaf, options.memory),
  ...(options.continue === undefined ? {} : { continue: withMemory(options.continue, options.memory) })
})

/**
 * Declares a trellis whose author, leaves, and the memory flows those declare
 * all run under one memory policy.
 *
 * The answer is the `@smthrs/flow` flow `Trellis.make` states, carrying the
 * policy annotation. Its requirement channel is `unknown` because the author
 * and the leaf arrive as the existential {@link Flow.Any}, which states an
 * obligation it cannot name; {@link parts} holds both flows with their own
 * types.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MakeOptions): Trellis.TrellisFlow<unknown> =>
  withMemory(
    Trellis.make({
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.description === undefined ? {} : { description: options.description }),
      ...parts(options),
      envelope: options.envelope
    }),
    options.memory
  )
