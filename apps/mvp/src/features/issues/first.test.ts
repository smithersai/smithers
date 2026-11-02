// A cold issue page (production, 2026-11-02: 7.7 s to its title) shows the issue the issues route answers before its
// shapes have synced: a real app and ChatApi, with every shape request held, as a cold device's are while they sync.
import { ShapeSource } from "@smthrs/effect-electric"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { afterEach, expect, test, vi } from "vitest"
import { repoId } from "../repo/contract"
import { openTestApp, TEST_REPOSITORY, TestChatApi } from "../../test/chatApi"
import { IssuesStore } from "./store"

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.dispose() })

test("an issue page has its issue from the issues route while every shape is still held", async () => {
  const requests: Array<string> = []
  // Every shape request waits forever: nothing synced reaches the device.
  const held = { ...ShapeSource.fetchSource, request: (url: string) => Effect.suspend(() => { requests.push(new URL(url).pathname); return Effect.never }) }
  const runtime = openTestApp({ replace: Layer.succeed(ShapeSource.ShapeSource, held as ShapeSource.Source) })
  runtimes.push(runtime)
  const api = await runtime.runPromise(Effect.service(TestChatApi))
  const [owner, name] = TEST_REPOSITORY.split("/") as [string, string]
  const id = repoId(owner, name)
  await Effect.runPromise(api.github.run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(
    `INSERT INTO items (id, repo_id, number, kind, github_id, title, body, state, author_login, created_at, updated_at, source_updated_at, fetched_at)
    VALUES ('${id}#7', '${id}', 7, 'issue', 7007, 'Crash on empty body', 'Steps to reproduce', 'open', 'maya', now(), now(), now(), now())`,
  ))))
  const store = await runtime.runPromise(Effect.service(IssuesStore))
  await runtime.runPromise(store.route(id, 7))
  await runtime.runPromise(store.view.update("view", (row) => { row.owner = owner; row.name = name; row.repoId = id; row.number = 7 }))
  // As a page's useLiveQuery does: the queries run once something reads them.
  const first = store.routed().first.tanstack
  first.startSyncImmediate()
  store.routed().item.tanstack.startSyncImmediate()
  await vi.waitFor(() => expect(first.toArray[0]).toMatchObject({ number: 7, title: "Crash on empty body", body: "Steps to reproduce", author: "maya" }), { timeout: 15_000 })
  // The synced item is still absent: the page's first paint came from the route alone.
  expect(store.routed().item.tanstack.toArray).toEqual([])
  expect(requests.some((path) => path === "/api/shapes/items")).toBe(true)
}, 60_000)
