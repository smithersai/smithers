import * as Cell from "@smthrs/harness/Cell"
import { Authorize, Catalog } from "@smthrs/chain"
import { Effect, Option } from "effect"
import type { CommandRegistry } from "../flows/Commands"
import type { FlowEntry } from "../flows/registry"

/*
 * The thin adapter that lets the chain runtime call registered flows.
 *
 * This is NOT a second catalog. It holds no capability table, no trigger
 * filter, and no description copy of its own: every one of those now lives on
 * the flow declaration, and this module only restates the registry's
 * model-invocable entries in the shape `@smthrs/chain` expects. The set it
 * exposes is `registry.callable()` verbatim, and every entry executes through
 * `registry.runForAgent` — the actor-attributed path with the user-only guard,
 * slash normalization, and the requirement axis.
 *
 * It exists only until the harness cell loop replaces ChainRuntime, at which
 * point the bindings are consumed directly and this file goes away.
 */

/** The one payload shape a chain entry accepts: optional argument text. */
const argsOf = (name: string, payload: unknown): Effect.Effect<string | undefined, Catalog.CallError> => {
  if (payload === undefined || payload === null) return Effect.succeed(undefined)
  if (typeof payload !== "object" || Array.isArray(payload)) {
    return Effect.fail(
      new Catalog.CallError({ name, message: `payload must be an object like { args?: string }` })
    )
  }
  const args = (payload as { readonly args?: unknown }).args
  if (args === undefined) return Effect.succeed(undefined)
  if (typeof args !== "string") {
    return Effect.fail(new Catalog.CallError({ name, message: `payload.args must be a string` }))
  }
  return Effect.succeed(args)
}

const entryFor = (commands: CommandRegistry, entry: FlowEntry, lineage?: string): Catalog.Entry => {
  const { name, description, capabilities } = entry.binding.descriptor
  return {
    name,
    description,
    capabilities,
    settleOnInterrupt: true,
    handler: (payload, slot) => Effect.gen(function*() {
      const service = yield* Effect.serviceOption(Authorize.Authorize)
      let refusal: Authorize.AuthorizeError | undefined
      return yield* argsOf(name, payload).pipe(
        Effect.flatMap((args) =>
          Effect.suspend(() => {
            let pending: ReturnType<CommandRegistry["runForAgent"]> | undefined
            return Effect.tryPromise({
              try: (signal) => pending = commands.runForAgent(name, args, Option.isNone(service) ? undefined : {
                lineage,
                authorize: service.value,
                slot: slot ?? { chain: "app", link: 0, ordinal: 0 },
                authorized: Cell.declarationDigest(entry.binding.descriptor),
                refused: (error) => { refusal = error }
              }, slot?.signal === undefined ? signal : AbortSignal.any([slot.signal, signal])),
              catch: (cause) => new Catalog.CallError({ name, message: `flow threw: ${String(cause)}` })
            }).pipe(Effect.onInterrupt(() => Effect.promise(async () => { await pending?.catch(() => {}) })))
          })
        ),
        Effect.flatMap((outcome) => {
          if (refusal !== undefined) {
            return Effect.fail(new Catalog.CallError({ name, message: refusal.message, cause: refusal.code }))
          }
          switch (outcome.status) {
            case "executed":
              return Effect.succeed<unknown>(outcome.value ?? `executed /${name}`)
            case "unknown-command":
              return Effect.fail(new Catalog.CallError({ name, message: `unknown-command: ${name}` }))
            case "unavailable":
              // A native-only flow on the web: the registry rendered the download card; the reason is the whole answer.
              return Effect.fail(new Catalog.CallError({ name, message: outcome.reason }))
            case "failed":
              return Effect.fail(new Catalog.CallError({ name, message: outcome.error }))
            case "form":
              // THE FORM LAW: nothing ran; the form is in the chat and the model points the human at it.
              return Effect.succeed<unknown>(`rendered a form for ${outcome.fields.join(", ")}: ask the user to fill it in`)
          }
        })
      )
    })
  }
}

/** Every flow the agent may call: the registry narrowed to model-invocable entries. */
export const commandEntries = (commands: CommandRegistry, lineage?: string): ReadonlyArray<Catalog.Entry> =>
  commands.callable().map((entry) => entryFor(commands, entry, lineage))

/**
 * The subset the prompt's catalog block teaches: callable flows that are not
 * hidden — byte-for-byte the set the list action shows.
 */
export const disclosedEntries = (commands: CommandRegistry): ReadonlyArray<Catalog.Entry> =>
  commands
    .callable()
    .filter((entry) => entry.metadata.hidden !== true)
    .map((entry) => entryFor(commands, entry))
