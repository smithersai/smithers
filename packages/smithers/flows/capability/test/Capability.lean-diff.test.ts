/**
 * Capability matching, policy evaluation and the capability-set lattice against their Lean 4 reference specification
 * (`spec/lean/capability`), generated: every case is answered by the implementation and by the specification's
 * compiled oracle, and the two answers must be equal, to the order for a list. Resources are compared as UTF-16 code
 * units, never decoded.
 *
 * The oracle is one process for the whole file. It reads one JSON request per line and writes one JSON response per
 * line. A resource crosses as its UTF-16 code units, so a lone surrogate arrives as it left; an action crosses as its
 * name.
 *
 * A machine with neither the built oracle nor `lake` skips the file; a machine with `lake` builds the oracle first,
 * and builds it again when a source of the specification is newer than it.
 */
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Option, Schema } from "effect"
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { createInterface } from "node:readline"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Capability, CapabilitySet, Permission } from "../src/index.ts"

// --- the oracle -----------------------------------------------------------------------------------------------------

const specDir = join(import.meta.dirname, "..", "spec", "lean", "capability")
const binary = join(specDir, ".lake", "build", "bin", "capability-spec")
const elan = join(homedir(), ".elan", "bin")
const lake = [...(process.env["PATH"] ?? "").split(delimiter).filter((directory) => directory !== ""), elan]
  .map((directory) => join(directory, "lake"))
  .find((path) => existsSync(path))
/** The specification's sources are here and `lake` can build them. A confined run may be shown neither. */
const buildable = lake !== undefined && existsSync(join(specDir, "lakefile.toml"))
const oracleReady = existsSync(binary) || buildable
const differential = it.skipIf(!oracleReady)

/** True when a source of the specification is newer than the built oracle, or there is no built oracle. */
const stale = (): boolean => {
  if (!existsSync(binary)) return true
  const built = statSync(binary).mtimeMs
  const sources = [
    "Main.lean",
    "CapabilitySpec.lean",
    "lakefile.toml",
    "lean-toolchain",
    ...readdirSync(join(specDir, "CapabilitySpec")).map((name) => join("CapabilitySpec", name))
  ]
  return sources.some((source) => statSync(join(specDir, source)).mtimeMs > built)
}

interface Oracle {
  readonly ask: (op: string, request: Readonly<Record<string, unknown>>) => Promise<unknown>
  readonly asked: () => number
  readonly close: () => void
}

const start = (): Oracle => {
  const child: ChildProcessWithoutNullStreams = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] })
  const waiting: Array<{ readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }> = []
  let asked = 0
  createInterface({ input: child.stdout }).on("line", (line) => {
    const next = waiting.shift()
    const response = JSON.parse(line) as { readonly ok?: unknown; readonly error?: string }
    if (response.error === undefined) next?.resolve(response.ok)
    else next?.reject(new Error(`the oracle refused: ${response.error}`))
  })
  child.on("close", () => {
    for (const each of waiting.splice(0)) each.reject(new Error("the oracle exited before it answered"))
  })
  return {
    ask: (op, request) =>
      new Promise((resolve, reject) => {
        asked++
        waiting.push({ resolve, reject })
        child.stdin.write(`${JSON.stringify({ op, ...request })}\n`)
      }),
    asked: () => asked,
    close: () => child.stdin.end()
  }
}

let oracle: Oracle

beforeAll(() => {
  if (!oracleReady) return
  if (lake !== undefined && buildable && stale()) {
    const built = spawnSync(lake, ["build"], {
      cwd: specDir,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, PATH: `${elan}${delimiter}${process.env["PATH"] ?? ""}` }
    })
    if (built.status !== 0) throw new Error(`lake build failed in ${specDir}:\n${built.stdout}\n${built.stderr}`)
  }
  oracle = start()
}, 150_000)

afterAll(() => {
  if (oracleReady) oracle.close()
})

// --- the wire -------------------------------------------------------------------------------------------------------

/** A text as its UTF-16 code units. */
const units = (text: string): Array<number> => Array.from({ length: text.length }, (_, index) => text.charCodeAt(index))

interface Shape<Action extends string = string> {
  readonly action: Action
  readonly resource: string
}

interface RuleShape {
  readonly effect: Permission.RuleEffect
  readonly pattern: Shape<Capability.PatternAction>
}

