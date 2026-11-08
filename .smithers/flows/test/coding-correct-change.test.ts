import { Action } from "@smthrs/flow"
import { NodeRuntime } from "@smthrs/platform-node"
import { Cause, Effect, Exit, Layer, ManagedRuntime, Schema } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import * as MemoryStore from "../../../packages/smithers/agent/memory/src/MemoryStore.ts"
import * as NodeJj from "../../../packages/smithers/flows/jj/src/node/NodeJj.ts"
import { adoptChange, CorrectChange, correctionLayers, Repair, SelectRepair } from "../coding/correction.vibe"
import {
  nativeActions,
  NativeCoding,
  NativeCodingError,
  type NativeRevision,
  type ReadResult
} from "../coding/native.vibe"
import {
  type Change,
  checkInputDigest,
  CodingError,
  type Finding,
  type Receipt,
  type Revision
} from "../coding/schema.ts"
import { Implement, policyLayers, RunCheck } from "../coding/workflow.vibe"

// A real JJ stack: base, then the Changes owner, mid and tip, one atom each.
// owner.txt carries the defect; every Change's slow check reads it, so the red
// owner turns its whole suffix red until the owner is corrected in place.
const jj = (repo: string, ...args: Array<string>) =>
  execFileSync("jj", ["--no-pager", "--color=never", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, JJ_USER: "Correction Test", JJ_EMAIL: "correction@example.invalid" }
  })
const operationId = (repo: string) =>
  jj(repo, "op", "log", "--ignore-working-copy", "-n1", "--no-graph", "-T", "id").trim()
const treeOf = (repo: string, commitId: string) => {
  const hash = createHash("sha1")
  for (const path of jj(repo, "file", "list", "--ignore-working-copy", "-r", commitId).split("\n").filter(Boolean)) {
    hash.update(`${path}\0${jj(repo, "file", "show", "--ignore-working-copy", "-r", commitId, path)}\0`)
  }
  return hash.digest("hex")
}
const resolve = (repo: string, revset: string): Extract<NativeRevision, { kind: "resolved" }> => {
  const [changeId, commitId, parents, conflict, description] = jj(
    repo,
    "log",
    "--ignore-working-copy",
    "--no-graph",
    "-r",
    revset,
    "-T",
    "change_id ++ \"\\t\" ++ commit_id ++ \"\\t\" ++ parents.map(|p| p.commit_id()).join(\",\") ++ \"\\t\" ++ if(conflict, \"c\", \"r\") ++ \"\\t\" ++ description.first_line()"
  ).split("\t")
  assert.equal(conflict, "r", `${revset} must stay resolved`)
  return {
    kind: "resolved",
    changeId: changeId!,
    commitId: commitId!,
    treeId: treeOf(repo, commitId!),
    operationId: operationId(repo),
    parentCommitIds: parents!.split(",").filter(Boolean),
    description: description!
  }
}
const revision = ({ changeId, commitId, treeId, operationId, parentCommitIds }: Revision): Revision => ({
  changeId,
  commitId,
  treeId,
  operationId,
  parentCommitIds: [...parentCommitIds]
})
const read = (repo: string, changeIds: ReadonlyArray<string> = []): typeof ReadResult.Type => ({
  status: "read",
  operationId: operationId(repo),
  head: resolve(repo, "@"),
  revisions: changeIds.map((id) => resolve(repo, `change_id(${id})`))
})

/** NativeCoding over the jj CLI: reads never snapshot, and edit is fenced by the expected operation. */
const jjNative = (repo: string) =>
  Layer.succeed(NativeCoding, {
    sourcePublication: "local-only",
    read: (changeIds) => Effect.sync(() => read(repo, changeIds)),
    apply: (operation) =>
      Effect.suspend(() => {
        const before = operationId(repo)
        if (operation.operation !== "edit" || operation.expectedOperationId !== before) {
          return Effect.fail(
            new NativeCodingError({
              code: "revision_conflict",
              message: `Refused ${operation.operation} on a moved view`
            })
          )
        }
        jj(repo, "edit", "--ignore-working-copy", operation.target.commitId)
        const head = resolve(repo, "@")
        return Effect.succeed({
          status: "accepted" as const,
          operationId: head.operationId,
          parentOperationId: before,
          timestamp: new Date(0).toISOString(),
          head,
          revision: head,
          revisions: [head],
          provenance: "pending" as const
        })
      }),
    publishOriginalSource: () => Effect.die("correction never publishes source")
  })

