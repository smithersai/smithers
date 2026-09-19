import { Effect } from "effect"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { dirname } from "node:path"
import { describe, expect, it } from "vitest"
import * as Ownership from "../src/Ownership.ts"
import { run, scratchDirectory } from "./Harness.ts"

/** A process id no host has: the probe answers ESRCH, which is death. */
const deadPid = 2_147_483_647

const record = (directory: string, claim: unknown): void => {
  const path = Ownership.claimPath(directory)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof claim === "string" ? claim : JSON.stringify(claim))
}

describe("Ownership", () => {
  it("names the record beside the store", () => {
    expect(Ownership.claimPath("/repo")).toBe("/repo/.smithers/opencode.server.json")
  })

  it("takes the directory, and gives it back when the server stops", async () => {
    const scratch = scratchDirectory()
    try {
      const mine = await run(
        Effect.scoped(
          Effect.tap(
            Ownership.claim({ directory: scratch.directory, url: "http://127.0.0.1:4096" }),
            () => Effect.sync(() => expect(existsSync(Ownership.claimPath(scratch.directory))).toBe(true))
          )
        )
      )
      expect(mine.owner.pid).toBe(process.pid)
      expect(mine.owner.hostId).toBe(hostname())
      expect(Ownership.read(scratch.directory)).toBeUndefined()
      // A stop and a start is the ordinary case, and it needs no probe.
      await run(Effect.scoped(Ownership.claim({ directory: scratch.directory, url: "http://127.0.0.1:4096" })))
    } finally {
      scratch.remove()
    }
  })

  it("refuses a second server, names the first one, and leaves its record standing", async () => {
    const scratch = scratchDirectory()
    try {
      const refused = await run(
        Effect.scoped(
          Effect.gen(function*() {
            const first = yield* Ownership.claim({ directory: scratch.directory, url: "http://127.0.0.1:4096" })
            const second = yield* Effect.flip(
              Ownership.claim({ directory: scratch.directory, url: "http://127.0.0.1:4097" })
            )
            // The first server's record, not the second's: nothing it holds
            // was taken from it.
            expect(Ownership.read(scratch.directory)?.owner.nonce).toBe(first.owner.nonce)
            return second
          })
        )
      )
      expect(refused).toBeInstanceOf(Ownership.ClaimRefused)
      expect(refused.message).toContain(`process ${process.pid} on ${hostname()} already serves it`)
      expect(refused.message).toContain("http://127.0.0.1:4096")
      expect(refused.message).toContain(Ownership.claimPath(scratch.directory))
      // The refused server released nothing of the first one's: the record
      // went when the first server itself stopped, at the end of the scope.
      expect(existsSync(Ownership.claimPath(scratch.directory))).toBe(false)
    } finally {
      scratch.remove()
    }
  })

  it("replaces the record a killed server left behind", async () => {
    const scratch = scratchDirectory()
    try {
      record(scratch.directory, {
        owner: { hostId: hostname(), pid: deadPid, nonce: "gone" },
        url: "http://127.0.0.1:4096"
      })
      const mine = await run(
        Effect.scoped(
          Effect.tap(
            Ownership.claim({ directory: scratch.directory, url: "http://127.0.0.1:4200" }),
            (claim) => Effect.sync(() => expect(Ownership.read(scratch.directory)?.owner.nonce).toBe(claim.owner.nonce))
          )
        )
      )
      expect(mine.url).toBe("http://127.0.0.1:4200")
    } finally {
      scratch.remove()
    }
  })

  it("refuses a record from another host, whose process it cannot ask about", async () => {
    const scratch = scratchDirectory()
    try {
      record(scratch.directory, { owner: { hostId: "another-host", pid: 1, nonce: "elsewhere" }, url: "http://x:4096" })
      const refused = await run(
        Effect.flip(Effect.scoped(Ownership.claim({ directory: scratch.directory, url: "http://127.0.0.1:4096" })))
      )
      expect(refused.message).toContain("process 1 on another-host already serves it")
      expect(Ownership.read(scratch.directory)?.owner.nonce).toBe("elsewhere")
    } finally {
      scratch.remove()
    }
  })

  it("replaces what is not a record at all", async () => {
    const scratch = scratchDirectory()
    try {
      for (
        const content of [
          "{",
          "null",
          JSON.stringify({ url: "http://127.0.0.1:4096" }),
          JSON.stringify({ owner: { hostId: 1, pid: 1, nonce: "n" }, url: "http://127.0.0.1:4096" }),
          JSON.stringify({ owner: { hostId: "h", pid: "1", nonce: "n" }, url: "http://127.0.0.1:4096" }),
          JSON.stringify({ owner: { hostId: "h", pid: 1, nonce: 1 }, url: "http://127.0.0.1:4096" }),
          JSON.stringify({ owner: { hostId: "h", pid: 1, nonce: "n" } })
        ]
      ) {
        record(scratch.directory, content)
        expect(Ownership.read(scratch.directory)).toBeUndefined()
        const mine = await run(
          Effect.scoped(Ownership.claim({ directory: scratch.directory, url: "http://127.0.0.1:4096" }))
        )
        expect(mine.owner.pid).toBe(process.pid)
      }
      expect(Ownership.read(scratch.directory)).toBeUndefined()
    } finally {
      scratch.remove()
    }
  })

  it("leaves a record another server wrote where it is", async () => {
    const scratch = scratchDirectory()
    const later = { owner: { hostId: hostname(), pid: process.pid, nonce: "later" }, url: "http://127.0.0.1:4096" }
    try {
      await run(
        Effect.scoped(
          Effect.tap(
            Ownership.claim({ directory: scratch.directory, url: "http://127.0.0.1:4096" }),
            () => Effect.sync(() => record(scratch.directory, later))
          )
        )
      )
      expect(JSON.parse(readFileSync(Ownership.claimPath(scratch.directory), "utf8"))).toEqual(later)
    } finally {
      scratch.remove()
    }
  })

  it("reads a claim the caller identifies itself", async () => {
    const scratch = scratchDirectory()
    const owner = { hostId: hostname(), pid: process.pid, nonce: "chosen" }
    try {
      const mine = await run(
        Effect.scoped(Ownership.claim({ directory: scratch.directory, url: "http://127.0.0.1:4096", owner }))
      )
      expect(mine.owner).toEqual(owner)
      expect(Ownership.read(scratch.directory)).toBeUndefined()
    } finally {
      scratch.remove()
    }
  })
})
