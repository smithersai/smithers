// A branch's conversation (worker/branch/Conversations.vibe, decision 0013 §1) on this file's schema of the compose
// Postgres (`pnpm db:up`): a conversation's id is the version 5 UUID of its branch's id, recorded with the branch in one
// transaction, and the home conversation is the deployment repository's `main`, which 0014_branch_workspace records.
import { Uuid, WebCrypto } from "@smthrs/crypto"
import { ConfigProvider, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import { CONVERSATION_NAMESPACE, HOME_BRANCH } from "../../src/features/branch/contract.ts"
import { resetBranches, shaOf } from "../test/branch.ts"
import { testFile } from "../test/harness.ts"
import * as Conversations from "./Conversations.vibe"

const runtime = testFile("conversations")
beforeEach(() => resetBranches(runtime))

const REPO = "github/octocat/spoon-knife"

const withConfig = <A, E, R>(effect: Effect.Effect<A, E, R>, config: Record<string, string>) =>
  effect.pipe(Effect.provide(Layer.effect(Conversations.homeRepositoryNames, Conversations.configuredHomeRepositoryNames)), Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(config)))

const remove = (branchId: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`UPDATE branches SET deleted_at = now() WHERE id = ${branchId}`))

describe("conversationIdOf", () => {
  test("is the version 5 UUID of the branch's id, in any case, and differs per branch", async () => {
    const [a, b] = [crypto.randomUUID(), crypto.randomUUID()]
    const expected = await Effect.runPromise(Uuid.v5(CONVERSATION_NAMESPACE, a).pipe(Effect.provide(WebCrypto.layer)))
    expect(await Effect.runPromise(Conversations.conversationIdOf(a))).toBe(expected)
    expect(await Effect.runPromise(Conversations.conversationIdOf(a.toUpperCase()))).toBe(expected)
    expect(expected).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(await Effect.runPromise(Conversations.conversationIdOf(b))).not.toBe(expected)
  })
})

describe("homeRepository", () => {
  test("is GITHUB_REPOSITORY's id, smithersai/smithers unless set", async () => {
    const read = (config: Record<string, string>) =>
      Effect.runPromise(withConfig(Effect.gen(function* () {
        return yield* Conversations.homeRepository
      }), config))
    expect(await read({})).toBe("github/smithersai/smithers")
    expect(await read({ GITHUB_REPOSITORY: "Acme/Widgets" })).toBe("github/acme/widgets")
  })
})

describe("track and find", () => {
  test("records a branch with its conversation once; tracking it again answers the branch as it is", async () => {
    const sha = shaOf("feature")
    const first = await runtime.runPromise(Conversations.track(REPO, "feature", "open", sha))
    expect(first).toEqual({
      created: true,
      branch: {
        branchId: expect.any(String),
        conversationId: await Effect.runPromise(Conversations.conversationIdOf(first.branch.branchId)),
        repoId: REPO,
        name: "feature",
        mode: "open",
      },
    })
    // A second track, with another mode and commit, changes nothing.
    expect(await runtime.runPromise(Conversations.track(REPO, "feature", "locked", shaOf("other")))).toEqual({
      created: false,
      branch: first.branch,
    })
    expect(await runtime.runPromise(Conversations.find(REPO, "feature"))).toEqual(first.branch)
    const [row] = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly baseSha: string; readonly conversations: number }>`
        SELECT b.base_sha AS "baseSha", (SELECT count(*)::int FROM conversations WHERE branch_id = b.id) AS conversations
        FROM branches b WHERE b.id = ${first.branch.branchId}`))
    expect(row).toEqual({ baseSha: sha, conversations: 1 })
  })

  test("two tracks at once record the branch once, and both answer it", async () => {
    const both = await runtime.runPromise(
      Effect.all([
        Conversations.track(REPO, "race", "open", shaOf("race")),
        Conversations.track(REPO, "race", "open", shaOf("race")),
      ], { concurrency: 2 }),
    )
    expect(both.map((tracked) => tracked.created).sort()).toEqual([false, true])
    expect(both[0]!.branch).toEqual(both[1]!.branch)
  })

  test("a deleted branch is found by neither, and its name tracks a new branch with a new id and conversation", async () => {
    const old = await runtime.runPromise(Conversations.track(REPO, "feature", "open", shaOf("feature")))
    await remove(old.branch.branchId)
    expect(await runtime.runPromise(Conversations.find(REPO, "feature"))).toBeUndefined()

    const renewed = await runtime.runPromise(Conversations.track(REPO, "feature", "open", shaOf("feature")))
    expect(renewed.created).toBe(true)
    expect(renewed.branch.branchId).not.toBe(old.branch.branchId)
    expect(renewed.branch.conversationId).not.toBe(old.branch.conversationId)
  })

  test("a branch the app doesn't track is undefined, and so is another repository's name", async () => {
    await runtime.runPromise(Conversations.track(REPO, "feature", "open", shaOf("feature")))
    expect(await runtime.runPromise(Conversations.find("github/octocat/other", "feature"))).toBeUndefined()
  })
})

