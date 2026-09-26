/**
 * The trusted registry and the dispatch-time checks, without a model: the
 * pinned snapshot, principal resolution by id through both the pinned and the
 * current roster, and the composition, seat, and workspace checks.
 */
import { Effect, Exit, Result } from "effect"
import { symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Authority from "../src/Authority.ts"
import type * as Config from "../src/Config.ts"
import type * as Profile from "../src/Profile.ts"
import * as Roster from "../src/Roster.ts"
import { common, loadSnapshot, patched, payloadFor, task, wikiRoot } from "./dispatchSupport.ts"
import { err, exampleDir, flip, ok, run } from "./support.ts"

const organization = (patch: Partial<Config.Organization> = {}): Pick<Config.Loaded, "organization"> => ({
  organization: {
    owner: "owner",
    assistant: "assistant",
    rosterDir: "Org",
    skillsDir: "Org/Skills",
    seats: { default: "openai:gpt-6-sol" },
    judge: "none",
    vm: { provider: "microsandbox", image: "node:26-bookworm", cpus: 1, memoryMib: 1024, maxConcurrentVMs: 1 },
    wiki: { generatedDir: "Org/Runs", statusFile: "Org/Status.md", commit: false, push: false },
    ...patch
  }
})

const resolved = (snapshot: Authority.Snapshot, current: Authority.Snapshot, id: string) =>
  Authority.resolvePrincipal(snapshot.roster, current.roster, id)

describe("snapshots", () => {
  it("pins the roster, common instructions, and skill pack under one revision", async () => {
    const snapshot = await loadSnapshot()
    const again = await loadSnapshot()
    expect(snapshot.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(again.revision).toBe(snapshot.revision)
    const otherCommon = ok(Authority.makeSnapshot({ ...snapshot, common: { ...common, text: "Other." } }))
    expect(otherCommon.revision).not.toBe(snapshot.revision)
  })

  it("refuses a roster that breaks an invariant, listing every violation", async () => {
    const snapshot = await loadSnapshot()
    const broken = Roster.make(
      patched([...snapshot.roster.profiles.values()], "builder", { skills: ["unknown-skill"] }),
      snapshot.roster.sources
    )
    const refused = err(Authority.makeSnapshot({ roster: broken, common, skills: snapshot.skills }))
    expect(refused.code).toBe("invalid-roster")
    expect(refused.violations.map((violation) => violation.code)).toEqual(["unknown-skill"])
  })

  it("loads from a wiki root: roster, skills, and a confined common page", async () => {
    const root = wikiRoot()
    writeFileSync(join(root, "Org", "Common.md"), "Be brief.\n")
    const loaded = await run(Authority.loadSnapshot(root, organization({ commonFile: "Org/Common.md" })))
    expect(loaded.common).toMatchObject({ id: "Org/Common.md", text: "Be brief.\n" })
    expect([...loaded.roster.profiles.keys()]).toEqual(["assistant", "builder", "checker", "lead"])
    expect([...loaded.skills.skills.keys()]).toEqual(["evidence-receipts"])
  })

  it("loads without a common page or skills directory, and refuses what it cannot read", async () => {
    const root = wikiRoot()
    const bare = await flip(Authority.loadSnapshot(root, organization({ skillsDir: undefined } as never)))
    // Without the pack, the roster's skills are unknown: the snapshot is refused.
    expect(bare.code).toBe("invalid-roster")
    const { skillsDir: _, ...withoutSkills } = organization().organization
    const noCommon = await flip(Authority.loadSnapshot(root, { organization: withoutSkills }))
    expect(noCommon.code).toBe("invalid-roster")

    const loaded = await run(Authority.loadSnapshot(root, organization()))
    expect(loaded.common).toMatchObject({ id: "none", text: "" })

    const missingRoster = await flip(Authority.loadSnapshot(root, organization({ rosterDir: "Nowhere" })))
    expect(missingRoster).toMatchObject({ code: "load-failed" })
    expect(missingRoster.message).toContain("the roster could not be loaded")
    const missingSkills = await flip(Authority.loadSnapshot(root, organization({ skillsDir: "Org/NoSkills" })))
    expect(missingSkills.message).toContain("the skills could not be loaded")
    const outside = join(root, "..", `outside-${Date.now()}.md`)
    writeFileSync(outside, "Leaked.\n")
    symlinkSync(outside, join(root, "Org", "Escape.md"))
    const escaped = await flip(Authority.loadSnapshot(root, organization({ commonFile: "Org/Escape.md" })))
    expect(escaped.message).toBe("Org/Escape.md resolves outside the wiki root")
  })
})

describe("principal resolution", () => {
  it("resolves an active principal from the pinned roster", async () => {
    const snapshot = await loadSnapshot()
    expect(ok(resolved(snapshot, snapshot, "builder")).id).toBe("builder")
  })

  it("refuses an unknown, paused, or retired principal in either roster", async () => {
    const snapshot = await loadSnapshot()
    expect(err(resolved(snapshot, snapshot, "intruder")).reason).toBe("unknown-principal")
    const paused = Roster.make(
      patched([...snapshot.roster.profiles.values()], "builder", { status: "paused" }),
      snapshot.roster.sources
    )
    expect(err(Authority.resolvePrincipal(paused, snapshot.roster, "builder"))).toMatchObject({
      reason: "inactive",
      message: "in the pinned roster: principal builder is paused"
    })
    expect(err(Authority.resolvePrincipal(snapshot.roster, paused, "builder"))).toMatchObject({
      reason: "inactive",
      message: "in the current roster: principal builder is paused"
    })
    const removed = Roster.make(
      [...snapshot.roster.profiles.values()].filter((profile) => profile.id !== "builder"),
      snapshot.roster.sources
    )
    expect(err(Authority.resolvePrincipal(snapshot.roster, removed, "builder")).reason).toBe("unknown-principal")
  })

  it("refuses a hire whose hirer is retired, even while the hire itself is active", async () => {
    const snapshot = await loadSnapshot(undefined, exampleDir)
    const retiredAncestor = Roster.make(
      patched([...snapshot.roster.profiles.values()], "lead", { status: "retired" }),
      snapshot.roster.sources
    )
    expect(retiredAncestor.profiles.get("lead.research")!.status).toBe("active")
    expect(err(Authority.resolvePrincipal(snapshot.roster, retiredAncestor, "lead.research"))).toMatchObject({
      reason: "inactive",
      message: "in the current roster: principal lead.research's hirer lead is retired"
    })
  })

  it("refuses a principal whose grants were narrowed since the pin", async () => {
    const snapshot = await loadSnapshot()
    const narrowed = Roster.make(
      patched([...snapshot.roster.profiles.values()], "builder", {
        grants: { ...snapshot.roster.profiles.get("builder")!.grants, repositories: [] }
      }),
      snapshot.roster.sources
    )
    expect(err(Authority.resolvePrincipal(snapshot.roster, narrowed, "builder"))).toMatchObject({
      reason: "grants-narrowed"
    })
  })
})

describe("the registry", () => {
  it("keeps every pinned revision and moves current to the latest pin", async () => {
    const first = await loadSnapshot()
    const second = await loadSnapshot((profiles) => patched(profiles, "builder", { version: "1.0.1" }))
    const outcome = await Effect.runPromise(Effect.gen(function*() {
      const registry = yield* Authority.makeRegistry(first)
      expect((yield* registry.current).revision).toBe(first.revision)
      expect(yield* registry.pin(second)).toBe(second.revision)
      return {
        current: (yield* registry.current).revision,
        first: (yield* registry.get(first.revision)).revision,
        builder: (yield* registry.resolve(first.revision, "builder")).profile.version,
        unknown: yield* Effect.flip(registry.get("f".repeat(64)))
      }
    }))
    expect(outcome).toMatchObject({ current: second.revision, first: first.revision, builder: "1.0.0" })
    expect(outcome.unknown.reason).toBe("unknown-revision")
  })
})

const authorize = (snapshot: Authority.Snapshot, payload: unknown, executionId = "run-1") =>
  Effect.runPromise(
    Authority.authorize(payload, executionId).pipe(
      Effect.provide(Authority.layerRegistry(snapshot)),
      Effect.exit
    )
  )

const refusedWith = (exit: Exit.Exit<unknown, Authority.DispatchRefused>) => {
  if (Exit.isSuccess(exit)) throw new Error("expected a refusal")
  return Result.getOrThrow(Result.fromOption(Exit.findErrorOption(exit), () => "no error")).reason
}

describe("authorize", () => {
  it("admits a composed task and returns the host's composition, not the payload's", async () => {
    const snapshot = await loadSnapshot()
    const payload = payloadFor(snapshot, "builder", task(), [{
      source: { provider: "slack", id: "C1/1" },
      provenance: { retrievedAtMs: 1_790_000_000_000 },
      text: "Please make the change."
    }])
    const exit = await authorize(snapshot, { ...payload, profile: { id: "builder", grants: { tools: ["*"] } } })
    if (Exit.isFailure(exit)) throw new Error("refused")
    expect(exit.value.profile).toBe(snapshot.roster.profiles.get("builder"))
    expect(exit.value.composed.digest).toBe(payload.digest)
    expect(exit.value.composed.prompt).toBe(Authority.promptOf(payload))
    expect(exit.value.workspace).toBeUndefined()
  })

  it("refuses a malformed payload, a changed prompt, and a failed composition", async () => {
    const snapshot = await loadSnapshot()
    const payload = payloadFor(snapshot, "builder", task())
    expect(refusedWith(await authorize(snapshot, { ...payload, principal: "Not An Id" }))).toBe("malformed-payload")
    expect(refusedWith(await authorize(snapshot, { ...payload, task: { ...payload.task, objective: "Delete it." } })))
      .toBe("composition-mismatch")
    const oversized = {
      ...payload,
      task: { ...payload.task, inputs: Array.from({ length: 40 }, () => "x".repeat(2000)) }
    }
    expect(refusedWith(await authorize(snapshot, oversized))).toBe("composition-failed")
  })

  it("admits a granted workspace this execution prepared", async () => {
    const snapshot = await loadSnapshot()
    const payload = {
      ...payloadFor(snapshot, "builder", task()),
      workspace: { key: "run-1/example/demo/build", repository: "example/demo" }
    }
    const exit = await authorize(snapshot, payload)
    expect(Exit.isSuccess(exit) && exit.value.workspace).toEqual(payload.workspace)
  })

  it("composes only from the pinned pack: a principal whose skill is missing is refused", async () => {
    const snapshot = await loadSnapshot()
    const builder = snapshot.roster.profiles.get("builder")!
    const withoutPack: Authority.Snapshot = { ...snapshot, skills: { revision: "empty", skills: new Map() } }
    const composed = Authority.compose(withoutPack, builder, task(), [])
    expect(err(composed)).toMatchObject({ reason: "composition-failed" })
    const unknownSkill: Profile.Profile = { ...builder, skills: ["evidence-receipts"] }
    expect(ok(Authority.compose(snapshot, unknownSkill, task(), [])).system).toHaveLength(3)
  })
})
