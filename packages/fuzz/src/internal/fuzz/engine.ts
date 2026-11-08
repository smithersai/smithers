import type * as Arbitrary from "effect/Arbitrary"
import * as Arr from "effect/Array"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Formatter from "effect/Formatter"
import type * as Fuzz from "../../Fuzz.ts"
import * as Option from "effect/Option"
import * as Random from "effect/Random"
import * as Scheduler from "effect/Scheduler"
import * as Tracer from "effect/Tracer"
import * as Model from "../arbitrary/model.ts"
import * as Format from "./format.ts"
import * as Tape from "./tape.ts"

/** @internal */
export class FuzzError extends Data.TaggedError("FuzzError")<{
  readonly reason: Fuzz.FuzzError["reason"]
  readonly message: string
  readonly cause?: unknown
}> {}

const fuzzError = (reason: Fuzz.FuzzError["reason"], message: string, cause?: unknown): FuzzError =>
  new FuzzError({ reason, message, cause })

const describe = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)

/** @internal */
export const TargetTypeId = "~effect/Fuzz/Target"

/** @internal */
export interface TargetImpl<A, E, R> extends Fuzz.Target<A, E, R> {
  readonly anonymous: boolean
  readonly arbitrary: Arbitrary.Arbitrary<A>
  readonly property: (value: A) => boolean | Effect.Effect<boolean, E, R>
  readonly codec: Fuzz.Codec<A> | undefined
}

/** @internal */
export const makeTarget = <A, E, R>(
  arbitrary: Arbitrary.Arbitrary<A>,
  property: (value: A) => boolean | Effect.Effect<boolean, E, R>,
  options: Fuzz.TargetOptions<A> & { readonly anonymous?: boolean }
): Fuzz.Target<A, E, R> => {
  const target: TargetImpl<A, E, R> = {
    [TargetTypeId]: TargetTypeId,
    id: options.id,
    revision: options.revision,
    anonymous: options.anonymous === true,
    arbitrary,
    property,
    codec: options.codec
  } as TargetImpl<A, E, R>
  return target
}

// -----------------------------------------------------------------------------
// probes
// -----------------------------------------------------------------------------

interface Probe {
  readonly observe: (label: string) => void
  readonly score: (label: string, value: number) => void
}

const ProbeRef = Context.Reference<Probe | undefined>("effect/Fuzz/Probe", { defaultValue: () => undefined })

/** @internal */
export const observe = (label: string): Effect.Effect<void> =>
  Effect.withFiber((fiber) => {
    fiber.getRef(ProbeRef)?.observe(label)
    return Effect.void
  })

/** @internal */
export const score = (label: string, value: number): Effect.Effect<void> =>
  Effect.withFiber((fiber) => {
    fiber.getRef(ProbeRef)?.score(label, value)
    return Effect.void
  })

// -----------------------------------------------------------------------------
// feedback sources
// -----------------------------------------------------------------------------

/** @internal */
export const spans: Fuzz.Feedback = {
  name: "spans",
  measure: (self, sink) =>
    Effect.flatMap(Effect.tracer, (inner) =>
      Effect.withTracer(
        self,
        Tracer.make({
          span(options) {
            const parent = Option.getOrUndefined(options.parent)
            sink.feature(`${parent?._tag === "Span" ? parent.name : ""}>${options.name}`)
            return inner.span(options)
          },
          context: inner.context
        })
      ))
}

/** @internal */
export const live: Fuzz.Execution = {
  name: "live",
  run: (self) => Effect.map(self, (exit) => ({ _tag: "Completed", exit }))
}

// -----------------------------------------------------------------------------
// codecs
// -----------------------------------------------------------------------------

/** @internal */
export const jsonCodec = <A>(
  encode: (value: A) => unknown,
  decode: (json: unknown) => A
): Fuzz.Codec<A> => ({
  id: "json",
  encode: (value) => JSON.stringify(encode(value)),
  decode: (text) => decode(JSON.parse(text))
})

// -----------------------------------------------------------------------------
// options
// -----------------------------------------------------------------------------

interface Resolved {
  readonly seed: string | number | undefined
  readonly deadline: number
  readonly executions: number
  readonly plateau: number
  readonly size: number
  readonly maxShrinks: number
  readonly maxFindings: number
  readonly feedback: ReadonlyArray<Fuzz.Feedback>
  readonly execution: Fuzz.Execution
}