type CapabilityShape = Shape<Capability.Action>
type PatternShape = Shape<Capability.PatternAction>
type GroupsShape = ReadonlyArray<ReadonlyArray<PatternShape>>

/** A capability or a pattern as the oracle reads and writes it. */
const wire = (shape: Shape) => ({ action: shape.action, resource: units(shape.resource) })
const wireRule = (rule: RuleShape) => ({ effect: rule.effect, pattern: wire(rule.pattern) })
const wireGroups = (groups: GroupsShape) => groups.map((group) => group.map(wire))
const wireOption = (option: Option.Option<Shape>) => Option.isSome(option) ? wire(option.value) : null

/** A structural value that skipped its schema, as an unchecked host boundary would hand one over. */
const unchecked = <A>(value: unknown): A => value as A

const capabilityOf = (shape: CapabilityShape) => Capability.make(shape.action, shape.resource)
const patternOf = (shape: PatternShape) => new Capability.CapabilityPattern(shape)
const ruleOf = (rule: RuleShape) => new Permission.Rule({ effect: rule.effect, pattern: patternOf(rule.pattern) })
const setOf = (groups: GroupsShape) => CapabilitySet.fromGroups(groups.map((group) => group.map(patternOf)))

// --- generators -----------------------------------------------------------------------------------------------------

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "100"))
const executions = Math.max(25, Math.min(baseExecutions, 150))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const int = (minimum: number, maximum: number): Arbitrary.Arbitrary<number> =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })))

/** One of `values`; a failing case shrinks toward the first. */
const pick = <A>(values: ReadonlyArray<A>): Arbitrary.Arbitrary<A> =>
  Arbitrary.map(int(0, values.length - 1), (index) => values[index]!)

const list = <A>(item: Arbitrary.Arbitrary<A>, maxLength: number): Arbitrary.Arbitrary<Array<A>> =>
  Arbitrary.array(item, { maxLength })

/**
 * Pieces a hostile resource is built from: both metacharacters, the recursive and the bare-command endings, every
 * segment the path rules read (`.`, `..`, empty, a drive, a home, a backslash), a colon, and half a surrogate pair.
 */
const fragments = [
  "a",
  "b",
  "/",
  "*",
  "?",
  ".",
  "..",
  "/",
  "src",
  "**",
  " *",
  " ",
  "/**",
  "\\",
  "~",
  "C:",
  ":",
  "é",
  "\ud83d",
  "\n",
  "npm",
  "/..",
  "../"
] as const

const resource: Arbitrary.Arbitrary<string> = Arbitrary.map(list(pick(fragments), 6), (parts) => parts.join(""))

/** A pattern resource: its own text, or the capability's resource with one edit that keeps the two related. */
const related = (base: string, own: string, mode: number, from: number, to: number): string => {
  const first = Math.min(from, to, base.length)
  const second = Math.min(Math.max(from, to), base.length)
  switch (mode) {
    case 0:
      return own
    case 1:
      return base
    case 2:
      return `${base.slice(0, first)}*${base.slice(second)}`
    case 3:
      return `${base.slice(0, first)}/**`
    case 4:
      return `${base.slice(0, first)}?${base.slice(first + 1)}`
    case 5:
      return `${base} *`
    case 6:
      return `${base.slice(0, first)} *`
    case 7:
      return "**"
    default:
      return `${base.slice(0, first)}${own}`
  }
}

const exactActions = Capability.Action.literals
const patternActions = Capability.PatternAction.literals

/** The exact actions the rules treat differently: both filesystem ones, a command, and private network access. */
const hotActions = ["fs:read", "fs:write", "proc:spawn", "net:private", "net:get", "jj:diff"] as const
/** The selectors that reach them, with one that reaches none. */
const hotSelectors = [
  "fs:read",
  "*",
  "fs:*",
  "net:*",
  "net:private",
  "proc:spawn",
  "fs:write",
  "net:get",
  "jj:*",
  "model:call"
] as const

const action: Arbitrary.Arbitrary<Capability.Action> = Arbitrary.map(
  Arbitrary.all([int(0, 5), pick(hotActions), pick(exactActions)]),
  ([choice, hot, free]) => (choice === 0 ? free : hot)
)

const selector: Arbitrary.Arbitrary<Capability.PatternAction> = Arbitrary.map(
  Arbitrary.all([int(0, 5), pick(hotSelectors), pick(patternActions)]),
  ([choice, hot, free]) => (choice === 0 ? free : hot)
)

