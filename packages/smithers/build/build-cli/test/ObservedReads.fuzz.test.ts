import * as A from "effect/Arbitrary"
import * as Effect from "effect/Effect"
import * as S from "effect/Schema"
import { createHash } from "node:crypto"
import type { Stats } from "node:fs"
import { posix } from "node:path"
import { describe, expect, it } from "vitest"
import * as Reads from "../src/internal/ObservedReads.ts"

const root = "/work"
const read = (lines: readonly string[]) => Reads.read(() => lines, root)
const header = "1 +++ smthrs-observe 1 +++"
const seal = "1 +++ complete +++"

const property = <T>(arb: A.Arbitrary<T>, seed: number, verify: (value: T) => void) => async () => {
  const result = await Effect.runPromise(A.checkEffect(arb, (value) =>
    Effect.try({
      try: () => {
        verify(value)
        return true
      },
      catch: (error) => String(error)
    }), { seed, runs: 180 }))
  if (result._tag !== "Passed") throw new Error(A.formatCheckFailure(result))
}

const pick = <const T extends ReadonlyArray<string | number>>(values: T) => A.schema(S.Literals(values))
const boundedInt = (max: number) => A.schema(S.Int.check(S.isBetween({ minimum: 0, maximum: max })))
const text = A.schema(S.String)
const name = A.map(
  A.array(pick(["a", "é", "(", ")", ",", " ", "\"", "\\", "7", "猫"]), { maxLength: 12 }),
  (parts) => "f" + parts.join("")
)
const asciiName = A.map(A.array(pick(["a", "b", "c", "1"]), { maxLength: 10 }), (s) => "f" + s.join(""))
const octets = (s: string, base: number) =>
  "\"" + Array.from(Buffer.from(s), (b) =>
    base === 8 ? "\\" + b.toString(8).padStart(3, "0") : "\\x" + b.toString(16).padStart(2, "0")).join("") +
  "\""
const open = (path: string, answer = "3") => `1 openat(AT_FDCWD, ${JSON.stringify(path)}, O_RDONLY) = ${answer}`

