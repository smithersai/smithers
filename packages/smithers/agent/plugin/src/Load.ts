/**
 * The loader: decodes, checks, orders and folds plugin manifests into one
 * {@link Contributions} value, with a typed refusal for every plugin that
 * cannot load.
 *
 * `load` never fails. A bad plugin is refused and the rest load; refusals are
 * deterministic and ordered by plugin id. It runs no plugin code: manifests are
 * data, and every flow fact comes from the host.
 *
 * @since 1.1.0
 */

import { Pack } from "@smthrs/registry"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as EffectPath from "effect/Path"
import * as Result from "effect/Result"
import * as Bind from "./Bind.ts"
import {
  type Active,
  type Command,
  type Contributions,
  type Event,
  type Keybinding,
  type Point,
  type Reason,
  Refusal,
  type Slot,
  type Tier,
  type View
} from "./Contribution.ts"
import * as Patterns from "./internal/patterns.ts"
import * as JsonSchema from "./JsonSchema.ts"
import * as Keys from "./Keys.ts"
import * as Manifest from "./Manifest.ts"
import * as When from "./When.ts"

/**
 * What the host's catalog knows about one flow, by tag.
 *
 * @category models
 * @since 1.1.0
 */
export interface FlowFacts {
  readonly capabilities: ReadonlyArray<string>
  /** The least role that may run it. */
  readonly minimum: Manifest.Minimum
  /** Its registry entry has a `userOnlyReason`: only the person runs it. */
  readonly personOnly: boolean
  /** A core flow: never owned or replaced by a plugin. */
  readonly system: boolean
  /** Its payload as a closed JSON Schema, when known; args keys are checked against it. */
  readonly payload?: JsonSchema.Resolved
}

/**
 * A flow a candidate owns, as the host resolved it.
 *
 * @category models
 * @since 1.1.0
 */
export interface OwnedFlow extends FlowFacts {
  readonly tag: string
  readonly modelInvocable: boolean
}

/**
 * What the host implements and knows.
 *
 * @category models
 * @since 1.1.0
 */
export interface HostFacts {
  /** The host's plugin API, `Manifest.PLUGIN_API`. */
  readonly api: string
  /** The points the host implements; any other non-empty point refuses `unsupported_point`. */
  readonly points: ReadonlyArray<Point>
  /** Every flow already in the app's one catalog, plugin-owned flows excluded. */
  readonly catalog: ReadonlyMap<string, FlowFacts>
  /** Core queries' row schemas, such as `core/waits`. */
  readonly queries: ReadonlyMap<string, JsonSchema.Resolved>
  /** Which capabilities each tier may declare. */
  readonly tierCap: Readonly<Record<Tier, (capability: string) => boolean>>
  /** Slash names the host's own commands hold; a plugin command naming one refuses `conflict`. */
  readonly slash?: ReadonlyArray<string>
}

/**
 * One plugin to load: its tier, its undecoded manifest, and the flows it owns.
 *
 * @category models
 * @since 1.1.0
 */
export interface Candidate {
  readonly tier: Tier
  readonly manifest: unknown
  readonly flows?: ReadonlyArray<OwnedFlow>
}

/**
 * What loading produced.
 *
 * @category models
 * @since 1.1.0
 */
export interface Loaded {
  readonly contributions: Contributions
  readonly refused: ReadonlyArray<Refusal>
}

/**
 * The most `shell.header` entries across every plugin.
 *
 * @category limits
 * @since 1.1.0
 */
export const maximumHeaderEntries = 6

const digits = [0, 1, 2, 3, 4, 5, 6, 7, 8]
const folded: ReadonlySet<Point> = new Set(["views", "slots", "commands", "keybindings"])
const otherPoints = ["cards", "settings", "triggers", "hooks", "taps", "modelRoles", "records"] as const
const ranks: Readonly<Record<Manifest.Minimum, number>> = { anyone: 0, guest: 1, member: 2, maintainer: 3, admin: 4 }

const fail = (reason: Reason, path: string, detail: string): Effect.Effect<never, Refusal> =>
  Effect.fail(new Refusal({ reason, path, detail }))

const refusal = (plugin: string, reason: Reason, path: string, detail: string): Refusal =>
  new Refusal({ plugin, reason, path, detail })

const withPlugin = (refused: Refusal, plugin: string | undefined): Refusal =>
  plugin === undefined ? refused : new Refusal({ ...refused, plugin })