interface Pair {
  readonly capability: CapabilityShape
  readonly pattern: PatternShape
}

/** A capability and a pattern that is often about the same resource. */
const pair: Arbitrary.Arbitrary<Pair> = Arbitrary.map(
  Arbitrary.all({ action, selector, base: resource, own: resource, mode: int(0, 8), from: int(0, 8), to: int(0, 8) }),
  ({ action, base, from, mode, own, selector, to }) => ({
    capability: { action, resource: base },
    pattern: { action: selector, resource: related(base, own, mode, from, to) }
  })
)

/** Two patterns that are often about the same resource. */
const patternPair: Arbitrary.Arbitrary<readonly [PatternShape, PatternShape]> = Arbitrary.map(
  Arbitrary.all({
    left: selector,
    right: selector,
    base: resource,
    own: resource,
    mode: int(0, 8),
    from: int(0, 8),
    to: int(0, 8),
    swap: int(0, 1)
  }),
  ({ base, from, left, mode, own, right, swap, to }) => {
    const one = { action: left, resource: base }
    const other = { action: right, resource: related(base, own, mode, from, to) }
    return swap === 0 ? [other, one] : [one, other]
  }
)

/** A few resources every generated set and ruleset is about, so groups and rules meet on the same capabilities. */
const sharedResources = [
  "src/a",
  "src/**",
  "**",
  "src/./a",
  "a/../b",
  "*",
  "npm *",
  "npm",
  "/w/../x",
  "src/*",
  "a/../*/..",
  "*/../a/../b"
] as const

const sharedResource: Arbitrary.Arbitrary<string> = Arbitrary.map(
  Arbitrary.all([int(0, 3), pick(sharedResources), resource]),
  ([choice, shared, free]) => (choice === 0 ? free : shared)
)

const pattern: Arbitrary.Arbitrary<PatternShape> = Arbitrary.all({ action: selector, resource: sharedResource })
const capability: Arbitrary.Arbitrary<CapabilityShape> = Arbitrary.all({ action, resource: sharedResource })
const groups: Arbitrary.Arbitrary<Array<Array<PatternShape>>> = list(list(pattern, 3), 3)
const rule: Arbitrary.Arbitrary<RuleShape> = Arbitrary.all({
  effect: pick(Permission.RuleEffect.literals),
  pattern
})