describe("trace decoding", () => {
  it(
    "decodes raw, octal and hex UTF-8 names to the same read in both formats",
    property(name, 7001, (file) => {
      for (const encoded of [JSON.stringify(file), octets(file, 8), octets(file, 16)]) {
        const call = `1 openat(AT_FDCWD, ${encoded}, O_RDONLY) = 3`
        for (const lines of [[call], [header, call, seal]]) {
          const trace = read(lines)
          expect(trace.refusals).toEqual([])
          expect([...trace.found.keys()]).toEqual([`${root}/${file}`])
        }
      }
    })
  )

  it(
    "keeps interrupted reads with their PID and follows shared or copied working directories",
    property(
      A.all({
        child: boundedInt(999),
        file: name,
        spawn: pick(["fork()", "vfork()", "clone(flags=CLONE_FS)", "clone(flags=SIGCHLD)"])
      }),
      7002,
      ({ child, file, spawn }) => {
        const pid = child + 2
        const dir = root + "/child"
        const shared = spawn.includes("CLONE_FS")
        const trace = read([
          `1 ${spawn} = ${pid}`,
          `${pid} fchdir(6<${dir}>) = 0`,
          `1 openat(AT_FDCWD, "parent", O_RDONLY <unfinished ...>`,
          `${pid} openat(AT_FDCWD, ${JSON.stringify(file)}, O_RDONLY <unfinished ...>`,
          "1 <... openat resumed>) = 4",
          `${pid} <... openat resumed>) = 5`,
          `${pid} chdir("sub") = 0`,
          `${pid} execve("tool", ["tool"], []) = 0`
        ])
        expect(trace.refusals).toEqual([])
        expect([...trace.found]).toEqual([
          [`${shared ? dir : root}/parent`, 3],
          [`${dir}/${file}`, 4],
          [dir + "/sub", 7],
          [dir + "/sub/tool", 8]
        ])
        expect([...trace.started.keys()]).toEqual([dir + "/sub/tool"])
      }
    )
  )

  it(
    "parses generated fragments deterministically and preserves explicit loss markers",
    property(
      A.all({
        lines: A.array(text, { maxLength: 7 }),
        cut: boundedInt(96),
        file: name,
        template: pick(["openat", "getxattr", "execve", "linkat", "clone3", "openat2", "resume"])
      }),
      7003,
      ({ lines, cut, file, template }) => {
        const path = JSON.stringify(file)
        const calls = {
          openat: open(file),
          getxattr: `1 getxattr(${path}, "user.note", "x", 1) = 1`,
          execve: `1 execve(${path}, ["a,b", "c)"], []) = 0`,
          linkat: `2 linkat(3</work/f>, "", AT_FDCWD, ${path}, AT_EMPTY_PATH) = 0`,
          clone3: "1 clone3({flags=CLONE_FS}, 88) = 2",
          openat2: `1 openat2(AT_FDCWD, ${path}, {flags=O_RDONLY, resolve=RESOLVE_IN_ROOT}, 24) = 3`,
          resume: "2 <... openat resumed>) = 3"
        }
        const parts = [calls[template].slice(0, cut), ...lines]
        for (const framed of [parts, [header, ...parts, seal]]) expect(read(framed)).toEqual(read([...framed]))
        expect(read([header, ...parts, "1 +++ unrecorded: lost event +++", seal]).refusals).toContain("lost event")
        expect(read([header, open(file)]).refusals).toContain("its trace was cut short")
      }
    )
  )

  it(
    "refuses unrecordable operations in either format and distinguishes an unavailable ring",
    property(
      A.all({ file: asciiName, fd: pick(["-7", "3", "900719925474099312345"]) }),
      7004,
      ({ file, fd }) => {
        const calls = [
          `1 openat(${fd}, "${file}", O_RDONLY) = 4`,
          "1 syscall_0xffff(0) = 0",
          "1 io_uring_setup(8, {}) = 3",
          "1 io_uring_enter(3, 1, 0, 0, NULL, 0) = 1",
          "1 io_uring_register(3, 0, NULL, 0) = 0",
          "1 <... openat resumed>) = 3",
          `1 openat(AT_FDCWD, "${file}"..., O_RDONLY) = 3`,
          `1 openat2(AT_FDCWD, "${file}", {flags=O_RDONLY, resolve=0x80000000}, 24) = 3`
        ]
        for (const call of calls) {
          for (const lines of [[call], [header, call, seal]]) {
            const trace = read(lines)
            expect(trace.refusals.length, call).toBeGreaterThan(0)
            expect(Reads.observe(trace, { root, ignore: [], startedMs: 10 })).toHaveProperty(
              "refusal",
              trace.refusals[0]
            )
          }
        }
        const denied = read(["1 io_uring_setup(8, {}) = -1 ENOSYS"])
        expect(denied.ringAsked).toBe(true)
        expect(denied.refusals).toEqual([])
      }
    )
  )

  it(
    "retains both exchange operands, the existing destination and the source of a descriptor link",
    property(
      asciiName,
      7005,
      (file) => {
        const first = root + "/" + file
        const last = root + "/dest"
        for (const [flag, answer] of [["RENAME_EXCHANGE", "0"], ["RENAME_NOREPLACE", "-1 EEXIST"]]) {
          const trace = read([`1 renameat2(AT_FDCWD, "${file}", AT_FDCWD, "dest", ${flag}) = ${answer}`])
          expect(trace.refusals).toEqual([])
          expect([...trace.found.keys()]).toEqual([first, last])
          if (answer === "0") {
            expect(trace.exchanged).toEqual([[first, last]])
            expect([...trace.changed]).toEqual([first, last])
          } else expect(trace.changed.size).toBe(0)
        }
        const trace = read([`1 linkat(3<${first}>, "", AT_FDCWD, "dest", AT_EMPTY_PATH) = 0`])
        expect(trace.refusals).toEqual([])
        expect([...trace.found.keys()]).toEqual([first])
        expect([...trace.made.keys()]).toEqual([last])
      }
    )
  )

  // Expected failures exercise the desired contract and turn red when the production fix lands.
  it.fails("refuses a successful unknown named call", () => {
    expect(read(["1 unknown_read(\"/work/f\") = 0"]).refusals.length).toBeGreaterThan(0)
  })

  it.fails("refuses a successful open whose trace omits the pathname", () => {
    expect(read(["1 openat() = 3"]).refusals.length).toBeGreaterThan(0)
  })

  it.fails("rejects a resume for the wrong syscall on the same PID", () => {
    expect(read(["1 openat(AT_FDCWD, \"f\", O_RDONLY <unfinished ...>", "1 <... stat resumed>) = 3"]).refusals.length)
      .toBeGreaterThan(0)
  })

  it.fails("keeps an unescaped supplementary character beside an escape", () => {
    expect([...read([open("😀\"")]).found.keys()]).toEqual(["/work/😀\""])
  })
})