const resolve = (options: Fuzz.Options | undefined): Resolved => {
  const checks: ReadonlyArray<readonly [string, number | undefined, number]> = [
    ["executions", options?.executions, 0],
    ["plateau", options?.plateau, 1],
    ["size", options?.size, 0],
    ["maxShrinks", options?.maxShrinks, 0],
    ["maxFindings", options?.maxFindings, 1]
  ]
  for (const [label, value, minimum] of checks) {
    if (value !== undefined && !(Number.isSafeInteger(value) && value >= minimum)) {
      throw fuzzError("Configuration", `${label} must be a safe integer greater than or equal to ${minimum}`)
    }
  }
  const unbounded = options?.duration === undefined && options?.executions === undefined &&
    options?.plateau === undefined
  const duration = unbounded ? 10_000 : options?.duration === undefined
    ? Infinity
    : Duration.toMillis(Duration.fromInputUnsafe(options.duration))
  return {
    seed: options?.seed,
    deadline: Date.now() + duration,
    executions: options?.executions ?? Infinity,
    plateau: options?.plateau ?? Infinity,
    size: options?.size ?? 100,
    maxShrinks: options?.maxShrinks ?? 1000,
    maxFindings: options?.maxFindings ?? 1,
    feedback: options?.feedback ?? [spans],
    execution: options?.execution ?? live
  }
}

// -----------------------------------------------------------------------------
// generation
// -----------------------------------------------------------------------------

interface Generated<A> {
  readonly attempt: Model.Attempt<A>
  readonly words: ReadonlyArray<number>
}

/** @internal */
export const generate = <A>(
  generator: Model.Generator<A>,
  input: Format.Input,
  shrinks: boolean
): Effect.Effect<Generated<A>, FuzzError> => {
  const used: Tape.Used = { max: 0 }
  return Effect.suspend(() =>
    Model.toEffectGeneration(generator.generate({
      size: input.size,
      shrinks,
      biasFactor: input.bias,
      nullPrototype: input.nullPrototype,
      random: Tape.makeTapeRandom(input.words, input.key, used, 0),
      budget: { remaining: generator.minCost + input.size }
    }))
  ).pipe(
    Effect.map((attempt) => ({ attempt, words: Tape.materialize(input.words, input.key, used.max) })),
    Effect.catchDefect((defect) =>
      Effect.fail(fuzzError("Generation", `the generator died: ${describe(defect)}`, defect))
    )
  )
}

// -----------------------------------------------------------------------------
// evaluation
// -----------------------------------------------------------------------------

type Outcome<E> = Fuzz.Outcome<E>

const passed = { _tag: "Passed" } as const
const limited = { _tag: "Limited" } as const

const nameOf = (value: unknown): string => {
  if (typeof value !== "object" || value === null) return typeof value
  const tag = (value as { _tag?: unknown })._tag
  // An empty name would make a signature that no token or corpus entry accepts.
  return typeof tag === "string" && tag !== "" ? tag : value.constructor?.name || "Object"
}

/** @internal */
export const signatureOf = (outcome: Outcome<unknown>): string => {
  switch (outcome._tag) {
    case "PropertyError":
      return `PropertyError:${nameOf(outcome.error)}`
    case "Died":
      return `Died:${nameOf(outcome.defect)}`
    default:
      return outcome._tag
  }
}

const classify = <E>(exit: Exit.Exit<unknown, unknown>): Effect.Effect<Fuzz.Failure<E> | typeof passed> => {
  if (Exit.isSuccess(exit)) return Effect.succeed(exit.value === true ? passed : { _tag: "ReturnedFalse" })
  const reasons = exit.cause.reasons
  // Interruption belongs to whoever interrupted the property, so it leaves the fuzz run.
  if (reasons.some(Cause.isInterruptReason)) return Effect.failCause(exit.cause as Cause.Cause<never>)
  const died = reasons.find(Cause.isDieReason)
  return Effect.succeed(
    died === undefined
      ? { _tag: "PropertyError", error: (reasons[0] as Cause.Fail<E>).error }
      : { _tag: "Died", defect: died.defect }
  )
}

const bucket = (count: number): number =>
  count < 4 ? count : count < 8 ? 4 : count < 16 ? 5 : count < 32 ? 6 : count < 128 ? 7 : 8