/** The manifest's id when it is one, read without running an accessor. */
const readableId = (input: unknown): string | undefined => {
  try {
    const id = typeof input === "object" && input !== null
      ? Object.getOwnPropertyDescriptor(input, "id")?.value
      : undefined
    return typeof id === "string" && Patterns.pluginId.test(id) ? id : undefined
  } catch {
    // A proxy that throws has no id we may read; the refusal names none.
    return undefined
  }
}

/** `range_unreadable`, `incompatible`, or nothing when `version` satisfies `range`. */
const compatible = (
  path: EffectPath.Path,
  range: string,
  version: string
): Effect.Effect<"range_unreadable" | "incompatible" | undefined> =>
  Pack.checkCompatible(
    {
      manifest: new Pack.Manifest({ name: "plugin", version, flows: [], requires: { smithers: range } }),
      dir: "/",
      origin: "installed"
    },
    path,
    version
  ).pipe(
    Effect.match({
      onFailure: (error) =>
        error.code === "unreadable_pack_range" ? "range_unreadable" as const : "incompatible" as const,
      onSuccess: () => undefined
    })
  )

const incompatibility = (verdict: "range_unreadable" | "incompatible", what: string): string =>
  verdict === "range_unreadable" ? `the ${what} range is unreadable` : `the ${what} version is outside the range`

interface Decoded {
  readonly candidate: Candidate
  readonly manifest: Manifest.Manifest
}

/** Dependency order, ties by id, and the plugins left over: in a cycle, or behind one. */
const order = (plugins: ReadonlyArray<Decoded>) => {
  const byId = new Map(plugins.map((plugin) => [plugin.manifest.id, plugin]))
  const deps = (plugin: Decoded) => Object.keys(plugin.manifest.requires.plugins ?? {}).filter((id) => byId.has(id))
  const waiting = new Map(plugins.map((plugin) => [plugin.manifest.id, new Set(deps(plugin))]))
  const sorted: Array<Decoded> = []
  for (;;) {
    const ready = [...waiting].filter(([, pending]) => pending.size === 0).map(([id]) => id).sort()
    const next = ready[0]
    if (next === undefined) break
    waiting.delete(next)
    for (const pending of waiting.values()) pending.delete(next)
    sorted.push(byId.get(next)!)
  }
  const reaches = (from: string, target: string, seen: Set<string>): boolean =>
    [...waiting.get(from)!].some((dep) =>
      dep === target || (!seen.has(dep) && (seen.add(dep), reaches(dep, target, seen)))
    )
  const left = [...waiting.keys()].sort().map((id) => ({ plugin: byId.get(id)!, cyclic: reaches(id, id, new Set()) }))
  return { sorted, left }
}

interface State {
  readonly slash: Set<string>
  readonly owned: Map<string, FlowFacts>
  readonly versions: Map<string, string>
  header: number
  readonly plugins: Array<Active>
  readonly views: Array<View>
  readonly slots: Array<Slot>
  readonly entries: Array<Command>
  readonly keybindings: Array<Keybinding>
}

const rendered = (render: Manifest.Render, tier: Tier, path: string): Effect.Effect<void, Refusal> =>
  render.kind === "component" && tier !== "built-in"
    ? fail("unsupported_point", path, "a component renders only for a built-in plugin")
    : Effect.void

const header = (slots: ReadonlyArray<Slot>): number => slots.filter((entry) => entry.slot === "shell.header").length

