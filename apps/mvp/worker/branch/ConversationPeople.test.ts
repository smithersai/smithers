// A person's own list of conversations on the server (decision 0013 decision 2, docs/features/conversations.md): the
// statements (worker/branch/ConversationPeople.vibe) against the compose Postgres, in this file's own schema.
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import { resetBranches, tracked } from "../test/branch.ts"
import { testFile } from "../test/harness.ts"
import * as People from "./ConversationPeople.vibe"

const runtime = testFile("conversation_people")
beforeEach(() => resetBranches(runtime))
const rows = () => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`SELECT * FROM conversation_people ORDER BY person_id`))

test("personal, idempotent latest acts win; asks never restore and opens restore at server time", async () => {
  const b = await tracked(runtime, "github/octocat/spoon-knife", "feature")
  const run = runtime.runPromise
  await run(People.asked(b.conversationId, "a"))
  await run(People.asked(b.conversationId, "b"))
  const at = Date.now() + 1000
  expect(await run(People.archive(b.conversationId, "a", true, at))).not.toBeNull()
  expect(await run(People.archive(b.conversationId, "a", false, at - 1))).toBeNull()
  expect(await run(People.archive(b.conversationId, "a", true, at))).toBeNull()
  await run(People.asked(b.conversationId, "a"))
  expect((await rows())[0].archived_at).not.toBeNull()
  expect((await rows())[1].archived_at).toBeNull()
  await run(People.opened(b.conversationId, "a", "Octocat", "Spoon-Knife", "feature"))
  expect((await rows())[0].archived_at).not.toBeNull()
  await run(People.archive(b.conversationId, "a", false, at + 1))
  expect(await run(People.archive(b.conversationId, "a", true, at))).toBeNull()
  await run(People.archive(b.conversationId, "c", true, 1))
  await run(People.opened(b.conversationId, "c", "Octocat", "Spoon-Knife", "feature"))
  expect((await rows())[2]).toMatchObject({ owner: "Octocat", archived_at: null })
  expect(await run(People.archive(b.conversationId, "c", true, 2))).toBeNull()
})

test("an open tried again after a lost answer never undoes an archive made since, nor moves up the list", async () => {
  const b = await tracked(runtime, "github/octocat/spoon-knife", "feature")
  const run = runtime.runPromise
  const row = async () => (await rows())[0] as { archived_at: Date | null; opened_at: Date; changed_at: Date }
  const open = (at?: number) => run(People.opened(b.conversationId, "a", "octocat", "Spoon-Knife", "feature", at))
  const base = Date.now() - 60_000
  // Open A, then open B on another device, then archive: A's lost answer makes its step try again.
  await open(base)
  await open(base + 10)
  await run(People.archive(b.conversationId, "a", true, base + 20))
  await open(base)
  expect((await row()).archived_at).not.toBeNull()
  expect((await row()).opened_at.getTime()).toBe(base + 10)
  expect((await row()).changed_at.getTime()).toBe(base + 20)
  // A new open, later than the archive, brings it back; so does one that names no time, as the agent's, at now.
  await open(base + 30)
  expect((await row()).archived_at).toBeNull()
  expect((await row()).opened_at.getTime()).toBe(base + 30)
  await run(People.archive(b.conversationId, "a", true, base + 40))
  await open()
  expect((await row()).archived_at).toBeNull()
})
