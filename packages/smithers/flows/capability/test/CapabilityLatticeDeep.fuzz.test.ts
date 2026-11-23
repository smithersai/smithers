import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import { Arbitrary, Effect, Fiber, Schema } from "effect"
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { Capability, CapabilitySet, Permission } from "../src/index.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "100"))
const pureExecutions = Math.max(25, Math.min(baseExecutions, 150))
const ioExecutions = Math.max(15, Math.min(Math.ceil(baseExecutions / 3), 50))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const pattern = (action: Capability.PatternAction, resource: string) =>
  new Capability.CapabilityPattern({ action, resource })
const rule = (effect: Permission.RuleEffect, pattern: Capability.CapabilityPattern) =>
  new Permission.Rule({ effect, pattern })
const suffix = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9999 }))

// Each column is one independent witness for the union in a group. The
// shared file belongs to two columns, so intersecting by pattern identity
// instead of intersecting the accepted languages fails this oracle.
const patterns = [
  pattern("fs:*", "docs/**"),
  pattern("fs:read", "*.md"),
  pattern("net:get", "*.test:8443"),
  pattern("proc:spawn", "render *")
]
const witnesses = [
  [Capability.make("fs:read", "docs/index.md"), 3],
  [Capability.make("fs:write", "docs/index.md"), 1],
  [Capability.make("fs:read", "notes.md"), 2],
  [Capability.make("net:get", "api.test:8443"), 4],
  [Capability.make("proc:spawn", "render"), 8],
  [Capability.make("proc:spawn", "render page"), 8],
  [Capability.make("proc:spawn", "renderer"), 0]
] as const
const group = (mask: number) => patterns.filter((_, index) => (mask & (1 << index)) !== 0)
const mask = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 15 }))
const groups = Schema.Array(mask).check(Schema.isMaxLength(3))
const triple = Arbitrary.schema(Schema.Struct({ a: groups, b: groups, c: groups }))
const set = (masks: ReadonlyArray<number>) => CapabilitySet.fromGroups(masks.map(group))
const meet = CapabilitySet.intersect
const top = set([])
const bottom = CapabilitySet.none
const passed = <A, E>(report: Fuzz.Report<A, E>) => expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")

