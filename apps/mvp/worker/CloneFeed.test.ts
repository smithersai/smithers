// A clone in its asker's feed (worker/CloneFeed.vibe), folded straight from rows written by hand over this file's schema
// of the compose Postgres: what the fold does with a row no request names and with a row from before the stages.
// The fold through the clone's own steps is in worker/flows/RepoClone.test.ts.
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import { cloneSubject } from "../src/features/repo/contract.ts"
import * as CloneFeed from "./CloneFeed.vibe"
import { testFile } from "./test/harness.ts"
import { notificationRow, resetRepos } from "./test/repos.ts"

const runtime = testFile("clone_feed")
beforeEach(() => resetRepos(runtime))

const sql = (statement: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => Effect.orDie(client.unsafe(statement))))

const fold = (id: string) => runtime.runPromise(CloneFeed.fold(id))

describe("CloneFeed.fold", () => {
  test("a repository no one's request names, or none at all, goes to no one", async () => {
    expect(await fold("github/a/none")).toBe(0)
    await sql(`INSERT INTO repositories (id, owner, name, status, stage) VALUES ('github/a/b', 'a', 'b', 'cloning', 'fetching')`)
    expect(await fold("github/a/b")).toBe(0)
    // A request for another attempt names someone else's clone, not this one.
    await sql(`INSERT INTO clone_requests (repo_id, clone_id, requested_by) VALUES ('github/a/b', gen_random_uuid(), 'ann')`)
    expect(await fold("github/a/b")).toBe(0)
  })

  test("a clone running since before the stages reads as requested; the same again writes nothing", async () => {
    await sql(`INSERT INTO repositories (id, owner, name, status) VALUES ('github/a/old', 'a', 'old', 'cloning')`)
    await sql(`INSERT INTO clone_requests (repo_id, clone_id, requested_by)
      SELECT id, clone_id, 'ann' FROM repositories WHERE id = 'github/a/old'`)
    expect(await fold("github/a/old")).toBe(1)
    expect(await notificationRow(runtime, "ann", cloneSubject("github/a/old"))).toMatchObject({
      kind: "clone",
      state: "working",
      ref: "requested",
      title: "a/old",
      href: "/a/old",
      version: 1,
    })
    expect(await fold("github/a/old")).toBe(0)
  })
})