const fixture = async () => {
  const repo = await mkdtemp(join(tmpdir(), "coding-correct-change-repo-"))
  jj(repo, "git", "init")
  const commit = async (message: string, file: string, content: string) => {
    await writeFile(join(repo, file), content)
    jj(repo, "describe", "-m", message)
    jj(repo, "new")
  }
  await commit("base", "base.txt", "base\n")
  await commit("owner: add the sum", "owner.txt", "1+1=3\n")
  await commit("mid: add a reader", "mid.txt", "mid\n")
  await writeFile(join(repo, "tip.txt"), "tip\n")
  jj(repo, "describe", "-m", "tip: add a second reader")
  jj(repo, "status")
  const ids = Object.fromEntries(
    (["base", "owner", "mid", "tip"] as const).map((name, index) => [name, resolve(repo, `@${"-".repeat(3 - index)}`)])
  ) as Record<"base" | "owner" | "mid" | "tip", ReturnType<typeof resolve>>
  return { repo, ids }
}

const checks: Change["checks"] = (["fast", "slow"] as const).map((tier) => ({
  id: tier === "fast" ? "build" : "sum",
  target: tier === "fast" ? "build" : "sum",
  flow: "check",
  flowDigest: "0".repeat(64),
  tier,
  required: true
}))
const change = (id: string, changeId: string, file: string): Change => ({
  id,
  title: id,
  intent: `Stack Change ${id}`,
  implementation: "implementation",
  implementationDigest: "0".repeat(64),
  atoms: [{ changeId, message: id, intent: `Stack Change ${id}`, reads: [], writes: [file] }],
  checks
})