interface Measured<E> {
  readonly outcome: Outcome<E>
  readonly schedule: ReadonlyArray<number>
  readonly hits: ReadonlyMap<number, number>
  readonly sources: ReadonlyMap<number, string>
  readonly scores: ReadonlyMap<string, number>
}

const evaluate = <A, E, R>(
  property: (value: A) => boolean | Effect.Effect<boolean, E, R>,
  value: A,
  input: Format.Input,
  options: Resolved,
  feedback: ReadonlyArray<Fuzz.Feedback>
): Effect.Effect<Measured<E>, FuzzError, R> => {
  const hits = new Map<number, number>()
  const sources = new Map<number, string>()
  const scores = new Map<string, number>()
  const add = (source: string, key: string | number) => {
    const id = Tape.hashString(`${source}\u0000${key}`, 0)
    hits.set(id, (hits.get(id) ?? 0) + 1)
    sources.set(id, source)
  }
  const probe: Probe = {
    observe: (label) => add("observations", label),
    score: (label, value) => scores.set(label, Math.max(scores.get(label) ?? -Infinity, value))
  }
  let scheduleRead = 0
  const scheduleTape: Fuzz.ScheduleTape = {
    next: () => {
      const position = scheduleRead++
      return position < input.schedule.length ? input.schedule[position] : Tape.filler(input.scheduleKey, position)
    }
  }
  const exit = Effect.exit(Effect.suspend(() => {
    const output = property(value)
    return Effect.isEffect(output) ? output : Effect.succeed(output)
  }))
  let driven: Effect.Effect<Fuzz.ExecutionResult, FuzzError, R> = Effect.suspend(() =>
    options.execution.run(Effect.provideService(exit, ProbeRef, probe), scheduleTape)
  ).pipe(
    Effect.catchDefect((defect) =>
      Effect.fail(fuzzError("Execution", `the ${options.execution.name} execution died: ${describe(defect)}`, defect))
    )
  )
  for (const source of feedback) {
    const inner = driven
    driven = Effect.suspend(() => source.measure(inner, { feature: (key) => add(source.name, key) })).pipe(
      Effect.catchDefect((defect) =>
        Effect.fail(fuzzError("Feedback", `the ${source.name} feedback died: ${describe(defect)}`, defect))
      )
    )
  }
  return Effect.flatMap(driven, (result) => {
    add("structural", `size:${bucket(input.size)}`)
    add("structural", `bias:${input.bias}`)
    add("structural", `null-prototype:${input.nullPrototype}`)
    add("structural", `tape:${bucket(Math.ceil(Math.log2(input.words.length + 1)))}`)
    add("structural", `schedule:${bucket(scheduleRead)}`)
    const schedule = Tape.materialize(input.schedule, input.scheduleKey, scheduleRead)
    const done = (outcome: Outcome<E>): Measured<E> => ({ outcome, schedule, hits, sources, scores })
    if (result._tag !== "Completed") return Effect.succeed(done(result._tag === "Deadlock" ? result : limited))
    const exit = result.exit
    add("causes", `exit:${exit._tag}`)
    if (Exit.isFailure(exit)) {
      for (const reason of exit.cause.reasons) {
        add(
          "causes",
          `${reason._tag}:${
            reason._tag === "Interrupt" ? "" : nameOf(Cause.isFailReason(reason) ? reason.error : reason.defect)
          }`
        )
      }
    }
    return Effect.map(classify<E>(exit), done)
  })
}

// -----------------------------------------------------------------------------
// shrinking
// -----------------------------------------------------------------------------

const pullNext = <A>(pull: Model.ShrinkPull<Model.Attempt<A>>): Effect.Effect<Model.Attempt<A> | undefined> =>
  Effect.catchCause(pull, Model.onTypedFailure(() => Effect.succeed(undefined)))

interface Shrunk<A, E> {
  readonly sample: Model.Sample<A>
  readonly failure: Fuzz.Failure<E>
  readonly schedule: ReadonlyArray<number>
  readonly path: ReadonlyArray<number>
  readonly shrinks: number
}