type Node =
  | { kind: "file"; data: string; mode: number; nlink: number }
  | { kind: "directory" }
  | { kind: "link"; target: string }
const directory = { kind: "directory" } as const
const file = (data: string, mode = 0o644, nlink = 1): Node => ({ kind: "file", data, mode, nlink })
const link = (target: string): Node => ({ kind: "link", target })
function fail(code: string): never {
  throw Object.assign(new Error(code), { code })
}

// lstat/readlink preserve the final link. Other operations follow it, including absolute and relative targets.
class MemoryFs implements Reads.Io {
  readonly nodes = new Map<string, Node>([["/", directory], [root, directory]])
  private lookup(input: string, follow: boolean) {
    let path = "/"
    let node: Node = directory
    let hops = 0
    const queue = input.split("/").filter(Boolean)
    while (queue.length > 0) {
      if (node.kind !== "directory") fail("ENOTDIR")
      const part = queue.shift()!
      if (part === ".") continue
      path = part === ".." ? posix.dirname(path) : posix.join(path, part)
      node = this.nodes.get(path) ?? fail("ENOENT")
      if (node.kind === "link" && (follow || queue.length > 0)) {
        if (++hops > 40) fail("ELOOP")
        queue.unshift(...node.target.split("/").filter(Boolean))
        path = node.target.startsWith("/") ? "/" : posix.dirname(path)
        node = this.nodes.get(path)!
      }
    }
    return { node, path }
  }

  lstat = (path: string): Stats => {
    const { node } = this.lookup(path, false)
    // Io exposes fs.Stats. Supply the fields that an observation can use, all from the virtual tree.
    return {
      dev: 1,
      ino: [...this.nodes.keys()].indexOf(path) + 1,
      ctimeMs: 1,
      mtimeMs: 1,
      mode: node.kind === "file" ? 0o100000 | node.mode : node.kind === "link" ? 0o120777 : 0o40755,
      nlink: node.kind === "file" ? node.nlink : 1,
      size: node.kind === "file" ? Buffer.byteLength(node.data) : 0,
      isFile: () => node.kind === "file",
      isDirectory: () => node.kind === "directory",
      isSymbolicLink: () => node.kind === "link"
    } as Stats
  }
  readlink = (path: string) => {
    const { node } = this.lookup(path, false)
    return node.kind === "link" ? node.target : fail("EINVAL")
  }
  readdir = (input: string) => {
    const { node, path } = this.lookup(input, true)
    if (node.kind !== "directory") fail("ENOTDIR")
    return [...this.nodes.keys()].filter((key) => key !== path && posix.dirname(key) === path).map((key) =>
      posix.basename(key)
    )
  }
  readFile = (path: string) => {
    const { node } = this.lookup(path, true)
    if (node.kind !== "file") fail("EISDIR")
    if (!(node.mode & 0o400)) fail("EACCES")
    return Buffer.from(node.data)
  }
  head = (path: string, length: number) => this.readFile(path).subarray(0, length)
}