test("CorrectChange amends a red Change in place, restacks its descendants and rechecks the suffix", {
  timeout: 180_000
}, async (t) => {
  const engine = await mkdtemp(join(tmpdir(), "coding-correct-change-engine-"))
  const { repo, ids } = await fixture()
  t.after(() => Promise.all([rm(engine, { recursive: true, force: true }), rm(repo, { recursive: true, force: true })]))
  execFileSync("jj", ["git", "init", engine], { stdio: "pipe" })
  await writeFile(join(engine, ".gitignore"), ".flows/\n")

  const ran: Array<string> = [], edits: Array<string> = []
  const layers = Layer.mergeAll(
    policyLayers,
    correctionLayers,
    nativeActions,
    SelectRepair.toLayer((context) =>
      Effect.succeed({ changeId: context.implementation.atoms[0]!.changeId, intent: "Make the sum true" })
    ),
    // The edit step: change the selected atom in place; JJ rebases its descendants on snapshot.
    Implement.toLayer(({ change, parent }) =>
      Effect.promise(async () => {
        const atom = change.atoms[0]!
        edits.push(`${change.id}:${atom.changeId}`)
        jj(repo, "edit", `change_id(${atom.changeId})`)
        await writeFile(join(repo, "owner.txt"), "1+1=2\n")
        jj(repo, "status")
        const head = revision(resolve(repo, `change_id(${atom.changeId})`))
        return { change: change.id, parent, atoms: [head], head, reads: [], writes: ["owner.txt"] }
      })
    ),
    RunCheck.toLayer(({ implementation, check }) =>
      Effect.sync((): Receipt => {
        const sum = jj(repo, "file", "show", "--ignore-working-copy", "-r", implementation.head.commitId, "owner.txt")
        ran.push(`${implementation.change}/${check.id}@${implementation.head.commitId}`)
        const red = check.tier === "slow" && sum !== "1+1=2\n"
        return {
          change: implementation.change,
          checkId: check.id,
          target: check.target,
          tier: check.tier,
          commitId: implementation.head.commitId,
          treeId: implementation.head.treeId,
          inputDigest: checkInputDigest(implementation, check),
          status: red ? "failed" : "passed",
          evidence: "jj file show owner.txt",
          findings: red
            ? [{ owner: implementation.change, message: "1+1 is not 3", sourceCommitId: implementation.head.commitId }]
            : []
        }
      })
    )
  ).pipe(Layer.provideMerge(Action.layerImplementations), Layer.provide(jjNative(repo)))
  const runtime = NodeRuntime.layerHost({
    filename: join(engine, ".flows", "engine.db"),
    workspaceRoot: engine,
    owner: { hostId: "correct-change-test" },
    signals: []
  }, layers).pipe(
    Layer.provide(Layer.succeed(NodeJj.StartupTimeoutMs, 30_000)),
    Layer.provideMerge(MemoryStore.layerNoop())
  )

  const findings: Array<Finding> = [{ owner: "owner", message: "1+1 is not 3", sourceCommitId: ids.owner.commitId }]
  const input = {
    base: revision(ids.base),
    changes: [
      change("owner", ids.owner.changeId, "owner.txt"),
      change("mid", ids.mid.changeId, "mid.txt"),
      change("tip", ids.tip.changeId, "tip.txt")
    ],
    findings,
    memoryRevision: "fixture",
    maxRounds: 2
  }
  let first: unknown
  for (const phase of ["fresh", "reopened"] as const) {
    const host = ManagedRuntime.make(runtime)
    try {
      const exit = await host.runPromise(
        CorrectChange.execute(input, { executionId: "correct-change" }).pipe(Effect.exit)
      )
      assert.ok(Exit.isSuccess(exit), Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "")
      if (phase === "reopened") {
        assert.deepEqual(exit.value, first, "cold replay returns the recorded correction")
        continue
      }
      first = exit.value
      assert.equal(exit.value.status, "validated", JSON.stringify(exit.value))
      assert.equal(exit.value.rounds, 1)
    } finally {
      await host.dispose()
    }
  }
  assert.deepEqual(edits, [`owner:${ids.owner.changeId}`], "one in-place edit of the owner, none on replay")

  // The owner keeps its change id; the descendants keep theirs on new commits, linear on the fix.
  const after = Object.fromEntries(
    (["base", "owner", "mid", "tip"] as const).map((name) => [name, resolve(repo, `change_id(${ids[name].changeId})`)])
  ) as typeof ids
  assert.equal(after.base.commitId, ids.base.commitId, "the green prefix is untouched")
  for (const name of ["owner", "mid", "tip"] as const) {
    assert.notEqual(after[name].commitId, ids[name].commitId, `${name} is rewritten`)
    assert.equal(jj(repo, "file", "show", "--ignore-working-copy", "-r", after[name].commitId, "owner.txt"), "1+1=2\n")
  }
  assert.deepEqual(after.owner.parentCommitIds, [ids.base.commitId])
  assert.deepEqual(after.mid.parentCommitIds, [after.owner.commitId])
  assert.deepEqual(after.tip.parentCommitIds, [after.mid.commitId])
  assert.equal(resolve(repo, "@").changeId, ids.tip.changeId, "the working copy returns to the stack tip")

  // Every Change of the rewritten suffix was checked again, only at its new commit.
  assert.deepEqual(
    [...ran].sort(),
    (["owner", "mid", "tip"] as const).flatMap((
      name
    ) => [`${name}/build@${after[name].commitId}`, `${name}/sum@${after[name].commitId}`])
      .sort()
  )
})

const stack = (): {
  base: Revision
  changes: ReadonlyArray<Change>
  read: typeof ReadResult.Type
  heads: Array<Revision>
} => {
  const op = "1".repeat(128)
  const rev = (letter: string, parent: string | null): Extract<NativeRevision, { kind: "resolved" }> => ({
    kind: "resolved",
    changeId: letter.repeat(32),
    commitId: (letter.charCodeAt(0) - 107).toString(16).repeat(40),
    treeId: "e".repeat(40),
    operationId: op,
    parentCommitIds: parent === null ? [] : [parent]
  })
  const base = rev("k", null),
    owner = rev("l", base.commitId),
    mid = rev("m", owner.commitId),
    tip = rev("n", mid.commitId)
  return {
    base: revision(base),
    changes: [
      change("owner", owner.changeId, "owner.txt"),
      change("mid", mid.changeId, "mid.txt"),
      change("tip", tip.changeId, "tip.txt")
    ],
    read: { status: "read", operationId: op, head: tip, revisions: [base, owner, mid, tip] },
    heads: [owner, mid, tip].map(revision)
  }
}
const adopt = (edit: (value: ReturnType<typeof stack>, findings: Array<Finding>) => void) => {
  const value = stack()
  const findings: Array<Finding> = [{ owner: "owner", message: "red", sourceCommitId: value.heads[0]!.commitId }]
  edit(value, findings)
  try {
    return adoptChange(
      { base: value.base, changes: value.changes, findings, memoryRevision: "fixture", maxRounds: 2 },
      value.read
    )
  } catch (error) {
    assert.ok(error instanceof CodingError, String(error))
    return error
  }
}

