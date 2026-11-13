/**
 * What the cache admits as an entry, an output, and an option, and how the
 * local tier reports a publication that cannot complete.
 *
 * Every case runs against a real temporary workspace. Write failures the
 * filesystem cannot produce on demand go through the `io` seam the cache
 * already takes; permission failures use a real read-only file or directory.
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type CachedResult, entryLimit, openCache, outputMemberLimit, sanitizeKey } from "../src/Cache.ts"

let root: string

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-build-cache-entry-"))
})

afterEach(async () => {
  await Fs.chmod(NodePath.join(root, ".flows", "cache", "al"), 0o755).catch(() => undefined)
  await Fs.rm(root, { recursive: true, force: true })
})

const result: CachedResult = {
  key: "alpha",
  target: "Test",
  label: "//:test",
  exitOk: true,
  output: { ok: true },
  storedAt: "2026-08-14T00:00:00.000Z"
}

const entryPath = (key: string): string => NodePath.join(root, ".flows", "cache", key.slice(0, 2), `${key}.json`)
const failing = (message: string, code?: string): Error =>
  code === undefined ? new Error(message) : Object.assign(new Error(message), { code })
const runsAsRoot = process.getuid?.() === 0

/** Stores `output` and reads it back, or reports why the store refused it. */
const roundTrip = async (output: unknown): Promise<unknown> => {
  const cache = await openCache({ workspaceRoot: root })
  await cache.put("alpha", { ...result, output })
  return (await cache.get("alpha"))?.output
}

