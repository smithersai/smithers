import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir, hostname } from "node:os"
import { join } from "node:path"
import { FeedTurn } from "./feed-turn.ts"
import { ResourceLocks } from "./resource-locks.ts"

const directory = async (t) => {
  const root = await mkdtemp(join(tmpdir(), "feed-turn-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
const lockAt = async (t) => new ResourceLocks(await directory(t), { pollMs: 5 })
const write = (name) => ({ name, mode: "write" })
const owner = () => ({ pid: process.pid, host: hostname(), nonce: "replacement-owner", since: new Date().toISOString() })

test("a feed contender's failed setup cannot clean documents or release the owner's turn", async (t) => {
  const root = await directory(t)
  const locks = new ResourceLocks(root, { pollMs: 5 })
  const document = join(root, "feed-document")
  const first = new FeedTurn(locks, "test/feed")
  await first.acquire()
  await writeFile(document, "owner's feed")
  const controller = new AbortController()
  const contender = new FeedTurn(new ResourceLocks(root, {
    signal: controller.signal, pollMs: 5,
    log: (line) => { if (line.includes("waiting feed:")) controller.abort() },
  }), "TEST/Feed")
  await assert.rejects(contender.acquire(), { name: "AbortError" })
  await contender.close(() => rm(document))
  assert.equal(await readFile(document, "utf8"), "owner's feed")
  assert.equal(await locks.tryAcquire(write("feed:test/feed")), undefined, "a third runner remains excluded")
  await first.close(() => rm(document))
  await assert.rejects(readFile(document), { code: "ENOENT" })
  await first.close(() => { throw new Error("cleanup cannot run twice") })
  const next = new FeedTurn(locks, "test/feed")
  await next.acquire()
  await assert.rejects(next.close(async () => { throw new Error("feed unavailable") }), /feed unavailable/)
  const lease = await locks.tryAcquire(write("feed:test/feed"))
  assert.ok(lease, "failed cleanup still releases its own lease")
  await lease.release()
})

test("a feed turn refuses to release a replaced owner's nonce", async (t) => {
  const locks = await lockAt(t)
  const turn = new FeedTurn(locks, "test/feed")
  await turn.acquire()
  const path = join(locks.root, `${encodeURIComponent("feed:test/feed")}.lock`)
  const [entry] = await readdir(path)
  await writeFile(join(path, entry, "owner"), JSON.stringify(owner()))
  await assert.rejects(turn.close(async () => {}), /changed owner/)
  assert.equal((await readdir(path)).length, 1)
})