test("adoptChange turns the owner and its descendants into a repair cursor", () => {
  const value = stack()
  const cursor = adopt(() => {})
  assert.ok(!(cursor instanceof CodingError), String(cursor))
  assert.equal(cursor.round, 1)
  assert.equal(cursor.previous?.status, "changes-requested")
  assert.deepEqual(cursor.previous?.changes.map((group) => group.implementation.head), value.heads)
  assert.deepEqual(
    cursor.previous?.changes.map((group) => group.receipts),
    [[], [], []],
    "the whole suffix is rechecked"
  )
  assert.deepEqual(cursor.plan.base, value.base)
})

for (
  const [name, code, edit] of [
    ["a finding owned by a descendant", "invalid_request", (_: ReturnType<typeof stack>, findings: Array<Finding>) => {
      findings[0] = { ...findings[0]!, owner: "mid" }
    }],
    [
      "a finding from an older owner commit",
      "stale_revision",
      (_: ReturnType<typeof stack>, findings: Array<Finding>) => {
        findings[0] = { ...findings[0]!, sourceCommitId: "f".repeat(40) }
      }
    ],
    ["an atom without a change id", "invalid_request", (value: ReturnType<typeof stack>) => {
      const [owner, ...rest] = value.changes
      value.changes = [{ ...owner!, atoms: [{ ...owner!.atoms[0]!, changeId: null }] }, ...rest]
    }],
    ["a suffix that stops below the workspace tip", "stale_revision", (value: ReturnType<typeof stack>) => {
      value.changes = value.changes.slice(0, 2)
    }],
    ["a stack that is not linear on the base", "stale_revision", (value: ReturnType<typeof stack>) => {
      value.read = {
        ...value.read,
        revisions: value.read.revisions.map((rev) =>
          rev.changeId === "m".repeat(32) ? { ...rev, parentCommitIds: [value.base.commitId] } : rev
        )
      }
    }],
    ["a Change that declares no written paths", "invalid_request", (value: ReturnType<typeof stack>) => {
      const [owner, mid, tip] = value.changes
      value.changes = [owner!, { ...mid!, atoms: [{ ...mid!.atoms[0]!, writes: [] }] }, tip!]
    }],
    ["a base that is one of the atoms", "invalid_request", (value: ReturnType<typeof stack>) => {
      value.base = value.heads[0]!
    }],
    ["a base that moved", "stale_revision", (value: ReturnType<typeof stack>) => {
      value.base = { ...value.base, commitId: "9".repeat(40) }
    }],
    ["a conflicted atom", "stale_revision", (value: ReturnType<typeof stack>) => {
      value.read = {
        ...value.read,
        revisions: value.read.revisions.map((rev) =>
          rev.changeId === "n".repeat(32)
            ? { ...rev, kind: "conflicted" as const, treeTerms: [{ treeId: "e".repeat(40), positive: true }] }
            : rev
        )
      }
    }]
  ] as const
) {
  test(`adoptChange refuses ${name}`, () => {
    const error = adopt(edit as (value: ReturnType<typeof stack>, findings: Array<Finding>) => void)
    assert.ok(error instanceof CodingError, `expected a refusal, got ${JSON.stringify(error)}`)
    assert.equal(error.code, code, error.message)
  })
}

test("a repair recorded before the request field decodes into the current shape", () => {
  const value = stack()
  const request = {
    change: value.changes[0]!,
    parent: value.base,
    memoryRevision: "fixture",
    memory: [{ origin: "recall" as const, bank: "notes", key: "n1", text: "Keep sums true" }]
  }
  const legacy = { ...request, index: 0, ordinal: 0 }
  assert.deepEqual(Schema.decodeUnknownSync(Repair)(legacy), { index: 0, ordinal: 0, request })
  const { memory: _, ...bare } = legacy
  assert.equal("memory" in Schema.decodeUnknownSync(Repair)(bare).request, false)
  const current = { index: 0, ordinal: 0, request }
  assert.deepEqual(Schema.encodeSync(Repair)(current), current, "new repairs keep the request field")
})