/** Fails the test with the shrunk counterexample unless the property holds for every generated value. */
const holds = async <A>(arbitrary: Arbitrary.Arbitrary<A>, property: (value: A) => Promise<void>): Promise<void> => {
  const report = await Effect.runPromise(
    Fuzz.run(arbitrary, (value) => Effect.promise(async () => (await property(value), true)), { seed, executions })
  )
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

// --- the differential cases -----------------------------------------------------------------------------------------

describe("actions", () => {
  differential("every selector selects exactly the actions the specification says", async () => {
    for (const selector of patternActions) {
      for (const action of exactActions) {
        expect(
          Capability.matches(patternOf({ action: selector, resource: "x" }), Capability.make(action, "x")),
          `${selector} selects ${action}`
        ).toBe(await oracle.ask("matchesAction", { pattern: selector, action }))
      }
    }
  })

  differential("every selector covers exactly the selectors the specification says", async () => {
    for (const left of patternActions) {
      for (const right of patternActions) {
        expect(
          Capability.subsumes(patternOf({ action: left, resource: "x" }), patternOf({ action: right, resource: "x" })),
          `${left} covers ${right}`
        ).toBe(await oracle.ask("actionSubsumes", { left, right }))
      }
    }
  })

  differential("patterns are ordered by the code units of their action names", async () => {
    expect(await oracle.ask("ranksAgree", {})).toBe(true)
    const sorted = [...patternActions].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    const group = patternActions.map((action) => ({ action, resource: "x" }))
    expect(setOf([group]).groups).toEqual([sorted.map((action) => patternOf({ action, resource: "x" }))])
    expect(await oracle.ask("fromGroups", { groups: wireGroups([group]) }))
      .toEqual([sorted.map((action) => wire({ action, resource: "x" }))])
  })
})

describe("the resource glob", () => {
  differential("the two-pointer matcher accepts exactly the specification's language", async () => {
    await holds(list(pair, 8), async (cases) => {
      for (const { capability, pattern } of cases) {
        // Outside the filesystem a resource has one form, so `matches` is the glob alone.
        const text = { action: "net:get", resource: capability.resource } as const
        expect(Capability.matches(patternOf({ action: "net:get", resource: pattern.resource }), capabilityOf(text)))
          .toBe(
            await oracle.ask("matchesResource", {
              pattern: units(pattern.resource),
              resource: units(capability.resource)
            })
          )
        expect(Capability.isLiteralResource(pattern.resource))
          .toBe(await oracle.ask("isLiteralResource", { resource: units(pattern.resource) }))
      }
    })
  })

  differential("a pair past the work budget matches nothing and is not decidable", async () => {
    const cases = [
      [Capability.maxResourceLength, Capability.maxResourceLength],
      [Capability.maxResourceLength + 1, Capability.maxResourceLength],
      [Capability.maxResourceLength, Capability.maxResourceLength + 1],
      [5000, 4000],
      [8192, 2048],
      [8192, 2049]
    ] as const
    for (const [patternLength, resourceLength] of cases) {
      // Unchecked structural values: the schema refuses a resource this long, the matcher must still fail closed.
      const pattern = unchecked<Capability.CapabilityPattern>({
        action: "net:get",
        resource: "a".repeat(patternLength)
      })
      const capability = unchecked<Capability.Capability>({ action: "net:get", resource: "a".repeat(resourceLength) })
      const request = { pattern: wire(pattern), capability: wire(capability) }
      const fits = patternLength * resourceLength <= Capability.maxMatchWork
      expect(Capability.withinMatchBudget(pattern, capability)).toBe(fits)
      expect(await oracle.ask("withinMatchBudget", request)).toBe(fits)
      expect(Capability.matches(pattern, capability)).toBe(await oracle.ask("matches", request))
      const rule = unchecked<Permission.Rule>({ effect: "allow", pattern })
      expect(Permission.evaluate([[rule]], capability)).toBe(
        await oracle.ask("evaluate", {
          rulesets: [[{ effect: "allow", pattern: wire(pattern) }]],
          capability: wire(capability)
        })
      )
      const other = unchecked<Capability.Capability>({ action: "fs:read", resource: "a".repeat(resourceLength) })
      expect(Capability.withinMatchBudget(pattern, other)).toBe(true)
      expect(await oracle.ask("withinMatchBudget", { pattern: wire(pattern), capability: wire(other) })).toBe(true)
    }
  })
})

describe("patterns", () => {
  differential("matches and withinMatchBudget agree with the specification, dot segments included", async () => {
    await holds(list(pair, 8), async (cases) => {
      for (const { capability, pattern } of cases) {
        const request = { pattern: wire(pattern), capability: wire(capability) }
        expect(Capability.matches(patternOf(pattern), capabilityOf(capability)))
          .toBe(await oracle.ask("matches", request))
        expect(Capability.withinMatchBudget(patternOf(pattern), capabilityOf(capability)))
          .toBe(await oracle.ask("withinMatchBudget", request))
      }
    })
  })

  differential("subsumes and mayOverlap agree with the specification", async () => {
    await holds(list(patternPair, 8), async (cases) => {
      for (const [left, right] of cases) {
        const request = { left: wire(left), right: wire(right) }
        expect(Capability.subsumes(patternOf(left), patternOf(right))).toBe(await oracle.ask("subsumes", request))
        expect(Capability.mayOverlap(patternOf(left), patternOf(right))).toBe(await oracle.ask("mayOverlap", request))
      }
    })
  })

  differential("patternFromCapability derives the pattern the specification derives, or refuses with it", async () => {
    await holds(list(capability, 8), async (cases) => {
      for (const each of cases) {
        expect(wireOption(Capability.patternFromCapability(capabilityOf(each))))
          .toEqual(await oracle.ask("patternFromCapability", { capability: wire(each) }))
      }
    })
  })

  differential("format, parse and parsePattern agree with the specification on any text", async () => {
    const texts = Arbitrary.all({
      pattern,
      head: pick(["", "*", "fs:read", "fs:*", "fs", "net:private", "jj:workspace-add", "nope:read", ":"] as const),
      joint: pick([":", "", "::", " "] as const),
      rest: resource
    })
    await holds(list(texts, 8), async (cases) => {
      for (const { head, joint, pattern, rest } of cases) {
        const formatted = Capability.format(pattern)
        expect(units(formatted)).toEqual(await oracle.ask("format", { pattern: wire(pattern) }))
        for (const input of [formatted, `${head}${joint}${rest}`, rest]) {
          expect(wireOption(Capability.parse(input))).toEqual(await oracle.ask("parse", { input: units(input) }))
          expect(wireOption(Capability.parsePattern(input)))
            .toEqual(await oracle.ask("parsePattern", { input: units(input) }))
        }
      }
    })
  })
})

describe("policy", () => {
  differential("evaluate reaches the specification's decision for every ruleset order", async () => {
    await holds(
      list(Arbitrary.all({ rulesets: list(list(rule, 4), 3), capability }), 6),
      async (cases) => {
        for (const { capability, rulesets } of cases) {
          expect(Permission.evaluate(rulesets.map((ruleset) => ruleset.map(ruleOf)), capabilityOf(capability)))
            .toBe(
              await oracle.ask("evaluate", {
                rulesets: rulesets.map((ruleset) => ruleset.map(wireRule)),
                capability: wire(capability)
              })
            )
        }
      }
    )
  })

  differential("a focused policy: private network access, both path readings, and the configured veto", async () => {
    const focused = Arbitrary.all({
      action: pick(["net:private", "fs:read"] as const),
      resource: pick(["a", "x/../a", "a/", "a/../*/..", "b", "~/./a", "C:/./a", "a/./\\", "/a/./a"] as const),
      rulesets: list(
        list(
          Arbitrary.all({
            effect: pick(Permission.RuleEffect.literals),
            pattern: Arbitrary.all({
              action: pick(["net:*", "*", "net:private", "fs:*", "fs:read", "net:get"] as const),
              resource: pick(["**", "a", "x/**", "a/*", "b"] as const)
            })
          }),
          3
        ),
        3
      )
    })
    await holds(list(focused, 8), async (cases) => {
      for (const { action, resource, rulesets } of cases) {
        const capability = { action, resource }
        expect(Permission.evaluate(rulesets.map((ruleset) => ruleset.map(ruleOf)), capabilityOf(capability)))
          .toBe(
            await oracle.ask("evaluate", {
              rulesets: rulesets.map((ruleset) => ruleset.map(wireRule)),
              capability: wire(capability)
            })
          )
      }
    })
  })
})

describe("capability sets", () => {
  differential("fromGroups, intersect, allows and within agree with the specification", async () => {
    await holds(list(Arbitrary.all({ left: groups, right: groups, capability }), 4), async (cases) => {
      for (const { capability, left, right } of cases) {
        const one = setOf(left)
        const other = setOf(right)
        const sides = { left: wireGroups(left), right: wireGroups(right) }
        expect(one.groups.map((group) => group.map(wire)))
          .toEqual(await oracle.ask("fromGroups", { groups: sides.left }))
        const met = CapabilitySet.intersect(one, other)
        expect(met.groups.map((group) => group.map(wire))).toEqual(await oracle.ask("intersect", sides))
        expect(CapabilitySet.allows(one, capabilityOf(capability)))
          .toBe(await oracle.ask("allows", { groups: sides.left, capability: wire(capability) }))
        expect(CapabilitySet.allows(met, capabilityOf(capability)))
          .toBe(
            CapabilitySet.allows(one, capabilityOf(capability)) && CapabilitySet.allows(other, capabilityOf(capability))
          )
        expect(CapabilitySet.within(one, other))
          .toBe(await oracle.ask("within", { inner: sides.left, outer: sides.right }))
        expect(CapabilitySet.within(met, one))
          .toBe(await oracle.ask("within", { inner: [...sides.left, ...sides.right], outer: sides.left }))
      }
    })
  })
})

describe("the oracle", () => {
  differential("refuses a request it does not know, and keeps answering", async () => {
    await expect(oracle.ask("nope", {})).rejects.toThrow("unknown op nope")
    await expect(oracle.ask("isLiteralResource", { resource: "not units" })).rejects.toThrow("the oracle refused")
    await expect(oracle.ask("matchesAction", { pattern: "fs:nope", action: "fs:read" }))
      .rejects.toThrow("unknown pattern action fs:nope")
    expect(await oracle.ask("isLiteralResource", { resource: units("a*") })).toBe(false)
  })

  differential("answered every differential case of this file", () => {
    expect(oracle.asked()).toBeGreaterThan(5_000)
  })
})
