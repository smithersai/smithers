/** Host-local durable job handles and collection receipts; values contain no credentials. */
import { Effect, Layer, Schema } from "effect"
import { KeyValueStore } from "effect/persistence"
import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import { dirname, join, resolve } from "node:path"

const legacyName = (key: string) => `${createHash("sha256").update(key).digest("hex")}.json`
const receiptName = (key: string) => legacyName(key).replace(/\.json$/, ".receipt.json")
const isReceipt = (name: string) => /^[a-f0-9]{64}(?:\.receipt)?\.json$/.test(name)
const missing = (cause: unknown) => (cause as NodeJS.ErrnoException).code === "ENOENT"

// Effect 4.1 enumerates original keys. Keep them atomically with each value;
// legacy raw values remain readable through get and the value-only recovery API.
const Receipt = Schema.Struct({ receiptVersion: Schema.Literal(1), key: Schema.String, value: Schema.String })
const decodeReceipt = Schema.decodeUnknownOption(Schema.fromJsonString(Receipt))
const receiptValue = (text: string): string => {
  const decoded = decodeReceipt(text)
  if (decoded._tag === "None") throw new Error("Invalid versioned receipt")
  return decoded.value.value
}

// Distinct filenames make the format unambiguous even when a legacy raw value
// happens to look exactly like the new envelope. Prefer a published new value
// if a crash left its old filename beside it.
const receiptFiles = (names: ReadonlyArray<string>): ReadonlyArray<string> => {
  const found = new Map<string, string>()
  for (const name of names.filter(isReceipt)) {
    const digest = name.slice(0, 64)
    if (!found.has(digest) || name.endsWith(".receipt.json")) found.set(digest, name)
  }
  return [...found.values()].sort()
}

/** Fsync both file contents and the directory entry that publishes or removes them. */
const syncDirectory = async (directory: string) => {
  const handle = await fs.open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export const make = (directory: string) =>
  Effect.gen(function*() {
    const operation = <A>(method: string, key: string | undefined, run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) =>
          new KeyValueStore.KeyValueStoreError({
            method,
            ...(key === undefined ? {} : { key }),
            message: `Job receipt ${method} failed`,
            cause
          })
      })
    yield* operation("initialize", undefined, async () => {
      const created = await fs.mkdir(directory, { recursive: true })
      if (created === undefined) return
      const parent = dirname(resolve(created))
      let current = resolve(directory)
      for (;;) {
        await syncDirectory(current)
        if (current === parent) break
        current = dirname(current)
      }
    })
    return KeyValueStore.makeStringOnly({
      get: (key) =>
        operation("get", key, async () => {
          try {
            return receiptValue(await fs.readFile(join(directory, receiptName(key)), "utf8"))
          } catch (cause) {
            if (!missing(cause)) throw cause
            try {
              return await fs.readFile(join(directory, legacyName(key)), "utf8")
            } catch (legacyCause) {
              if (missing(legacyCause)) return undefined
              throw legacyCause
            }
          }
        }),
      set: (key, value) =>
        operation("set", key, async () => {
          const temporary = join(directory, `.${receiptName(key)}.${randomUUID()}.tmp`)
          try {
            const file = await fs.open(temporary, "wx", 0o600)
            try {
              await file.writeFile(JSON.stringify({ receiptVersion: 1, key, value }), "utf8")
              await file.sync()
            } finally {
              await file.close()
            }
            await fs.rename(temporary, join(directory, receiptName(key)))
            await fs.unlink(join(directory, legacyName(key))).catch((cause: unknown) => {
              if (!missing(cause)) throw cause
            })
            await syncDirectory(directory)
          } finally {
            await fs.unlink(temporary).catch((cause: unknown) => {
              if (!missing(cause)) throw cause
            })
          }
        }).pipe(Effect.uninterruptible),
      remove: (key) =>
        operation("remove", key, async () => {
          for (const name of [receiptName(key), legacyName(key)]) {
            await fs.unlink(join(directory, name)).catch((cause: unknown) => {
              if (!missing(cause)) throw cause
            })
          }
          await syncDirectory(directory)
        }).pipe(Effect.uninterruptible),
      clear: operation("clear", undefined, async () => {
        for (const name of await fs.readdir(directory)) {
          if (isReceipt(name)) await fs.unlink(join(directory, name))
        }
        await syncDirectory(directory)
      }).pipe(Effect.uninterruptible),
      keys: operation("keys", undefined, async () => {
        const names = receiptFiles(await fs.readdir(directory))
        const keys: Array<string> = []
        for (const name of names) {
          if (!name.endsWith(".receipt.json")) {
            throw new Error("Legacy receipt keys cannot be recovered from hashed filenames")
          }
          const decoded = decodeReceipt(await fs.readFile(join(directory, name), "utf8"))
          if (decoded._tag === "None") throw new Error("Legacy receipt keys cannot be recovered from hashed filenames")
          keys.push(decoded.value.key)
        }
        return keys
      }),
      size: operation("size", undefined, async () => receiptFiles(await fs.readdir(directory)).length)
    })
  })

/** All sweep hosts in this checkout share the same receipt directory. */
export const layer = (repository: string) =>
  Layer.effect(KeyValueStore.KeyValueStore)(make(join(repository, ".flows", "issue-sweep-jobs")))

/** Rebuild account holds before admitting work on a newly started host. */
export const values = (repository: string) =>
  Effect.tryPromise({
    try: async () => {
      const directory = join(repository, ".flows", "issue-sweep-jobs")
      let names: ReadonlyArray<string>
      try {
        names = await fs.readdir(directory)
      } catch (cause) {
        if (missing(cause)) return []
        throw cause
      }
      const values: Array<string> = []
      for (const name of receiptFiles(names)) {
        try {
          const text = await fs.readFile(join(directory, name), "utf8")
          values.push(name.endsWith(".receipt.json") ? receiptValue(text) : text)
        } catch (cause) {
          // Another host can finish and remove a receipt after the listing.
          if (!missing(cause)) throw cause
        }
      }
      return values
    },
    catch: (cause) =>
      new KeyValueStore.KeyValueStoreError({ method: "values", message: "Job receipts could not be read", cause })
  })

export const Assignment = Schema.Struct({
  key: Schema.String,
  agent: Schema.Literals(["codex", "claude"]),
  account: Schema.String
})

/** Reestablish parked jobs' account holds before any new reservation. */
export const restoreAssignments = (
  repository: string,
  restore: (key: string, agent: "codex" | "claude", account: string) => void
) =>
  Effect.gen(function*() {
    for (const value of yield* values(repository)) {
      const assigned = Schema.decodeUnknownOption(Schema.fromJsonString(Assignment))(value)
      if (assigned._tag === "Some") restore(assigned.value.key, assigned.value.agent, assigned.value.account)
    }
  })