const capture = (io: MemoryFs, lines: readonly string[], values: Reads.Variables["values"] = {}) =>
  Reads.observe(read(lines), {
    root,
    io,
    startedMs: 10,
    ignore: [],
    held: () => new Set(),
    variables: { text: "$BUILD_VALUE", values, ignored: () => new Set() }
  })
const accepted = (observation: ReturnType<typeof capture>) => {
  if ("refusal" in observation) throw new Error(observation.refusal)
  return observation.record
}
const check = (io: MemoryFs, record: Reads.Record, values: Reads.Variables["values"] = {}) =>
  Reads.changed(
    record,
    root,
    (path) => Reads.measure(path, io),
    io,
    undefined,
    values,
    undefined,
    undefined,
    () => new Set()
  )
const world = A.all({
  leaf: name,
  data: text,
  value: text,
  mode: pick([0o400, 0o644, 0o755]),
  hops: boundedInt(8),
  entries: A.array(name, { maxLength: 8 }),
  absolute: A.schema(S.Boolean)
})

const checkLinks = (fs: MemoryFs, leaf: string, length: number) => {
  for (let i = 0; i < length; i++) fs.nodes.set(root + "/s" + i, link(i + 1 === length ? leaf : "s" + (i + 1)))
  const straight = capture(fs, [open("s0", length > 40 ? "-1 ELOOP" : "3")])
  if (length <= 40) {
    const stored = accepted(straight)
    expect(stored.reads).toHaveLength(length + 1)
    expect(check(fs, stored)).toBeUndefined()
  } else expect(straight).toEqual({ refusal: root + "/s0 passes through too many symbolic links" })
  fs.nodes.set(root + "/s" + (length - 1), link("s0"))
  expect(capture(fs, [open("s0", "-1 ELOOP")])).toEqual({
    refusal: root + "/s0 passes through too many symbolic links"
  })
}