describe("home", () => {
  test("home is the conversation of the deployment repository's main", async () => {
    const home = await runtime.runPromise(Conversations.home)
    const main = await runtime.runPromise(Conversations.find("github/smithersai/smithers", HOME_BRANCH))
    expect(main).toMatchObject({ conversationId: home, mode: "locked" })
  })

  test("home uses the captured deployment repository after ambient Config disappears", async () => {
    const captured = await runtime.runPromise(Conversations.configuredHomeRepositoryNames.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ GITHUB_REPOSITORY: "acme/widgets" })),
    ))
    const tracked = await runtime.runPromise(Conversations.track("github/acme/widgets", HOME_BRANCH, "locked", shaOf("main")))
    expect(await runtime.runPromise(Conversations.home.pipe(
      Effect.provideService(Conversations.homeRepositoryNames, captured),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
    ))).toBe(tracked.branch.conversationId)
  })

  test("a deployment repository the app doesn't track has no home conversation", async () => {
    expect(await runtime.runPromise(withConfig(Conversations.home, { GITHUB_REPOSITORY: "acme/widgets" })))
      .toBeUndefined()
  })
})

test("retains the ref namespace across tracking, reload, and sharing identity", async () => {
  const first = await runtime.runPromise(Conversations.track(REPO, "private-work", "open", shaOf("main"), "owner", undefined, "ephemeral"))
  const [row] = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ namespace: string }>`SELECT ref_namespace AS namespace FROM branches WHERE id = ${first.branch.branchId}`))
  expect(row!.namespace).toBe("ephemeral")
  expect(await runtime.runPromise(Conversations.namespaceOf(first.branch.branchId))).toBe("ephemeral")
  expect(await runtime.runPromise(Conversations.find(REPO, "private-work"))).toEqual(first.branch)
  // A replay through the legacy call shape cannot replace a recorded namespace, owner, or identity.
  const replay = await runtime.runPromise(Conversations.track(REPO, "private-work", "locked", shaOf("other")))
  expect(replay).toEqual({ created: false, branch: first.branch })
  expect(await runtime.runPromise(Conversations.namespaceOf(replay.branch.branchId))).toBe("ephemeral")
  const old = await runtime.runPromise(Conversations.track(REPO, "ordinary", "open", shaOf("main")))
  expect(await runtime.runPromise(Conversations.namespaceOf(old.branch.branchId))).toBe("default")
  const home = await runtime.runPromise(Conversations.find("github/smithersai/smithers", HOME_BRANCH))
  expect(await runtime.runPromise(Conversations.namespaceOf(home!.branchId))).toBe("default")
  expect(home!.conversationId).toBe(await runtime.runPromise(Conversations.conversationIdOf(home!.branchId)))
  expect(await runtime.runPromise(Conversations.namespaceOf(crypto.randomUUID()))).toBe("default")
})

test("retains the explicit GitHub forge on replay and defaults legacy and missing branches to deployment", async () => {
  const first = await runtime.runPromise(Conversations.track(REPO, "published", "open", shaOf("main"), "owner", undefined, "default", "github"))
  expect(await runtime.runPromise(Conversations.forgeOf(first.branch.branchId))).toBe("github")
  const replay = await runtime.runPromise(Conversations.track(REPO, "published", "locked", shaOf("other")))
  expect(replay.branch).toEqual(first.branch)
  expect(await runtime.runPromise(Conversations.forgeOf(replay.branch.branchId))).toBe("github")
  expect(await runtime.runPromise(Conversations.namespaceOf(replay.branch.branchId))).toBe("default")
  const old = await runtime.runPromise(Conversations.track(REPO, "ordinary", "open", shaOf("main")))
  expect(await runtime.runPromise(Conversations.forgeOf(old.branch.branchId))).toBeUndefined()
  expect(await runtime.runPromise(Conversations.forgeOf(crypto.randomUUID()))).toBeUndefined()
})