describe("sanitizeKey", () => {
  it.each([["an empty key", ""], ["a key over 4096 code units", "k".repeat(4097)], ["a non-string", 7]])(
    "refuses %s",
    (_name, key) => {
      expect(() => sanitizeKey(key as string)).toThrow("cache key must contain 1 to 4096 UTF-16 code units")
    }
  )

  it("accepts a key of exactly 4096 code units by hashing it", () => {
    expect(sanitizeKey("k".repeat(4096))).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe("a stored result must name itself in bounded, usable text", () => {
  it.each([
    [
      "a missing output",
      (() => {
        const { output: _output, ...rest } = result
        return rest
      })(),
      "cached result output is required"
    ],
    ["an empty target", { ...result, target: "" }, "cached result target must be bounded non-empty usable text"],
    ["a target over 8192 units", { ...result, target: "t".repeat(8193) }, "target must be bounded"],
    ["a target over 8192 UTF-8 bytes", { ...result, target: "€".repeat(3000) }, "target must be bounded"],
    ["a label ending in a lone high surrogate", { ...result, label: "//:x\ud800" }, "label must be bounded"],
    ["a label with a high surrogate before text", { ...result, label: "\ud800x" }, "label must be bounded"],
    ["a label with a lone low surrogate", { ...result, label: "x\udc00" }, "label must be bounded"],
    ["a label with a high surrogate before a private-use unit", { ...result, label: "\ud800\ue000" }, "label must be"],
    ["a non-boolean exitOk", { ...result, exitOk: "yes" }, "cached result exitOk must be a boolean"],
    ["a non-canonical storedAt", { ...result, storedAt: "2026-08-14" }, "storedAt must be a canonical ISO timestamp"],
    ["an unparseable storedAt", { ...result, storedAt: "yesterday" }, "storedAt must be a canonical ISO timestamp"],
    ["a class instance", new (class Entry {})(), "cached result must be a plain object"],
    ["a Proxy", new Proxy({ ...result }, {}), "cached result must be a plain object"]
  ])("refuses %s before writing", async (_name, entry, message) => {
    const cache = await openCache({ workspaceRoot: root })
    await expect(cache.put("alpha", entry as CachedResult)).rejects.toThrow(message)
    await expect(Fs.stat(entryPath("alpha"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("accepts a well-formed surrogate pair in a label", async () => {
    const cache = await openCache({ workspaceRoot: root })
    await cache.put("alpha", { ...result, label: "//:😀" })
    expect((await cache.get("alpha"))?.label).toBe("//:😀")
  })

  it("stores an explicitly undefined output as null", async () => {
    expect(await roundTrip(undefined)).toBeNull()
  })
})

describe("a stored output must be inert, bounded JSON", () => {
  const nested = (levels: number): unknown => {
    let value: unknown = 0
    for (let level = 0; level < levels; level += 1) value = [value]
    return value
  }

  it("round-trips every JSON string escape class", async () => {
    const text = "\"\\\b\t\n\f\r\u0001 aé€😀\ud800x\ud800\udc00 end\ud800"
    expect(await roundTrip({ text })).toEqual({ text })
  })

  it.each([
    ["two-byte", "é", 2],
    ["three-byte", "€", 3],
    ["escaped control", "\u0001", 6],
    ["surrogate pair", "😀", 4]
  ])("counts a %s character at its encoded size against the entry limit", async (_name, unit, bytes) => {
    const fits = unit.repeat(Math.floor((entryLimit - 2) / bytes) - 256)
    expect(await roundTrip(fits)).toBe(fits)
    await expect(roundTrip(unit.repeat(Math.floor(entryLimit / bytes) + 1))).rejects.toThrow(
      `cached JSON exceeds its ${entryLimit}-byte limit`
    )
  }, 60_000)

  it("refuses a whole entry over the limit after its fields are added", async () => {
    await expect(roundTrip("a".repeat(entryLimit - 2))).rejects.toThrow(
      new RegExp(`^cache entry is \\d+ bytes, exceeding its limit of ${entryLimit}$`)
    )
    await expect(Fs.readdir(NodePath.join(root, ".flows", "cache"))).resolves.toEqual([])
  }, 60_000)

  it("refuses an output nested deeper than the depth limit", async () => {
    await expect(roundTrip(nested(257))).rejects.toThrow("cached JSON is nested deeper than 256 levels")
  })

  it("refuses an array with more members than the member limit", async () => {
    await expect(roundTrip(Array.from({ length: outputMemberLimit + 1 }, () => 0))).rejects.toThrow(
      `cached JSON has more than ${outputMemberLimit} members`
    )
  })

  it("refuses an object whose keys pass the member limit", async () => {
    const output = { a: Array.from({ length: outputMemberLimit - 3 }, () => 0), b: { x: 1, y: 2, z: 3 } }
    await expect(roundTrip(output)).rejects.toThrow(`cached JSON has more than ${outputMemberLimit} members`)
  })

  const accessor = <T extends object>(target: T, key: string): T => {
    Object.defineProperty(target, key, { enumerable: true, get: () => "leaked" })
    return target
  }
  const hidden = <T extends object>(target: T, key: string): T => {
    Object.defineProperty(target, key, { enumerable: false, value: 1 })
    return target
  }

  it.each([
    ["a sparse array", () => [1, , 3], "cached output contains a sparse or extended array"],
    ["an array with an accessor element", () => accessor([0], "0"), "arrays must contain only data entries"],
    ["an array with a hidden element", () => hidden([0], "0"), "arrays must contain only data entries"],
    ["an object with a symbol key", () => ({ [Symbol("s")]: 1 }), "must not contain symbol properties"],
    ["an object with an accessor", () => accessor({}, "a"), "objects must contain only data properties"],
    ["an object with a hidden property", () => hidden({}, "a"), "objects must contain only data properties"],
    ["a class instance", () => ({ value: new (class Holder {})() }), "cached output object must be a plain object"],
    ["a Proxy object", () => ({ value: new Proxy({}, {}) }), "cached output object must be a plain object"],
    ["a function", () => ({ value: () => 1 }), "cached output must be an inert JSON value"],
    ["a negative array length", () =>
      new Proxy([], {
        getOwnPropertyDescriptor: (target, key) =>
          key === "length"
            ? { value: -1, writable: true, enumerable: false, configurable: false }
            : Reflect.getOwnPropertyDescriptor(target, key)
      }), "cached output contains an invalid array"],
    ["a fractional array length", () =>
      new Proxy([], {
        getOwnPropertyDescriptor: (target, key) =>
          key === "length"
            ? { value: 0.5, writable: true, enumerable: false, configurable: false }
            : Reflect.getOwnPropertyDescriptor(target, key)
      }), "cached output contains an invalid array"]
  ])("refuses %s", async (_name, build, message) => {
    await expect(roundTrip(build())).rejects.toThrow(message)
  })
})

describe("cache options are validated before any state is created", () => {
  const refused = async (options: Record<string, unknown>, message: string): Promise<void> => {
    await expect(openCache({ workspaceRoot: root, ...options } as never)).rejects.toThrow(message)
    await expect(Fs.stat(NodePath.join(root, ".flows"))).rejects.toMatchObject({ code: "ENOENT" })
  }

  it.each([
    ["an empty workspaceRoot", { workspaceRoot: "" }],
    ["a workspaceRoot with NUL", { workspaceRoot: "/tmp/a\0b" }],
    ["a workspaceRoot with a lone surrogate", { workspaceRoot: "/tmp/\ud800" }],
    ["a workspaceRoot over 32 KiB", { workspaceRoot: `/${"r".repeat(32 * 1024)}` }],
    ["a workspaceRoot over 32 KiB of UTF-8", { workspaceRoot: `/${"€".repeat(11_000)}` }]
  ])("refuses %s", async (_name, options) => {
    await refused(options, "cache workspaceRoot must be bounded non-empty usable text")
  })

  it.each([
    [{ cacheDirectory: 7 }, "cache cacheDirectory must be a string"],
    [{ cacheDirectory: "a\0b" }, "cache cacheDirectory must be bounded usable text"],
    [{ cacheDirectory: "\udc00" }, "cache cacheDirectory must be bounded usable text"],
    [{ cacheDirectory: "c".repeat(32 * 1024 + 1) }, "cache cacheDirectory must be bounded usable text"],
    [{ readToken: "secret" }, "remote cache readToken must be a function"],
    [{ writeToken: "secret" }, "remote cache writeToken must be a function"],
    [{ fetch: "fetch" }, "remote cache fetch must be a function"],
    [{ warn: "stderr" }, "remote cache warn must be a function"],
    [{ io: { rename: "mv" } }, "cache I/O override rename must be a function"],
    [
      { timeouts: { get: "100", put: 100 } },
      "remote cache get timeout must be an integer from 1 to 300000, received string"
    ]
  ])("refuses %j", async (options, message) => {
    await refused(options, message)
  })

  it("refuses options that are a class instance or a Proxy", async () => {
    await expect(openCache(new (class Options {})() as never)).rejects.toThrow("cache options must be a plain object")
    await expect(openCache(new Proxy({ workspaceRoot: root }, {}))).rejects.toThrow(
      "cache options must be a plain object"
    )
  })

  it("treats a blank endpoint as no remote", async () => {
    let calls = 0
    const cache = await openCache({
      workspaceRoot: root,
      endpoint: "   ",
      fetch: () => {
        calls += 1
        return Promise.resolve(new Response(null, { status: 500 }))
      }
    })
    await cache.put("alpha", result)
    expect(await cache.get("alpha")).toEqual(result)
    expect(calls).toBe(0)
  })
})

describe("local reads and writes report real filesystem refusals", () => {
  it("treats a schema-shaped entry with a non-canonical storedAt as a miss", async () => {
    await Fs.mkdir(NodePath.dirname(entryPath("alpha")), { recursive: true })
    await Fs.writeFile(entryPath("alpha"), JSON.stringify({ ...result, storedAt: "2026-08-14T00:00:00Z" }))
    const cache = await openCache({ workspaceRoot: root })
    expect(await cache.get("alpha")).toBeNull()
  })

  it("propagates a cache directory path that runs through a file", async () => {
    await Fs.writeFile(NodePath.join(root, ".flows"), "not a directory")
    await expect(openCache({ workspaceRoot: root })).rejects.toMatchObject({ code: "ENOTDIR" })
  })

  it("propagates a directory barrier that fails to close after a clean sync", async () => {
    let closes = 0
    const cache = await openCache({
      workspaceRoot: root,
      io: {
        openDirectory: () => Fs.open(NodePath.join(root, "barrier"), "w+"),
        closeHandle: async (handle) => {
          closes += 1
          await handle.close()
          if (closes === 2) throw failing("barrier close lost", "EIO")
        }
      }
    })
    await expect(cache.put("alpha", result)).rejects.toMatchObject({ code: "EIO", message: "barrier close lost" })
    expect(await cache.get("alpha")).toEqual(result)
  })

  it.skipIf(runsAsRoot)("treats an entry it may not open as a miss", async () => {
    const cache = await openCache({ workspaceRoot: root })
    await cache.put("alpha", result)
    await Fs.chmod(entryPath("alpha"), 0o000)
    expect(await cache.get("alpha")).toBeNull()
  })

  it.skipIf(runsAsRoot)("propagates a shard directory that refuses a temporary file", async () => {
    const cache = await openCache({ workspaceRoot: root })
    await Fs.mkdir(NodePath.dirname(entryPath("alpha")), { recursive: true })
    await Fs.chmod(NodePath.dirname(entryPath("alpha")), 0o555)
    await expect(cache.put("alpha", result)).rejects.toMatchObject({ code: "EACCES" })
  })

  it("reports a write failure and the close failure after it, keeping no code it did not have", async () => {
    const cache = await openCache({
      workspaceRoot: root,
      io: {
        writeContents: () => Promise.reject(failing("disk full")),
        closeHandle: async (handle) => {
          await handle.close()
          throw failing("close lost")
        }
      }
    })
    const cause = await cache.put("alpha", result).catch((error: unknown) => error)
    expect(cause).toBeInstanceOf(Error)
    expect((cause as Error).message).toBe("disk full; temporary file close also failed: close lost")
    expect(cause).not.toHaveProperty("code")
    expect(await Fs.readdir(NodePath.dirname(entryPath("alpha")))).toEqual([])
  })

  it("propagates a directory fsync failure that carries no code", async () => {
    let syncs = 0
    const cache = await openCache({
      workspaceRoot: root,
      io: {
        openDirectory: () => Fs.open(NodePath.join(root, "barrier"), "w+"),
        syncHandle: (handle) => {
          syncs += 1
          return syncs === 1 ? handle.sync() : Promise.reject(failing("barrier lost"))
        }
      }
    })
    await expect(cache.put("alpha", result)).rejects.toThrow("barrier lost")
    // The rename happened before the barrier: the entry is readable.
    expect(await cache.get("alpha")).toEqual(result)
  })
})

describe("local reads and temp names survive concurrent writers", () => {
  // A second writer of the same key publishes by renaming identical bytes
  // onto the entry path. The seams run that writer at the exact step under
  // test, so each interleaving is deterministic.
  const republish = async (key: string): Promise<void> => {
    const next = `${entryPath(key)}.next`
    await Fs.writeFile(next, await Fs.readFile(entryPath(key)))
    await Fs.rename(next, entryPath(key))
  }

  /** Republishes before the chosen descriptor stats: 1 after open, 2 after the read. */
  const racingStats = (key: string, when: (stat: 1 | 2, attempt: number) => boolean) => {
    const seen = new Map<Fs.FileHandle, 1 | 2>()
    const calls: Array<1 | 2> = []
    const statHandle = async (handle: Fs.FileHandle) => {
      const stat = seen.has(handle) ? 2 : 1
      seen.set(handle, stat)
      calls.push(stat)
      if (when(stat, seen.size)) await republish(key)
      return handle.stat({ bigint: true })
    }
    return { calls, statHandle }
  }

  const stored = async (): Promise<void> => {
    const cache = await openCache({ workspaceRoot: root })
    await cache.put("alpha", result)
  }

  it("rereads an entry republished between its lstat and open", async () => {
    await stored()
    const race = racingStats("alpha", (stat, attempt) => stat === 1 && attempt === 1)
    const cache = await openCache({ workspaceRoot: root, io: { statHandle: race.statHandle } })
    expect(await cache.get("alpha")).toEqual(result)
    // The first descriptor named the replaced file and was refused before any
    // read; the second named the new entry and was read and rechecked.
    expect(race.calls).toEqual([1, 1, 2])
  })

  it("misses an entry replaced after every open, after three attempts", async () => {
    await stored()
    const race = racingStats("alpha", (stat) => stat === 1)
    const cache = await openCache({ workspaceRoot: root, io: { statHandle: race.statHandle } })
    expect(await cache.get("alpha")).toBeNull()
    expect(race.calls).toEqual([1, 1, 1])
    expect(await (await openCache({ workspaceRoot: root })).get("alpha")).toEqual(result)
  })

  it("misses an entry replaced during every read instead of trusting the stale bytes", async () => {
    await stored()
    const race = racingStats("alpha", (stat) => stat === 2)
    const cache = await openCache({ workspaceRoot: root, io: { statHandle: race.statHandle } })
    expect(await cache.get("alpha")).toBeNull()
    expect(race.calls).toEqual([1, 2, 1, 2, 1, 2])
  })

  it("misses an entry whose read descriptor cannot be closed", async () => {
    await stored()
    let closes = 0
    const cache = await openCache({
      workspaceRoot: root,
      io: {
        closeHandle: async (handle) => {
          closes += 1
          await handle.close()
          throw failing("close lost", "EIO")
        }
      }
    })
    expect(await cache.get("alpha")).toBeNull()
    expect(closes).toBe(3)
    expect(await (await openCache({ workspaceRoot: root })).get("alpha")).toEqual(result)
  })

  it("draws a fresh temporary name when one is already taken", async () => {
    const names: Array<string> = []
    const cache = await openCache({
      workspaceRoot: root,
      io: {
        openTemp: (temp) => {
          names.push(temp)
          return names.length < 3 ? Promise.reject(failing("taken", "EEXIST")) : Fs.open(temp, "wx")
        }
      }
    })
    await cache.put("alpha", result)
    expect(new Set(names).size).toBe(3)
    expect(await cache.get("alpha")).toEqual(result)
    expect(await Fs.readdir(NodePath.dirname(entryPath("alpha")))).toEqual(["alpha.json"])
  })

  it("refuses to publish once four temporary names are taken", async () => {
    const names: Array<string> = []
    const cache = await openCache({
      workspaceRoot: root,
      io: {
        openTemp: (temp) => {
          names.push(temp)
          return Promise.reject(failing("taken", "EEXIST"))
        }
      }
    })
    await expect(cache.put("alpha", result)).rejects.toThrow(
      `could not create a unique temporary file in ${NodePath.dirname(entryPath("alpha"))}`
    )
    expect(new Set(names).size).toBe(4)
    expect(await Fs.readdir(NodePath.dirname(entryPath("alpha")))).toEqual([])
  })
})