const shrink = Effect.fnUntraced(
  function*<A, E, R>(
    initial: Model.Sample<A>,
    failure: Fuzz.Failure<E>,
    input: Format.Input,
    property: (value: A) => boolean | Effect.Effect<boolean, E, R>,
    options: Resolved
  ): Effect.fn.Return<Shrunk<A, E>, FuzzError, R> {
    // The first-failing-child walk of `checkEffect`, accepting a candidate only when it keeps the failure signature.
    const signature = signatureOf(failure)
    let current = initial
    let best = failure
    let inspected = 0
    const path: Array<number> = []
    while (inspected < options.maxShrinks && current.shrinks !== undefined) {
      let index = 0
      let found: Model.Sample<A> | undefined
      while (inspected < options.maxShrinks) {
        const candidate = yield* pullNext(current.shrinks)
        if (candidate === undefined) break
        inspected++
        if (candidate._tag === "Discarded") continue
        const measured = yield* evaluate(property, candidate.value, input, options, [])
        if (signatureOf(measured.outcome) === signature) {
          found = candidate
          best = measured.outcome as Fuzz.Failure<E>
          path.push(index)
          break
        }
        index++
      }
      if (found === undefined) break
      current = found
    }
    // Then make the schedule more sequential: zero blocks of schedule words, largest first. Word 0 means "no preemption".
    let schedule = input.schedule
    let zeroed = 0
    for (let block = 2 ** Math.floor(Math.log2(schedule.length || 1)); block >= 1 && schedule.length > 0; block >>= 1) {
      for (let start = 0; start < schedule.length && inspected < options.maxShrinks; start += block) {
        if (schedule.slice(start, start + block).every((word) => word === 0)) continue
        const candidate = schedule.map((word, index) => index >= start && index < start + block ? 0 : word)
        inspected++
        const measured = yield* evaluate(property, current.value, { ...input, schedule: candidate }, options, [])
        if (signatureOf(measured.outcome) === signature) {
          schedule = measured.schedule
          best = measured.outcome as Fuzz.Failure<E>
          zeroed++
        }
      }
    }
    return { sample: current, failure: best, schedule, path, shrinks: path.length + zeroed }
  },
  (effect) =>
    Effect.catchDefect(
      effect,
      (defect) => Effect.fail(fuzzError("Generation", `a shrink candidate died: ${describe(defect)}`, defect))
    )
)

const follow = Effect.fnUntraced(
  function*<A>(initial: Model.Sample<A>, path: ReadonlyArray<number>) {
    let current = initial
    for (const target of path) {
      let index = 0
      let selected: Model.Sample<A> | undefined
      while (selected === undefined) {
        const candidate = current.shrinks === undefined ? undefined : yield* pullNext(current.shrinks)
        if (candidate === undefined) return undefined
        if (candidate._tag === "Discarded") continue
        if (index++ === target) selected = candidate
      }
      current = selected
    }
    return current
  },
  (effect) =>
    Effect.catchDefect(
      effect,
      (defect) => Effect.fail(fuzzError("Generation", `a shrink candidate died: ${describe(defect)}`, defect))
    )
)

/**
 * Calls a store method behind a defect boundary: a store that throws or dies is a `Corpus` error, like one that fails.
 */
const storeCall = <A>(what: string, call: () => Effect.Effect<A, FuzzError>): Effect.Effect<A, FuzzError> =>
  Effect.suspend(call).pipe(
    Effect.catchDefect((defect) =>
      Effect.fail(fuzzError("Corpus", `the corpus store died while ${what}: ${describe(defect)}`, defect))
    )
  )

/**
 * Evaluates the final input of a finding once more. A finding is reported as is only when the second evaluation fails
 * with the same signature; otherwise it is flaky and keeps both outcomes.
 */
const confirm = <A, E, R>(
  property: (value: A) => boolean | Effect.Effect<boolean, E, R>,
  value: A,
  input: Format.Input,
  options: Resolved,
  signature: string
): Effect.Effect<Outcome<E> | undefined, FuzzError, R> =>
  Effect.map(
    evaluate(property, value, input, options, []),
    (measured) => signatureOf(measured.outcome) === signature ? undefined : measured.outcome
  )

// -----------------------------------------------------------------------------
// the run
// -----------------------------------------------------------------------------

interface Entry {
  readonly input: Format.Input
  readonly length: number
}