describe("observing a virtual filesystem", () => {
  it(
    "hits on replay and after unrelated edits, then misses on each independent input change",
    property(
      world,
      7101,
      ({ leaf, data, value, mode, hops, entries, absolute }) => {
        const fs = new MemoryFs()
        const real = root + "/data/" + leaf
        const listed = root + "/list"
        const input = file(data, mode)
        fs.nodes.set(root + "/data", directory)
        fs.nodes.set(real, input)
        fs.nodes.set(listed, directory)
        for (const entry of [...entries, "old"]) fs.nodes.set(listed + "/" + entry, file(""))
        let entry = "data/" + leaf
        for (let i = 0; i < hops; ++i) {
          const alias = "alias" + i
          fs.nodes.set(root + "/" + alias, link(absolute ? root + "/" + entry : entry))
          entry = alias
        }
        const values = { BUILD_VALUE: value }
        const observation = accepted(capture(fs, [
          open(entry),
          open("missing", "-1 ENOENT"),
          `1 getdents64(3<${listed}>, [], 4096) = 64`
        ], values))
        const record = Reads.asRecord(JSON.parse(JSON.stringify(observation)))
        expect(record).toBeDefined()
        expect(record!.id).toBe(Reads.idOf(observation))
        expect(record!.variables).toEqual([["BUILD_VALUE", createHash("sha256").update(value).digest("hex")]])
        expect(check(fs, record!, values)).toBeUndefined()
        fs.nodes.set(root + "/unread", file("noise"))
        expect(check(fs, record!, values)).toBeUndefined()
        for (
          const next of [
            file(data + "x", mode),
            directory,
            link("elsewhere"),
            undefined,
            file(data, mode ^ 0o111),
            file(data, 0)
          ]
        ) {
          if (next) fs.nodes.set(real, next)
          else fs.nodes.delete(real)
          expect(check(fs, record!, values)).toBeDefined()
          fs.nodes.set(real, input)
        }
        if (hops > 0) {
          const alias = root + "/" + entry
          const before = fs.nodes.get(alias)!
          fs.nodes.set(alias, link("unread"))
          expect(check(fs, record!, values)).toBeDefined()
          fs.nodes.set(alias, before)
        }
        for (const [path, next] of [[root + "/missing", file("")], [listed + "/new", file("")]] as const) {
          fs.nodes.set(path, next)
          expect(check(fs, record!, values)).toBeDefined()
          fs.nodes.delete(path)
        }
        fs.nodes.delete(listed + "/old")
        expect(check(fs, record!, values)).toBeDefined()
        fs.nodes.set(listed + "/old", file("new bytes, same entry"))
        expect(check(fs, record!, values)).toBeUndefined()
        for (const changed of [value + "x", undefined]) {
          expect(check(fs, record!, { BUILD_VALUE: changed })).toBe("the variable BUILD_VALUE has another value")
        }
      }
    )
  )

  it(
    "records the target of a constrained open and refuses loops at the kernel link limit",
    property(
      A.all({
        count: boundedInt(50),
        leaf: asciiName,
        flag: pick(["RESOLVE_IN_ROOT", "RESOLVE_BENEATH", "RESOLVE_NO_SYMLINKS"])
      }),
      7102,
      ({ count, leaf, flag }) => {
        const fs = new MemoryFs()
        const target = root + "/" + leaf
        fs.nodes.set(target, file("before"))
        const named = flag === "RESOLVE_IN_ROOT" ? "/" + leaf : leaf
        const walk = `1 openat2(3<${root}>, "${named}", {flags=O_RDONLY, resolve=${flag}}, 24) = 5<${target}>`
        const record = accepted(capture(fs, [walk]))
        expect(check(fs, record)).toBeUndefined()
        fs.nodes.set(target, file("after"))
        expect(check(fs, record)).toBe(leaf + " changed")

        checkLinks(fs, leaf, count + 1)
      }
    )
  )

  it("checks one- and two-link cycles and chains of exactly 40, 41 and 50 hops", () => {
    for (const length of [1, 2, 40, 41, 50]) {
      const fs = new MemoryFs()
      fs.nodes.set(root + "/leaf", file(""))
      checkLinks(fs, "leaf", length)
    }
  })

  it(
    "distinguishes xattr lookups that follow a link from lookups on the link itself",
    property(
      name,
      7104,
      (leaf) => {
        const argument = JSON.stringify(leaf)
        for (const call of ["getxattr", "lgetxattr", "listxattr", "llistxattr"]) {
          const args = call.includes("get") ? "\"user.note\", \"x\", 1" : "\"user.note\", 10"
          const trace = read([`1 ${call}(${argument}, ${args}) = ${call.includes("get") ? 1 : 10}`])
          const expected = call === "lgetxattr" || call === "llistxattr" ? trace.unfollowed : trace.found
          // Either the recorder supports this input or explicitly declines it.
          if (trace.refusals.length === 0) expect([...(expected?.keys() ?? [])]).toEqual([root + "/" + leaf])
        }
      }
    )
  )

  it.fails("refuses or invalidates a read whose xattr value changes", () => {
    const fs = new MemoryFs()
    const path = root + "/f"
    fs.nodes.set(path, file(""))
    const xattrs = new Map([[path, new Map([["user.note", "a"]])]])
    const get = () => xattrs.get(path)!.get("user.note")!
    const before = get()
    const result = capture(fs, [`1 getxattr("f", "user.note", "${before}", 1) = 1`])
    xattrs.get(path)!.set("user.note", "b")
    // Io currently exposes only the ordinary bytes and status of this file.
    expect("refusal" in result || (before !== get() && check(fs, result.record) !== undefined)).toBe(true)
  })

  it.fails.each(["mode", "nlink"] as const)("refuses or invalidates stat after a %s-only change", (field) => {
    const fs = new MemoryFs()
    const path = root + "/f"
    fs.nodes.set(path, file("", 0o644, 1))
    const result = capture(fs, ["1 stat(\"f\", {st_mode=S_IFREG|0644, st_nlink=1}) = 0"])
    const after = file("", field === "mode" ? 0o600 : 0o644, field === "nlink" ? 2 : 1)
    fs.nodes.set(path, after)
    if (field === "nlink") fs.nodes.set(root + "/another-name", after)
    expect("refusal" in result || check(fs, result.record) !== undefined).toBe(true)
  })

  it("refuses a successful directory listing that cannot be measured after the run", () => {
    const fs = new MemoryFs()
    fs.nodes.set(root + "/d", directory)
    const list = fs.readdir
    fs.readdir = () => fail("EACCES")
    const result = capture(fs, ["1 getdents64(3</work/d>, [], 4096) = 48"])
    fs.readdir = list
    fs.nodes.set(root + "/d/new", file(""))
    expect("refusal" in result || check(fs, result.record) !== undefined).toBe(true)
  })

  it(
    "measures reads by ownership, workspace and size, stopping at the first mismatch",
    property(
      A.array(boundedInt(8), { minLength: 4, maxLength: 14 }),
      7103,
      (sizes) => {
        const fs = new MemoryFs()
        const rows = sizes.map((size, i) => {
          const name = (i % 3 === 2 ? "/ext" : "f") + i
          const path = name.startsWith("/") ? name : root + "/" + name
          fs.nodes.set(path, file("x".repeat(size)))
          return { name, path, size, tier: i % 3, i }
        })
        const record: Reads.Record = { reads: rows.map(({ name }) => [name, "same"]), lists: [] }
        const owned = new Set(rows.filter((row) => row.tier === 0).map((row) => row.name))
        const order = [...rows].sort((a, b) => a.tier - b.tier || a.size - b.size || a.i - b.i)
        for (const mismatch of [undefined, order[0], order[Math.floor(order.length / 2)], order.at(-1)]) {
          const seen: string[] = []
          const result = Reads.changed(
            record,
            root,
            (path) => {
              seen.push(path)
              return path === mismatch?.path ? "different" : "same"
            },
            fs,
            undefined,
            {},
            (name) => owned.has(name)
          )
          expect(seen).toEqual(
            order.slice(0, mismatch ? order.indexOf(mismatch) + 1 : order.length).map((row) => row.path)
          )
          expect(result).toBe(mismatch ? mismatch.name + " changed" : undefined)
        }
      }
    )
  )
})