/** Checks one decoded plugin against the host and the plugins already active, and folds it in. */
const admit = (host: HostFacts, plugin: Decoded, state: State): Effect.Effect<void, Refusal> =>
  Effect.gen(function*() {
    const { candidate, manifest } = plugin
    const id = manifest.id
    const tier = candidate.tier
    const contributes = manifest.contributes ?? {}
    const advertised = new Set(host.points)
    const uses = manifest.uses ?? []
    const defs = manifest.$defs ?? {}

    if (Manifest.RESERVED.includes(id)) return yield* fail("reserved", "id", "the id is reserved for the core")

    for (const point of [...folded, ...otherPoints]) {
      const entries = (contributes as Readonly<Record<string, ReadonlyArray<unknown> | undefined>>)[point]
      if (entries !== undefined && entries.length > 0 && !(advertised.has(point) && folded.has(point))) {
        return yield* fail("unsupported_point", `contributes.${point}`, `the host does not implement ${point}`)
      }
    }
    const ownedFlows = candidate.flows ?? []
    const owning = (manifest.flows?.length ?? 0) + (manifest.owns?.length ?? 0) + ownedFlows.length > 0
    if (owning && !advertised.has("flows")) {
      return yield* fail("unsupported_point", "flows", "the host does not load plugin flows")
    }

    const own = new Map<string, FlowFacts>()
    for (const flow of ownedFlows) {
      if (Manifest.RESERVED.includes(flow.tag.split("/")[0]!)) {
        return yield* fail("reserved", "flows", `${flow.tag} is in a reserved namespace`)
      }
      const existing = host.catalog.get(flow.tag)
      if (existing?.system === true) {
        return yield* fail("conflict", "flows", `${flow.tag} is a system flow, never owned by a plugin`)
      }
      if (existing !== undefined || state.owned.has(flow.tag) || own.has(flow.tag)) {
        return yield* fail("conflict", "flows", `${flow.tag} already has an owner`)
      }
      own.set(flow.tag, flow)
    }
    const known = (tag: string): FlowFacts | undefined => own.get(tag) ?? state.owned.get(tag) ?? host.catalog.get(tag)

    for (const [index, tag] of uses.entries()) {
      if (known(tag) === undefined) return yield* fail("undeclared_use", `uses[${index}]`, `${tag} is not a known flow`)
    }
    for (const [index, capability] of manifest.capabilities.entries()) {
      if (!host.tierCap[tier](capability)) {
        return yield* fail(
          "capability_exceeded",
          `capabilities[${index}]`,
          `the ${tier} tier may not declare this capability`
        )
      }
    }
    const borrowed = uses.map((tag, index) => ({ tag, facts: known(tag)!, path: `uses[${index}]` }))
    for (
      const { facts, path, tag } of [
        ...ownedFlows.map((flow) => ({ tag: flow.tag, facts: flow, path: "flows" })),
        ...borrowed
      ]
    ) {
      if (!facts.capabilities.every((capability) => manifest.capabilities.includes(capability))) {
        return yield* fail("capability_exceeded", path, `${tag} needs a capability outside the plugin's ceiling`)
      }
    }

    const personOnlyOwned = ownedFlows.filter((flow) => !flow.modelInvocable).map((flow) => flow.tag).sort()
    if (Object.keys(manifest.userOnly ?? {}).sort().join("\n") !== personOnlyOwned.join("\n")) {
      return yield* fail("invalid", "userOnly", "userOnly names exactly the owned flows that are not model-invocable")
    }

    for (const [name, schema] of Object.entries(defs)) yield* JsonSchema.resolve(schema, defs, `$defs.${name}`)

    const taken = new Set<string>()
    const claim = (contribution: string, path: string): Effect.Effect<void, Refusal> => {
      if (!contribution.startsWith(`${id}/`)) {
        return Manifest.RESERVED.includes(contribution.split("/")[0]!)
          ? fail("reserved", path, "the namespace is reserved for the core")
          : fail("invalid", path, `a contribution id starts with ${id}/`)
      }
      // Every id starts with this plugin's unique id, so only this plugin can hold it already.
      if (taken.has(contribution)) return fail("conflict", path, `${contribution} is taken`)
      taken.add(contribution)
      return Effect.void
    }
    const flowOf = (tag: string, path: string): Effect.Effect<FlowFacts, Refusal> =>
      own.has(tag) || uses.includes(tag)
        ? Effect.succeed(known(tag)!)
        : fail("undeclared_use", path, `${tag} is neither owned nor in uses`)
    const atLeast = (minimum: Manifest.Minimum, facts: FlowFacts, path: string, tag: string) =>
      ranks[minimum] < ranks[facts.minimum]
        ? fail("minimum_below_flow", path, `${tag} needs ${facts.minimum}`)
        : Effect.void
    const rows = (
      reads: ReadonlyArray<string> | undefined,
      path: string
    ): Effect.Effect<ReadonlyArray<JsonSchema.Resolved>, Refusal> => {
      const schemas: Array<JsonSchema.Resolved> = []
      for (const [index, query] of (reads ?? []).entries()) {
        const schema = host.queries.get(query)
        if (schema !== undefined) schemas.push(schema)
        else if (!query.startsWith(`${id}/`)) {
          return fail("invalid", `${path}.reads[${index}]`, `${query} is not a query this plugin may read`)
        }
      }
      return Effect.succeed(schemas)
    }

    const views: Array<View> = []
    for (const [index, view] of (contributes.views ?? []).entries()) {
      const at = `contributes.views[${index}]`
      yield* claim(view.id, `${at}.id`)
      yield* rendered(view.render, tier, `${at}.render`)
      const rowSchemas = yield* rows(view.reads, at)
      const events: Array<Event> = []
      for (const [position, event] of (view.events ?? []).entries()) {
        const where = `${at}.events[${position}]`
        if (events.some((declared) => declared.name === event.name)) {
          return yield* fail("conflict", `${where}.name`, "the event is declared twice")
        }
        if ("local" in event) {
          events.push({ name: event.name, local: true })
          continue
        }
        const payload = event.payload === undefined
          ? undefined
          : yield* JsonSchema.resolve(event.payload, defs, `${where}.payload`)
        const payloads = payload === undefined ? [] : [payload]
        const facts = yield* flowOf(event.flow, `${where}.flow`)
        yield* atLeast(view.minimum, facts, `${at}.minimum`, event.flow)
        for (const reference of yield* Effect.fromResult(Bind.references(event.args, `${where}.args`))) {
          const path = `${where}.args.${reference.at}`
          // Any index reaches `items`; `[$event.x]` is checked as a payload field below.
          const steps = reference.path.map((segment) => typeof segment === "object" ? 0 : segment)
          const reaches = (schemas: ReadonlyArray<JsonSchema.Resolved>) =>
            steps.length > 0 && schemas.some((schema) => JsonSchema.at(schema, steps) !== undefined)
          const named = reference.root === "key"
            ? steps.join(".") === "index"
            : reaches(reference.root === "item" ? rowSchemas : payloads)
          if (!named) return yield* fail("invalid", path, "the reference reaches no field of the reads or the payload")
          for (const segment of reference.path) {
            if (typeof segment === "object" && !payloads.some((schema) => JsonSchema.at(schema, [segment.event]))) {
              return yield* fail("invalid", path, "the index names no field of the event's payload")
            }
          }
        }
        if (facts.payload !== undefined) {
          for (const [key, value] of Object.entries(event.args)) {
            const target = JsonSchema.property(facts.payload, key)
            if (target === undefined) {
              return yield* fail("invalid", `${where}.args.${key}`, `${event.flow} takes no such field`)
            }
            // The whole args already parsed, so one arg's references cannot fail.
            const literal = Result.getOrThrow(Bind.references({ [key]: value })).length === 0
            if (literal && Option.isSome(JsonSchema.validate(target, value))) {
              return yield* fail("invalid", `${where}.args.${key}`, `the value fails ${event.flow}'s payload`)
            }
          }
          for (const key of facts.payload.required ?? []) {
            if (!Object.hasOwn(event.args, key)) {
              return yield* fail("invalid", `${where}.args`, `${event.flow} requires a field the args leave unfilled`)
            }
          }
        }
        events.push({
          name: event.name,
          flow: event.flow,
          args: event.args,
          personOnly: facts.personOnly,
          ...(payload === undefined ? {} : { payload })
        })
      }
      views.push({ ...view, events, plugin: id, tier })
    }

    const slots: Array<Slot> = []
    for (const [index, slot] of (contributes.slots ?? []).entries()) {
      const at = `contributes.slots[${index}]`
      yield* claim(slot.id, `${at}.id`)
      yield* rendered(slot.render, tier, `${at}.render`)
      yield* rows(slot.reads, at)
      if (slot.when !== undefined && Result.isFailure(When.parse(slot.when))) {
        return yield* fail("invalid", `${at}.when`, "the condition is outside the when grammar")
      }
      if (slot.slot === "shell.header" && state.header + header(slots) >= maximumHeaderEntries) {
        return yield* fail("conflict", `${at}.slot`, `the header holds at most ${maximumHeaderEntries} entries`)
      }
      slots.push({ ...slot, plugin: id, tier })
    }

    const commands: Array<Command> = []
    const slash = new Set<string>()
    for (const [index, command] of (contributes.commands ?? []).entries()) {
      const at = `contributes.commands[${index}]`
      yield* claim(command.id, `${at}.id`)
      const facts = yield* flowOf(command.flow, `${at}.flow`)
      // A command runs from the person's own key or slash line, with args the manifest fixed: only code compiled into
      // the build may point one at a person-only flow, or a plugin could dress a person-only act as something else.
      if (facts.personOnly && tier !== "built-in") {
        return yield* fail("invalid", `${at}.flow`, `${command.flow} is person-only: only a built-in's command runs it`)
      }
      yield* atLeast(command.minimum, facts, `${at}.minimum`, command.flow)
      const args = command.args ?? {}
      if ((yield* Effect.fromResult(Bind.references(args, `${at}.args`))).length > 0) {
        return yield* fail("invalid", `${at}.args`, "a command's args are fixed")
      }
      const failure = facts.payload === undefined ? Option.none() : JsonSchema.validate(facts.payload, args)
      if (Option.isSome(failure)) {
        return yield* fail("invalid", `${at}.args`, `the args fail ${command.flow}'s payload at ${failure.value}`)
      }
      if (command.slash !== undefined) {
        if (slash.has(command.slash.name) || state.slash.has(command.slash.name)) {
          return yield* fail("conflict", `${at}.slash.name`, "the slash command is taken")
        }
        slash.add(command.slash.name)
      }
      commands.push({ ...command, plugin: id, tier })
    }

    const keybindings: Array<Keybinding> = []
    for (const [index, binding] of (contributes.keybindings ?? []).entries()) {
      const at = `contributes.keybindings[${index}]`
      const keys = Keys.parse(binding.key)
      if (Result.isFailure(keys)) return yield* fail("invalid", `${at}.key`, keys.failure)
      const when = When.parse(binding.when ?? "")
      if (Result.isFailure(when)) return yield* fail("invalid", `${at}.when`, when.failure)
      const base = { plugin: id, tier, key: binding.key, keys: keys.success, when: when.success }
      if ("command" in binding) {
        // A plugin keys only its own commands: binding another plugin's would run a flow outside its own `uses`.
        if (!commands.some((command) => command.id === binding.command)) {
          return yield* fail("invalid", `${at}.command`, `${binding.command} is not one of this plugin's commands`)
        }
        keybindings.push({ ...base, command: binding.command })
        continue
      }
      const viewId = When.view(when.success)
      if (viewId === undefined) return yield* fail("invalid", `${at}.when`, "an event key names its view with view ==")
      const view = views.find((declared) => declared.id === viewId)
      if (view === undefined) {
        return yield* fail("invalid", `${at}.when`, `${viewId} is not a view this plugin declares`)
      }
      const event = view.events.find((declared) => declared.name === binding.event)
      if (event === undefined) return yield* fail("invalid", `${at}.event`, `${viewId} declares no such event`)
      const fields = binding.fields ?? {}
      const targets = new Map<string, JsonSchema.Resolved>()
      for (const key of Object.keys(fields)) {
        const target = "flow" in event && event.payload !== undefined
          ? JsonSchema.property(event.payload, key)
          : undefined
        if (target === undefined) {
          return yield* fail("invalid", `${at}.fields.${key}`, "the event's payload has no such field")
        }
        targets.set(key, target)
      }
      const references = yield* Effect.fromResult(Bind.references(fields, `${at}.fields`))
      for (const reference of references) {
        if (reference.root !== "key" || reference.path.join(".") !== "index") {
          return yield* fail("invalid", `${at}.fields.${reference.at}`, "a key fills fields only from $key.index")
        }
        if (
          !keys.success.strokes.some((stroke) => stroke.key === "digit")
        ) {
          return yield* fail("invalid", `${at}.fields.${reference.at}`, "$key.index needs a digit key")
        }
      }
      // Every digit the key can fill, `$key.index` 0 to 8, must fit; a literal is checked once.
      for (const index of references.length > 0 ? digits : [0]) {
        const filled = Result.getOrThrow(Bind.bind(fields, { item: undefined, event: undefined, key: { index } }))
        for (const [key, target] of targets) {
          if (Option.isSome(JsonSchema.validate(target, filled[key]))) {
            return yield* fail("invalid", `${at}.fields.${key}`, "the field fails the event's payload")
          }
        }
      }
      keybindings.push({
        ...base,
        view: viewId,
        event: binding.event,
        fields,
        personOnly: "flow" in event && event.personOnly
      })
    }

    for (const name of slash) state.slash.add(name)
    for (const [tag, facts] of own) state.owned.set(tag, facts)
    state.versions.set(id, manifest.version)
    state.header += header(slots)
    state.plugins.push({
      id,
      version: manifest.version,
      title: manifest.title,
      tier,
      capabilities: manifest.capabilities,
      uses,
      owns: ownedFlows.map((flow) => flow.tag)
    })
    state.views.push(...views)
    state.slots.push(...slots)
    state.entries.push(...commands)
    state.keybindings.push(...keybindings)
  })