/** @internal */
export const runTarget = Effect.fnUntraced(function*<A, E, R>(
  self: Fuzz.Target<A, E, R>,
  options?: Fuzz.Options
): Effect.fn.Return<Fuzz.Report<A, E>, FuzzError, R> {
  const target = self as TargetImpl<A, E, R>
  const resolved = yield* Effect.try({
    try: () => resolve(options),
    catch: (error) => error instanceof FuzzError ? error : fuzzError("Configuration", describe(error), error)
  })
  const generator = target.arbitrary.gen
  const property = target.property
  const codec = target.codec
  if (options?.replay !== undefined) return yield* replay(target, options.replay, resolved)

  const store = yield* Corpus
  if (store !== undefined && target.anonymous) {
    return yield* Effect.fail(fuzzError("Configuration", "a corpus store needs a target with an id and a revision"))
  }
  const seed = resolved.seed ?? (yield* Random.nextInt)
  const rng = Tape.makeRng(seed)
  const maxOpsBeforeYield = yield* Scheduler.MaxOpsBeforeYield

  // Only confirmed findings deduplicate a signature. A flaky candidate must not hide a later real failure.
  const findings = new Map<string, Fuzz.Finding<A, E>>()
  const flaky = new Map<string, Fuzz.FlakyFinding<A, E>>()
  const features: Record<string, number> = {}
  // Executions that produced each (feature, bucket) pair. An entry's energy is the rarity of the rarest pair it owns,
  // following AFL++'s "fast" power schedule, so the search keeps working on the frontier.
  const pairHits = new Map<number, number>()
  // Pairs from sources that measure progress through the program (spans, observations, injected providers). When there
  // are any, only they give energy: structural and cause pairs keep adding diverse entries, but a rarely seen size
  // bucket must not starve the entry at the frontier of the program.
  const guided = new Set<number>()
  const best = new Map<string, number>()
  const owners = new Map<number, number>()
  // The best entry for each score label. Champions get the highest energy, so a score is climbed, not just recorded.
  const champions = new Map<string, number>()
  const entries: Array<Entry> = []
  let executions = 0
  let discards = 0
  let regressions = 0
  let stale = 0
  let sinceProgress = 0

  const save = (kind: Fuzz.StoredEntry["kind"], key: string, text: string) =>
    store === undefined
      ? Effect.void
      : storeCall(`saving ${kind} ${key}`, () => store.save(target.id, { kind, key, text }))

  const replayToken = (input: Format.Input, path: ReadonlyArray<number>, signature: string) =>
    Format.encodeReplay({ input, path, signature })

  // Encode only confirmed failures with a store. An unencodable value still has its tape and replay token.
  const saveFailure = Effect.fnUntraced(function*(
    input: Format.Input,
    signature: string,
    path: ReadonlyArray<number>,
    value: A
  ): Effect.fn.Return<
    { readonly saved: Fuzz.Finding<A, E>["saved"]; readonly codecError?: string | undefined },
    FuzzError
  > {
    if (store === undefined) return { saved: "None" }
    let encoded: string | undefined
    let codecError: string | undefined
    if (codec !== undefined) {
      try {
        encoded = codec.encode(value)
      } catch (error) {
        codecError = `the ${codec.id} codec cannot encode a value: ${describe(error)}`
      }
    }
    const content = encoded === undefined
      ? `${target.revision}\u0000${replayToken(input, path, signature)}`
      : `${codec!.id}\u0000${encoded}`
    yield* save(
      "Failure",
      Tape.hashHex(`failure\u0000${signature}\u0000${content}`),
      Format.encodeEntry({
        kind: "failure",
        revision: target.revision,
        input,
        signature,
        path,
        codec: encoded === undefined ? undefined : codec!.id,
        value: encoded,
        note: `${signature}\n${encoded ?? Formatter.format(value)}`
      })
    )
    return { saved: encoded === undefined ? "Tape" : "Value", codecError }
  })

  // A new (feature, count bucket) pair or a better score makes an execution interesting.
  const admit = (input: Format.Input, measured: Measured<E>): boolean => {
    let interesting = false
    const pairs: Array<number> = []
    for (const [id, count] of measured.hits) {
      const pair = Tape.mix32(id ^ Math.imul(bucket(count) + 1, 0x9e3779b9))
      pairs.push(pair)
      const hits = pairHits.get(pair)
      pairHits.set(pair, (hits ?? 0) + 1)
      if (hits === undefined) {
        const source = measured.sources.get(id)!
        features[source] = (features[source] ?? 0) + 1
        if (source !== "structural" && source !== "causes") guided.add(pair)
        interesting = true
      }
    }
    const index = entries.length
    for (const [label, value] of measured.scores) {
      if ((best.get(label) ?? -Infinity) < value) {
        best.set(label, value)
        champions.set(label, index)
        interesting = true
      }
    }
    if (!interesting) return false
    const length = input.words.length + input.schedule.length
    entries.push({ input, length })
    for (const pair of pairs) {
      const owner = owners.get(pair)
      if (owner === undefined || entries[owner].length > length) owners.set(pair, index)
    }
    return true
  }

  const finding = (
    signature: string,
    failure: Fuzz.Failure<E>,
    input: A,
    initialInput: A,
    shrinks: number,
    execution: number,
    replay: string | undefined,
    recheck: Outcome<E> | undefined,
    persistence: { readonly saved: Fuzz.Finding<A, E>["saved"]; readonly codecError?: string | undefined }
  ) => {
    const found: Fuzz.Finding<A, E> = {
      signature,
      failure,
      input,
      initialInput,
      shrinks,
      execution,
      replay,
      ...persistence
    }
    if (recheck === undefined) {
      findings.set(signature, found)
      sinceProgress = 0
    } else if (!flaky.has(signature)) {
      flaky.set(signature, { ...found, recheck })
      sinceProgress = 0
    }
  }

  const onFailure = Effect.fnUntraced(function*(input: Format.Input, failure: Fuzz.Failure<E>) {
    const signature = signatureOf(failure)
    if (findings.has(signature)) return
    const regenerated = yield* generate(generator, input, true)
    if (regenerated.attempt._tag === "Discarded") {
      return yield* Effect.fail(fuzzError("Generation", "the generator is not deterministic: a failing tape discarded"))
    }
    const shrunk = yield* shrink(regenerated.attempt, failure, input, property, resolved)
    const final = { ...input, schedule: shrunk.schedule }
    const recheck = yield* confirm(property, shrunk.sample.value, final, resolved, signature)
    const persistence = recheck === undefined
      ? yield* saveFailure(final, signature, shrunk.path, shrunk.sample.value)
      : { saved: "None" as const }
    finding(
      signature,
      shrunk.failure,
      shrunk.sample.value,
      regenerated.attempt.value,
      shrunk.shrinks,
      executions,
      replayToken(final, shrunk.path, signature),
      recheck,
      persistence
    )
  })

  // 1. Saved failures run first. A value fixture outlives the generator; a tape only lives as long as its revision.
  const loaded: Array<Format.Entry> = []
  if (store !== undefined) {
    for (const stored of yield* storeCall("loading", () => store.load(target.id))) {
      loaded.push(
        yield* Effect.try({
          try: () => Format.decodeEntry(stored.text),
          catch: (error) => fuzzError("Corpus", `cannot read ${stored.kind} ${stored.key}: ${describe(error)}`, error)
        })
      )
    }
  }
  for (const entry of loaded) {
    if (entry.kind !== "failure") continue
    let value: A
    if (entry.codec !== undefined) {
      if (codec?.id !== entry.codec) {
        return yield* Effect.fail(
          fuzzError("Codec", `a saved failure uses the ${entry.codec} codec, but the target has ${codec?.id ?? "none"}`)
        )
      }
      value = yield* Effect.try({
        try: () => codec!.decode(entry.value!),
        catch: (error) =>
          fuzzError("Codec", `the ${entry.codec} codec cannot decode a saved value: ${describe(error)}`, error)
      })
    } else {
      const generated = entry.revision === target.revision
        ? yield* generate(generator, entry.input, true)
        : undefined
      const sample = generated?.attempt._tag === "Generated"
        ? yield* follow(generated.attempt, entry.path)
        : undefined
      if (sample === undefined) {
        stale++
        continue
      }
      value = sample.value
    }
    regressions++
    const measured = yield* evaluate(property, value, entry.input, resolved, [])
    if (measured.outcome._tag === "Passed" || measured.outcome._tag === "Limited") continue
    const signature = signatureOf(measured.outcome)
    finding(
      signature,
      measured.outcome,
      value,
      value,
      0,
      0,
      entry.revision === target.revision ? replayToken(entry.input, entry.path, signature) : undefined,
      yield* confirm(property, value, entry.input, resolved, signature),
      { saved: entry.codec === undefined ? "Tape" : "Value" }
    )
  }

  // 2. The search. Saved inputs with this revision rebuild the feature map first.
  const pending: Array<Format.Input> = []
  if (resolved.executions > 0) {
    for (const entry of loaded) {
      if (entry.kind !== "input") continue
      if (entry.revision === target.revision) pending.push(entry.input)
      else stale++
    }
  }

  const fresh = (): Format.Input => ({
    size: executions <= 32 ? Math.round((executions - 1) * resolved.size / 31) : rng.below(resolved.size + 1),
    bias: 2 + rng.below(5),
    nullPrototype: rng.below(8) === 0,
    key: rng.next(),
    words: [],
    scheduleKey: rng.next(),
    schedule: []
  })

  const mutate = (parent: Format.Input): Format.Input => {
    let { bias, key, nullPrototype, schedule, size, words } = parent
    let count = 1
    while (count < 8 && rng.below(2) === 0) count++
    for (; count > 0; count--) {
      const lane = schedule.length > 0 && rng.below(2) === 0
      const tape = Array.from(lane ? schedule : words)
      const at = rng.below(tape.length + 1)
      const length = 1 + rng.below(Math.min(16, tape.length + 1))
      const other = entries[rng.below(entries.length)].input
      switch (rng.below(tape.length === 0 ? 1 : 14)) {
        case 0:
          tape.splice(at, 0, ...Array.from({ length }, rng.next))
          break
        case 1:
          tape[at] = rng.next()
          break
        case 2:
          tape[at] = [0, 1, 0x7fffffff, 0x80000000, 0xffffffff][rng.below(5)]
          break
        case 3:
          tape[at] = (tape[at] + 1 + rng.below(16)) >>> 0
          break
        case 4:
          tape[at] = (tape[at] - 1 - rng.below(16)) >>> 0
          break
        case 5:
          tape[at] = (tape[at] ^ 1 << rng.below(32)) >>> 0
          break
        case 6:
          tape.fill(0, at, at + length)
          break
        case 7:
          tape.splice(at, length)
          break
        case 8:
          tape.splice(at, 0, ...tape.slice(at, at + length))
          break
        case 9:
          tape.splice(at, tape.length - at, ...(lane ? other.schedule : other.words).slice(at))
          break
        case 10:
          size = Math.min(
            resolved.size,
            Math.max(0, size + (rng.below(2) === 0 ? -1 : 1) * (1 + rng.below(1 + (size >> 1))))
          )
          break
        case 11:
          nullPrototype = !nullPrototype
          break
        case 12:
          bias = Math.min(6, Math.max(2, bias + (rng.below(2) === 0 ? -1 : 1)))
          break
        case 13:
          key = rng.next()
          break
      }
      tape.length = Math.min(tape.length, 4096)
      if (lane) schedule = tape
      else words = tape
    }
    return { size, bias, nullPrototype, key, words, scheduleKey: parent.scheduleKey, schedule }
  }

  const choose = (): Format.Input => {
    if (pending.length > 0) return pending.shift()!
    if (entries.length === 0 || executions <= 32 || rng.below(8) === 0) return fresh()
    if (rng.below(4) === 0) return mutate(entries[rng.below(entries.length)].input)
    const energy = new Map<number, number>()
    let total = 0
    for (const champion of champions.values()) {
      total += 1 - (energy.get(champion) ?? 0)
      energy.set(champion, 1)
    }
    const guiding = guided.size > 0
    for (const [pair, owner] of owners) {
      if (guiding && !guided.has(pair)) continue
      const rarity = 1 / pairHits.get(pair)!
      const previous = energy.get(owner) ?? 0
      if (rarity > previous) {
        energy.set(owner, rarity)
        total += rarity - previous
      }
    }
    let pick = rng.next() / 0x100000000 * total
    let chosen = 0
    for (const [owner, rarity] of energy) {
      chosen = owner
      pick -= rarity
      if (pick < 0) break
    }
    return mutate(entries[chosen].input)
  }

  let stoppedBy: Fuzz.Stats["stoppedBy"]
  while (true) {
    // Only confirmed findings stop the search; a flaky one is kept, and the search goes on.
    if (findings.size >= resolved.maxFindings) {
      stoppedBy = "Findings"
      break
    }
    if (executions >= resolved.executions) {
      stoppedBy = "Executions"
      break
    }
    if (sinceProgress >= resolved.plateau) {
      stoppedBy = "Plateau"
      break
    }
    if (Date.now() >= resolved.deadline) {
      stoppedBy = "Duration"
      break
    }
    executions++
    sinceProgress++
    if (executions % maxOpsBeforeYield === 0) yield* Effect.yieldNow
    const proposed = choose()
    const generated = yield* generate(generator, proposed, false)
    if (generated.attempt._tag === "Discarded") {
      discards++
      continue
    }
    const value = generated.attempt.value
    const input = { ...proposed, words: generated.words }
    const measured = yield* evaluate(property, value, input, resolved, resolved.feedback)
    const canonical = { ...input, schedule: measured.schedule }
    if (measured.outcome._tag === "Limited") {
      discards++
      continue
    }
    if (admit(canonical, measured)) {
      sinceProgress = 0
      const text = Format.encodeEntry({ kind: "input", revision: target.revision, input: canonical, path: [] })
      yield* save("Input", Tape.hashHex(text), text)
    }
    if (measured.outcome._tag !== "Passed") yield* onFailure(canonical, measured.outcome)
  }

  const stats: Fuzz.Stats = {
    seed,
    executions,
    discards,
    corpus: entries.length,
    features,
    regressions,
    stale,
    stoppedBy
  }
  return report([...findings.values(), ...flaky.values()], stats)
})

