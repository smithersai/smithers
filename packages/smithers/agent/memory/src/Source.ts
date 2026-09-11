/**
 * Advisory memory context source for an agent's opening context.
 *
 * Values returned by {@link declaredText} are accepted as
 * `Agent.Options.memory`. The source fetches primers and recall once per
 * `(lineageId, iteration)`, freezes successful snapshots for retries, fences
 * it, caps it, and degrades to no text after a two-second timeout or typed
 * failure.
 *
 * The fence is a delimiter, not a trust boundary. Rows are model-written, so
 * fence tokens, attribution prefixes, and line terminators inside a row are
 * rendered as visible `\uXXXX` escapes: one row is always one line, and only
 * this function writes a fence or a `[primer:bank]` / `[bank/key]` label.
 *
 * ## What "once per `(lineageId, iteration)`" actually promises
 *
 * Every source has an in-process memo. With no
 * {@link SnapshotRecorder.SnapshotRecorder} in the Effect context, that is the
 * whole guarantee: two reads through one source return the same text, while a
 * second source refetches live memory. This is the documented default for
 * compositions that use `@smthrs/memory` alone.
 *
 * When a recorder is present, the first fetch for an identity goes through its
 * boundary. A degraded fetch is not recorded and can be retried. A second
 * source, including one built by a resumed process, receives
 * that recorded text instead of refetching memory. The production adapter is
 * `@smthrs/agent/MemorySnapshotRecorder.layer`; it implements this package's
 * port through `@smthrs/harness` `EngineLike.record`. The dependency therefore
 * points from agent to memory and harness, while memory imports neither.
 *
 * The consequence is worth stating plainly, because it is the reason to record
 * this value rather than re-derive it. Memory text goes into an agent's OPENING
 * context, so a resumed run whose snapshot came back different has a different
 * frame-zero prefix. That re-keys every sealed model step under it, causing the
 * run to re-execute model calls it already paid for. Composing the agent adapter
 * closes that replay gap; omitting it deliberately keeps the process-local
 * fallback.
 *
 * @see https://smithers.sh/docs/reference/api/memory
 *
 * @since 0.1.0
 */
import type * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { resolveBanks } from "./internal/Bank.ts"
import { canonicalJson, digest, truncateBytes } from "./internal/Text.ts"
import type { MemoryError } from "./MemoryError.ts"
import * as MemoryStore from "./MemoryStore.ts"
import * as Recall from "./Recall.ts"
import * as SnapshotRecorder from "./SnapshotRecorder.ts"