const strings = S.Array(S.String)
const pair = S.Tuple([S.String, S.String])
const place = S.Int.check(S.isGreaterThanOrEqualTo(0))
const pairs = S.Array(pair)
const schema = S.Struct({
  id: S.String,
  reads: S.Array(S.Union([pair, S.Tuple([S.String, S.String, S.String])])),
  lists: S.Array(
    S.Union([
      S.Tuple([S.String, S.String, strings]),
      S.Tuple([S.String, S.String, strings, S.Array(S.Tuple([S.String, place]))])
    ])
  ),
  given: S.optional(S.Array(S.Tuple([S.String, S.String, place]))),
  from: S.optional(pairs),
  left: S.optional(S.Literal(true)),
  made: S.optional(strings),
  variables: S.optional(pairs),
  running: S.optional(S.Literal(true)),
  served: S.optional(pairs),
  kept: S.optional(S.Struct({ archive: S.String.check(S.isPattern(/^[0-9a-f]{64}$/)), gone: strings, outside: pairs }))
})
const valid = S.is(schema)
const conforms = (value: unknown) => {
  if (!valid(value)) return false
  const count = value.from?.length ?? 0
  return (value.given ?? []).every(([, , place]) => place < count) &&
    value.lists.every((row) => (row[3] ?? []).every(([, place]) => place < count))
}
const fullRecord = (label: string, path: string): Reads.Record => {
  const body = {
    reads: [[path, "state", "-"]],
    lists: [["dir", "digest", ["own"], [["entry", 0]]]],
    from: [[label, "prior"]],
    given: [[path, "state", 0]],
    left: true,
    made: [path],
    served: [[label, "service"]],
    running: true,
    variables: [["VAR", "-"]],
    kept: { archive: "a".repeat(64), gone: [path], outside: [["/outside", "state"]] }
  } as const
  return { ...body, id: Reads.idOf(body) }
}
const assertDecode = (value: unknown) => {
  const result = Reads.asRecord(value)
  expect(result !== undefined).toBe(conforms(value))
  if (result === undefined) return
  expect(Reads.pathsOf(result)).toBe(result.reads.length + result.lists.length + (result.given?.length ?? 0))
  const restored = Reads.asRecord(JSON.parse(JSON.stringify(result)))
  expect(restored).toEqual(result)
  expect(Reads.idOf(restored!)).toBe(Reads.idOf(result))
  expect(Reads.store(result, [])?.records).toEqual([result])
}