const report = <A, E>(
  all: ReadonlyArray<Fuzz.Finding<A, E> & { readonly recheck?: Outcome<E> | undefined }>,
  stats: Fuzz.Stats
): Fuzz.Report<A, E> => {
  const findings: Array<Fuzz.Finding<A, E>> = []
  const flaky: Array<Fuzz.FlakyFinding<A, E>> = []
  for (const found of all) {
    if (found.recheck === undefined) findings.push(found)
    else flaky.push(found as Fuzz.FlakyFinding<A, E>)
  }
  if (Arr.isArrayNonEmpty(findings)) return { _tag: "Falsified", findings, flaky, stats }
  if (Arr.isArrayNonEmpty(flaky)) return { _tag: "Flaky", flaky, stats }
  if (stats.executions > 0 && stats.discards === stats.executions) return { _tag: "Exhausted", stats }
  return { _tag: "Passed", stats }
}

const replay = Effect.fnUntraced(function*<A, E, R>(
  target: TargetImpl<A, E, R>,
  token: string,
  options: Resolved
): Effect.fn.Return<Fuzz.Report<A, E>, FuzzError, R> {
  const data = yield* Effect.try({
    try: () => Format.decodeReplay(token),
    catch: (error) => fuzzError("Configuration", `invalid replay token: ${describe(error)}`, error)
  })
  const stats: Fuzz.Stats = {
    seed: "replay",
    executions: 1,
    discards: 0,
    corpus: 0,
    features: {},
    regressions: 0,
    stale: 0,
    stoppedBy: "Replay"
  }
  const generated = yield* generate(target.arbitrary.gen, data.input, true)
  const sample = generated.attempt._tag === "Generated" ? yield* follow(generated.attempt, data.path) : undefined
  if (sample === undefined) return { _tag: "ReplayMismatch", stats: { ...stats, stale: 1 } }
  const measured = yield* evaluate(target.property, sample.value, data.input, options, [])
  // The token's signature names a failure (decodeReplay checks it), so an equal signature is a failure outcome.
  if (signatureOf(measured.outcome) !== data.signature) return { _tag: "Passed", stats }
  const finding: Fuzz.Finding<A, E> = {
    signature: data.signature,
    failure: measured.outcome as Fuzz.Failure<E>,
    input: sample.value,
    initialInput: (generated.attempt as Model.Sample<A>).value,
    shrinks: data.path.length,
    execution: 1,
    replay: token,
    saved: "None"
  }
  const recheck = yield* confirm(target.property, sample.value, data.input, options, data.signature)
  return report([recheck === undefined ? finding : { ...finding, recheck }], stats)
})

// -----------------------------------------------------------------------------
// corpus
// -----------------------------------------------------------------------------

/** @internal */
export const Corpus = Context.Reference<Fuzz.Store | undefined>("effect/Fuzz/Corpus", {
  defaultValue: () => undefined
})

/** @internal */
export const memoryCorpus = (): Fuzz.Store => {
  const targets = new Map<string, Map<string, Fuzz.StoredEntry>>()
  return {
    load: (target) => Effect.sync(() => Array.from(targets.get(target)?.values() ?? [])),
    save: (target, entry) =>
      Effect.sync(() => {
        let entries = targets.get(target)
        if (entries === undefined) targets.set(target, entries = new Map())
        entries.set(`${entry.kind}/${entry.key}`, entry)
      })
  }
}