/**
 * Source input and retry identity.
 *
 * `lineageId` and `iteration` alone select the frozen snapshot. Banks, query,
 * tag groups, primer banks, and both budgets are honored only by the first
 * read for that identity; later differences are warned and ignored.
 * `maxTokens` caps recalled rows in conservative UTF-8 bytes, while
 * `maxBytes` caps the complete fenced snapshot rendered here.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Input extends Recall.Input {
  readonly lineageId: string
  readonly iteration: number
  readonly primerBanks?: ReadonlyArray<string>
  readonly maxBytes?: number
}

/**
 * A memory source value consumed by the host that builds an agent's opening
 * context.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Source {
  readonly read: (input: Input) => Effect.Effect<string, never, MemoryStore.MemoryStore | Recall.Recall>
}

/**
 * Exact declared-text shape consumed by the memory segment an agent's opening
 * context builds (`packages/smithers/agent/src/Agent.ts`, `opening()`), passed in as
 * `Agent.Options.memory`.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface DeclaredText {
  readonly text: string
  readonly digest: string
}

const encoder = new TextEncoder()
const openingFence = "<flows_memory_context>"
const closingFence = "</flows_memory_context>"

// Memory rows are model-written, so every character that could open a fence,
// start an attribution label, or end the row is replaced with its visible
// `\uXXXX` escape before rendering. `\` is in the set, so an escape written
// here can never be confused with one the row already contained.
const textEscapes = /[\\<[\r\n\u0085\u2028\u2029]/g
const labelEscapes = /[\\<[\]:/\r\n\u0085\u2028\u2029]/g
const escapeUnit = (character: string): string => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
const escapeText = (text: string): string => text.replace(textEscapes, escapeUnit)
const escapeLabel = (label: string): string => label.replace(labelEscapes, escapeUnit)

const render = (
  primers: ReadonlyArray<{ readonly bank: string; readonly text: string }>,
  recalled: Recall.Output,
  maxBytes: number
): string => {
  const lines = [
    ...primers.map((primer) => `[primer:${escapeLabel(primer.bank)}] ${escapeText(primer.text)}`),
    ...recalled.map((result) => `[${escapeLabel(result.bank)}/${escapeLabel(result.key)}] ${escapeText(result.text)}`)
  ]
  if (lines.length === 0) return ""
  const shell = `${openingFence}\n\n${closingFence}`
  if (encoder.encode(shell).byteLength > maxBytes) return ""
  const available = maxBytes - encoder.encode(shell).byteLength
  const body = truncateBytes(lines.join("\n"), available)
  return `${openingFence}\n${body}\n${closingFence}`
}

interface BankRead {
  readonly bank: string
  readonly limit: number
  rowsRead: number | null
}

const fetch = (
  input: Input,
  bankReads: Array<BankRead>
): Effect.Effect<string, MemoryError | Cause.TimeoutError, MemoryStore.MemoryStore | Recall.Recall> =>
  Effect.gen(function*() {
    const store = yield* MemoryStore.MemoryStore
    const recall = yield* Recall.Recall
    const requestedBytes = input.maxBytes ?? 16 * 1024
    const maxBytes = Number.isFinite(requestedBytes) ? Math.max(0, Math.floor(requestedBytes)) : 16 * 1024
    const available = Math.max(0, maxBytes - encoder.encode(`${openingFence}\n\n${closingFence}`).byteLength)
    const primerBanks = input.primerBanks ?? input.banks
    const resolvedPrimerBanks = yield* resolveBanks(primerBanks)
    const primers = yield* Effect.all(
      resolvedPrimerBanks.map(({ bank, namespace }) => {
        // Even an empty note consumes its label and a separator. This window
        // contains enough candidates to fill the body, without reading a bank
        // in full. searchRows orders newest-first; facts use candidate slots
        // but are never rendered as primers.
        const minimumLineBytes = encoder.encode(`[primer:${escapeLabel(bank)}] `).byteLength + 1
        const progress: BankRead = {
          bank,
          limit: Math.max(1, Math.ceil((available + 1) / minimumLineBytes)),
          rowsRead: null
        }
        bankReads.push(progress)
        return store.searchRows({ namespace, status: "accepted", limit: progress.limit }).pipe(
          Effect.map((rows) => {
            progress.rowsRead = rows.length
            return rows.filter((row) => row.kind === "note").map((row) => ({ bank, text: row.text }))
          })
        )
      }),
      { concurrency: 4 }
    )
    const recalled = yield* recall.recall(input)
    return render(primers.flat(), recalled, maxBytes)
  }).pipe(Effect.timeout("2 seconds"))

/**
 * Constructs a memoizing memory source.
 *
 * The closure memo is always present. When
 * {@link SnapshotRecorder.SnapshotRecorder} is absent, it is the process-local
 * default. When a recorder is composed, the memoized fetch first asks that
 * recorder for the durable value of the same `(lineageId, iteration)`
 * identity.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (options: { readonly capacity?: number | undefined } = {}): Source => {
  const capacity = options.capacity ?? 1_024
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new TypeError("memory source capacity must be a positive safe integer")
  }
  const snapshots = new Map<string, {
    readonly effect: Effect.Effect<string, never, MemoryStore.MemoryStore | Recall.Recall>
    readonly fields: Readonly<Record<string, string>>
  }>()
  const fields = (input: Input): Readonly<Record<string, string>> => ({
    banks: canonicalJson(input.banks),
    query: canonicalJson(input.query),
    tagGroups: canonicalJson(input.tagGroups),
    maxTokens: canonicalJson(input.maxTokens),
    budget: canonicalJson(input.budget),
    primerBanks: canonicalJson(input.primerBanks),
    maxBytes: canonicalJson(input.maxBytes)
  })
  return {
    read: (input) => {
      const key = `${input.lineageId}\u0000${input.iteration}`
      const existing = snapshots.get(key)
      if (existing !== undefined) {
        snapshots.delete(key)
        snapshots.set(key, existing)
        const currentFields = fields(input)
        const changed = Object.keys(existing.fields).filter((field) => existing.fields[field] !== currentFields[field])
        return changed.length === 0
          ? existing.effect
          : Effect.logWarning(
            `memory source ignored changed fields for frozen snapshot ${key}: ${changed.join(", ")}`
          ).pipe(Effect.andThen(existing.effect))
      }
      const identity: SnapshotRecorder.Identity = {
        lineageId: input.lineageId,
        iteration: input.iteration
      }
      const current: Effect.Effect<string, never, MemoryStore.MemoryStore | Recall.Recall> = Effect.runSync(
        Effect.cached(
          Effect.gen(function*() {
            const started = yield* Clock.currentTimeMillis
            const bankReads: Array<BankRead> = []
            const recorder = yield* Effect.serviceOption(SnapshotRecorder.SnapshotRecorder)
            const attempt = Option.match(recorder, {
              onNone: () => fetch(input, bankReads),
              onSome: (recorder) =>
                Effect.gen(function*() {
                  // The recorder port accepts an infallible string effect. Send
                  // typed failures outside that boundary and cancel its pending
                  // read, so a degraded empty string is never a recorded success.
                  const failed = yield* Deferred.make<never, MemoryError | Cause.TimeoutError>()
                  return yield* Effect.raceFirst(
                    recorder.record(
                      identity,
                      fetch(input, bankReads).pipe(
                        Effect.catch((cause) => Deferred.fail(failed, cause).pipe(Effect.andThen(Effect.never)))
                      )
                    ),
                    Deferred.await(failed)
                  )
                })
            })
            return yield* attempt.pipe(
              Effect.catch((cause) =>
                Effect.gen(function*() {
                  const elapsedMs = (yield* Clock.currentTimeMillis) - started
                  if (Option.isSome(recorder) && snapshots.get(key)?.effect === current) snapshots.delete(key)
                  yield* Effect.logWarning(
                    `memory source degraded: ${String(cause)}; elapsedMs=${elapsedMs}; `
                      + `primerBanks=${(input.primerBanks ?? input.banks).length}; recallBanks=${input.banks.length}; `
                      + `bankReads=${JSON.stringify(bankReads)}`
                  )
                  return ""
                })
              )
            )
          })
        )
      )
      snapshots.set(key, { effect: current, fields: fields(input) })
      while (snapshots.size > capacity) snapshots.delete(snapshots.keys().next().value!)
      return current
    }
  }
}

/**
 * The default source value.
 *
 * @category instances
 * @since 0.1.0
 * @slop
 */
export const source = make()

/**
 * Converts a source snapshot into the exact {@link DeclaredText} shape
 * `Agent.Options.memory` accepts.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const declaredText = (
  memorySource: Source,
  input: Input
): Effect.Effect<DeclaredText, never, MemoryStore.MemoryStore | Recall.Recall> =>
  memorySource.read(input).pipe(Effect.map((text) => ({ text, digest: digest(text) })))