describe("capability intersection and resource identity", () => {
  it("obeys meet laws and accepts exactly the witnesses selected by every group", async () => {
    passed(
      await Effect.runPromise(Fuzz.run(triple, ({ a, b, c }) =>
        Effect.gen(function*() {
          const left = set(a)
          const right = set(b)
          const third = set(c)
          const pair = meet(left, right)
          const all = meet(pair, third)
          for (
            const [actual, expected] of [
              [meet(left, left), left],
              [meet(right, left), pair],
              [meet(left, meet(right, third)), all],
              [meet(left, bottom), bottom],
              [meet(bottom, left), bottom],
              [meet(left, top), left],
              [meet(top, left), left]
            ] as const
          ) expect(CapabilitySet.equals(actual, expected)).toBe(true)
          expect(CapabilitySet.within(pair, left)).toBe(true)
          expect(CapabilitySet.within(pair, right)).toBe(true)
          for (const [probe, membership] of witnesses) {
            const accepts = (masks: ReadonlyArray<number>) => masks.every((mask) => (mask & membership) !== 0)
            expect(CapabilitySet.allows(left, probe)).toBe(accepts(a))
            expect(CapabilitySet.allows(pair, probe)).toBe(accepts(a) && accepts(b))
            expect(CapabilitySet.allows(all, probe)).toBe(accepts(a) && accepts(b) && accepts(c))
          }
          return true
        }), { seed, executions: pureExecutions }))
    )
  })

  it("restores sibling and parent authority when nested fibers finish", async () => {
    passed(
      await Effect.runPromise(Fuzz.run(triple, ({ a, b, c }) =>
        Effect.gen(function*() {
          const branch = (inner: ReadonlyArray<number>) =>
            Effect.yieldNow.pipe(Effect.andThen(CapabilitySet.current), CapabilitySet.attenuateGroups(inner.map(group)))
          const parent = yield* Effect.gen(function*() {
            const first = yield* Effect.forkChild(branch(b))
            const second = yield* Effect.forkChild(branch(c))
            expect(CapabilitySet.equals(yield* Fiber.join(first), set([...a, ...b]))).toBe(true)
            expect(CapabilitySet.equals(yield* Fiber.join(second), set([...a, ...c]))).toBe(true)
            return yield* CapabilitySet.current
          }).pipe(CapabilitySet.attenuateGroups(a.map(group)))
          expect(CapabilitySet.equals(parent, set(a))).toBe(true)
          return CapabilitySet.equals(yield* CapabilitySet.current, top)
        }), { seed, executions: ioExecutions, execution: FuzzSimulation.execution() }))
    )
  })

  it("distinguishes lexical aliases, wildcard width, and effective configured denials", async () => {
    const arb = Arbitrary.schema(Schema.Struct({
      n: suffix,
      unit: Schema.Literals(["A", "é", "e\u0301", "😀", "\ud800", "\u0000", "\n"]),
      port: Schema.Literals(["443", "8443", "80"]),
      decision: Permission.RuleEffect
    }))
    passed(
      await Effect.runPromise(Fuzz.run(arb, ({ n, unit, port, decision }) =>
        Effect.gen(function*() {
          const file = `docs/${n}`
          const host = `api${n}.test:${port}`
          const ipv6 = `[2001:db8::1]:${port}`
          const cmd = `render${n}`
          const cases = [
            ["fs:read", file, file, true],
            ["fs:read", file, file.toUpperCase(), false],
            ["fs:read", file, `docs\\${n}`, false],
            ["fs:read", "docs/?", `docs/${unit}`, unit.length === 1],
            ["fs:read", "docs/é", "docs/e\u0301", false],
            ["fs:read", "docs/**", `docs/sub/../${n}`, true],
            ["net:get", "*.test:" + port, host, true],
            ["net:get", host, host.toUpperCase(), false],
            ["net:get", host, host.split(":")[0]!, false],
            ["net:get", ipv6, ipv6, true],
            ["net:get", ipv6, ipv6.replace("::", ":0:0:0:0:0:"), false],
            ["proc:spawn", cmd + " *", cmd, true],
            ["proc:spawn", cmd + " *", cmd + " " + unit, true],
            ["proc:spawn", cmd + " *", cmd + "\targ", false]
          ] as const
          for (const [action, glob, resource, matches] of cases) {
            const p = pattern(action, glob)
            const probe = Capability.make(action, resource)
            expect(CapabilitySet.allows(CapabilitySet.fromPatterns([p]), probe)).toBe(matches)
            const rules = [[rule("deny", p), rule(decision, p)], [rule("allow", pattern("*", "**"))]]
            expect(Permission.evaluate(rules, probe)).toBe(matches && decision === "deny" ? "deny" : "allow")
          }
          const wide = pattern("fs:read", "**")
          const configured = [rule("allow", wide), rule("deny", pattern("fs:read", file))]
          const relative = Capability.make("fs:read", `docs/sub/../${n}`)
          expect(Permission.evaluate([configured, [rule("allow", wide)]], relative)).toBe("deny")
          for (const resource of [`/${file}/../${n}`, `../${file}`]) {
            const probe = Capability.make("fs:read", resource)
            expect(Capability.matches(wide, probe)).toBe(false)
            expect(Permission.evaluate([[rule("allow", wide)]], probe)).toBe("deny")
          }
          return true
        }), { seed, executions: pureExecutions }))
    )
  })

  it("keeps a literal symlink grant distinct from its resolved target", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "capability-lattice-")))
    try {
      const targets = [join(root, "first"), join(root, "second")] as const
      await Promise.all(targets.map((target) => writeFile(target, "fixture")))
      const arb = Arbitrary.schema(Schema.Struct({
        first: Schema.Boolean,
        depth: Schema.Literals([1, 2, 3]),
        n: suffix
      }))
      passed(
        await Effect.runPromise(Fuzz.run(arb, ({ first, depth, n }) =>
          Effect.gen(function*() {
            const directory = yield* Effect.promise(() => mkdtemp(join(root, "links-")))
            const target = targets[first ? 0 : 1]
            const names = [target]
            for (let i = 0; i < depth; i++) {
              const alias = join(directory, `link-${n}-${i}`)
              const previous = names[i]!
              yield* Effect.promise(() => symlink(previous, alias))
              names.push(alias)
            }
            const alias = names[depth]!
            const canonical = yield* Effect.promise(() => realpath(alias))
            expect(canonical).toBe(target)
            const firstOnly = CapabilitySet.fromPatterns([pattern("fs:read", targets[0])])
            expect(CapabilitySet.allows(firstOnly, Capability.make("fs:read", canonical))).toBe(first)
            const lexical = CapabilitySet.fromPatterns([pattern("fs:read", alias)])
            const resolved = CapabilitySet.fromPatterns([pattern("fs:read", canonical)])
            for (const resource of names) {
              const probe = Capability.make("fs:read", resource)
              expect(CapabilitySet.allows(lexical, probe)).toBe(resource === alias)
              expect(CapabilitySet.allows(resolved, probe)).toBe(resource === target)
              expect(CapabilitySet.allows(meet(lexical, resolved), probe)).toBe(false)
            }
            return true
          }), { seed, executions: ioExecutions }))
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