const orderOf = (slot: Slot): number => slot.order ?? 0

const bySlot = (left: Slot, right: Slot): number =>
  left.slot !== right.slot
    ? left.slot < right.slot ? -1 : 1
    : orderOf(left) !== orderOf(right)
    ? orderOf(left) - orderOf(right)
    : left.id < right.id
    ? -1
    : 1

/**
 * Loads a set of candidates: decode each, check `requires.api`, refuse
 * duplicate ids, order by `requires.plugins` (ties by id), then check and fold
 * each plugin against the host and the plugins before it.
 *
 * @category loading
 * @since 1.1.0
 */
export const load = (host: HostFacts, candidates: ReadonlyArray<Candidate>): Effect.Effect<Loaded> =>
  Effect.gen(function*() {
    const path = yield* EffectPath.Path
    const refused: Array<Refusal> = []
    const decoded: Array<Decoded> = []
    for (const candidate of candidates) {
      const result = yield* Effect.result(Manifest.decode(candidate.manifest))
      if (Result.isFailure(result)) {
        refused.push(withPlugin(result.failure, readableId(candidate.manifest)))
        continue
      }
      const manifest = result.success
      const verdict = yield* compatible(path, manifest.requires.api, host.api)
      if (verdict !== undefined) {
        refused.push(refusal(manifest.id, verdict, "requires.api", incompatibility(verdict, "plugin API")))
        continue
      }
      decoded.push({ candidate, manifest })
    }

    const counts = new Map<string, number>()
    for (const { manifest } of decoded) counts.set(manifest.id, (counts.get(manifest.id) ?? 0) + 1)
    for (const { manifest } of decoded) {
      if (counts.get(manifest.id)! > 1) refused.push(refusal(manifest.id, "conflict", "id", "two plugins share the id"))
    }

    const { left, sorted } = order(decoded.filter(({ manifest }) => counts.get(manifest.id) === 1))
    for (const { cyclic, plugin } of left) {
      refused.push(
        cyclic
          ? refusal(plugin.manifest.id, "cycle", "requires.plugins", "the plugin's dependencies form a cycle")
          : refusal(plugin.manifest.id, "missing_dependency", "requires.plugins", "a dependency is in a cycle")
      )
    }

    const state: State = {
      slash: new Set(host.slash),
      owned: new Map(),
      versions: new Map(),
      header: 0,
      plugins: [],
      views: [],
      slots: [],
      entries: [],
      keybindings: []
    }
    for (const plugin of sorted) {
      const { id } = plugin.manifest
      const missing = Object.entries(plugin.manifest.requires.plugins ?? {}).find(([dep]) => !state.versions.has(dep))
      if (missing !== undefined) {
        refused.push(refusal(id, "missing_dependency", `requires.plugins.${missing[0]}`, `${missing[0]} is not active`))
        continue
      }
      let unmet: Refusal | undefined
      for (const [dep, range] of Object.entries(plugin.manifest.requires.plugins ?? {})) {
        const verdict = yield* compatible(path, range, state.versions.get(dep)!)
        if (verdict !== undefined) {
          unmet = refusal(id, verdict, `requires.plugins.${dep}`, incompatibility(verdict, dep))
          break
        }
      }
      if (unmet !== undefined) {
        refused.push(unmet)
        continue
      }
      const admitted = yield* Effect.result(admit(host, plugin, state))
      if (Result.isFailure(admitted)) refused.push(withPlugin(admitted.failure, id))
    }

    const contributions: Contributions = {
      plugins: state.plugins,
      views: state.views,
      slots: [...state.slots].sort(bySlot),
      commands: state.entries,
      keybindings: state.keybindings
    }
    const ordered = refused
      .map((entry, index) => ({ entry, index }))
      .sort((left, right) => {
        const a = left.entry.plugin ?? ""
        const b = right.entry.plugin ?? ""
        return a < b ? -1 : a > b ? 1 : left.index - right.index
      })
      .map(({ entry }) => entry)
    return { contributions, refused: ordered }
  }).pipe(Effect.provide(EffectPath.layer))