describe("record decoding and bounded history", () => {
  it(
    "agrees with a structural schema on JSON and one-field corruptions of valid records",
    property(
      A.all({
        value: A.schema(S.Json),
        label: text,
        path: name,
        field: pick([
          "reads",
          "lists",
          "id",
          "given",
          "from",
          "made",
          "left",
          "variables",
          "kept",
          "__proto__"
        ])
      }),
      7201,
      ({ value, label, path, field }) => {
        const base = fullRecord(label, path)
        assertDecode(base)
        assertDecode(value)
        assertDecode({ ...base, [field]: value })
        for (const index of [-1, 0.5, 1, "0", null]) {
          assertDecode({ ...base, given: [[path, "state", index]] })
          assertDecode({ ...base, lists: [[path, "", [], [[path, index]]]] })
        }
        for (
          const shape of [
            { reads: [[path]] },
            { reads: [[path, "", "", ""]] },
            { lists: [[path, "", [], [], []]] },
            { kept: { ...base.kept, archive: "G".repeat(64) } },
            { kept: { ...base.kept, archive: "a".repeat(63) } },
            { kept: { ...base.kept, outside: [[path]] } },
            { ["__proto__"]: { served: false } }
          ]
        ) assertDecode({ ...base, ...shape })
      }
    )
  )

  it("checks the persisted running flag", () => {
    assertDecode({ id: "", reads: [], lists: [], running: false })
  })

  it("checks the persisted served tuple array", () => {
    assertDecode({ id: "", reads: [], lists: [], served: 0 })
  })

  it(
    "keeps the most recently inserted distinct IDs and refreshes the payload of a repeated ID",
    property(
      A.array(boundedInt(8), { minLength: 1, maxLength: 25 }),
      7202,
      (ids) => {
        let stored: readonly Reads.Record[] = []
        const input = ids.map((id, i) => {
          const body = { reads: [[String(id), "-"]], lists: [] } as const
          return {
            ...body,
            id: Reads.idOf(body),
            kept: { archive: i.toString(16).padStart(64, "0"), gone: [], outside: [] }
          }
        })
        for (let i = 0; i < input.length; i++) {
          const next = Reads.store(input[i]!, stored)!
          const newest = input.slice(0, i + 1).reverse()
          const expected = [...new Set(newest.map((row) => row.id))].slice(0, Reads.maximumRecords)
            .map((id) => newest.find((row) => row.id === id))
          expect(next).toEqual({ kind: "observed", format: Reads.format, records: expected })
          stored = next.records
        }
      }
    )
  )

  it("applies the inclusive per-record path budget across reads, listings and producer rows", () => {
    const rows = Array<readonly [string, string]>(Reads.maximumPaths - 2).fill(["a", "s"])
    const stored: Reads.Record = {
      reads: rows,
      lists: [["d", "digest", []]],
      from: [["step", "id"]],
      given: [["g", "s", 0]],
      id: "id"
    }
    expect(Reads.pathsOf(stored)).toBe(Reads.maximumPaths)
    expect(Reads.store(stored, [])?.records[0]).toBe(stored)
    expect(Reads.store({ ...stored, given: [...stored.given!, ["h", "s", 0]] }, [])).toBeUndefined()
  })
})
