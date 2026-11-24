import * as Fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as Reads from "../src/internal/ObservedReads.ts"

const directories: Array<string> = []
afterEach(() => {
  for (const name of directories.splice(0)) Fs.rmSync(name, { recursive: true, force: true })
})
const directory = (): string => {
  const root = Fs.realpathSync(Fs.mkdtempSync(join(tmpdir(), "observed-record-")))
  directories.push(root)
  return root
}

describe("retained trace bytes", () => {
  it("keeps exactly the acknowledged range even when a following line has been appended", async () => {
    const root = directory()
    const file = join(root, "trace")
    const whole = "é".repeat(40_000)
    Fs.writeFileSync(file, `own\n${whole}\n`)
    const kept = Reads.keptStep("//:serve", "id", root, file, false, 4)
    expect(await kept.flush()).toBe(true)
    Fs.appendFileSync(file, "following\n")
    expect([...kept.step()]).toEqual(["own"])
    expect([...kept.after()]).toEqual([whole])
    expect([...Reads.wholeLinesOf(file, 4)()]).toEqual([whole, "following"])
  })

  it("refuses a truncated or replaced continuation even when the replacement has the same bytes", async () => {
    const root = directory()
    const file = join(root, "trace")
    const kept = Reads.keptStep("//:serve", "id", root, file, false, 4)
    Fs.writeFileSync(file, "own\nfollowed\n")
    expect(await kept.flush()).toBe(true)
    Fs.truncateSync(file, 3)
    expect(() => [...kept.after()]).toThrow("trace was truncated")

    Fs.writeFileSync(file, "own\nfollowed\n")
    expect(await kept.flush()).toBe(true)
    Fs.renameSync(file, `${file}.old`)
    Fs.writeFileSync(file, "own\nfollowed\n")
    expect(() => [...kept.after()]).toThrow("trace file was replaced")
  })

  it("reports a truncation between reads while a caller has the first line", () => {
    const root = directory()
    const file = join(root, "trace")
    Fs.writeFileSync(file, `first\n${"more\n".repeat(20_000)}`)
    const iterator = Reads.wholeLinesOf(file)()[Symbol.iterator]()
    expect(iterator.next()).toEqual({ value: "first", done: false })
    Fs.truncateSync(file, 0)
    // Finish the bytes already read before the iterator asks the file for its next block.
    expect(() => {
      while (!iterator.next().done) {}
    }).toThrow("trace was truncated during the read")
  })

  it("rejects required paths that are missing, directories, or end inside a line", async () => {
    const root = directory()
    const file = join(root, "trace")
    const kept = Reads.keptStep("//:serve", "id", root, file, true)
    expect(() => [...kept.step()]).toThrow(/ENOENT/)
    expect(() => [...Reads.wholeLinesOf(join(root, "missing", "trace"))()]).not.toThrow()
    Fs.mkdirSync(file)
    expect(() => [...Reads.wholeLinesOf(file)()]).toThrow("trace is not a regular file")
    Fs.rmdirSync(file)
    Fs.writeFileSync(file, "whole\npartial")
    expect(() => [...kept.step()]).toThrow("trace ends inside a line")
    expect([...Reads.wholeLinesOf(file)()]).toEqual(["whole"])
    expect(() => [...Reads.wholeLinesOf(join(file, "child"))()]).toThrow(/ENOTDIR/)
    const cut = Reads.keptStep("//:serve", "id", root, file, false, 20)
    expect(() => [...cut.after()]).toThrow("trace was truncated")

    const unsealed = Reads.keptStep("//:serve", "id", root, join(root, "missing"), false)
    expect(await unsealed.flush()).toBe(false)
    expect(() => [...unsealed.after()]).toThrow(/ENOENT/)
  })
})

describe("recorded input identity", () => {
  const record = (root: string, lines: ReadonlyArray<string>) =>
    Reads.record(Reads.read(() => lines, root), { root, ignore: [], startedMs: Infinity, held: () => new Set() })

  it("records an ordinary read beside an overlong name and pseudo-filesystem metadata", () => {
    const root = directory()
    const file = join(root, "source")
    Fs.writeFileSync(file, "data")
    const trace = Reads.read(() => [
      "10 openat(AT_FDCWD, \"overlong\"..., O_RDONLY) = -1 ENAMETOOLONG (File name too long)",
      "10 openat(AT_FDCWD, \"source\", O_RDONLY) = 3"
    ], root)
    const result = Reads.record({ ...trace, meta: new Set(["/proc/self/status"]) }, {
      root,
      ignore: [],
      startedMs: Infinity
    })
    expect(result).toMatchObject({ reads: [["source", Reads.measure(file)]], lists: [] })
  })

  it("returns the outside peer reason to the caller that requested a record", () => {
    const root = directory()
    const trace = Reads.read(() => ["10 connect(3, {sa_family=AF_UNIX, sun_path=\"peer\"}, 16) = 0"], root)
    const reason = "it reached a program outside the run through the socket \"peer\""
    expect(trace.outside).toEqual([reason])
    expect(Reads.observe(trace, { root, ignore: [], startedMs: Infinity })).toEqual({
      refusal: reason,
      outside: reason
    })
  })

  it("requires a prior regularly read file to be the one vouched for by the opened descriptor", () => {
    const root = directory()
    const file = join(root, "source")
    const other = join(root, "other")
    Fs.writeFileSync(file, "input")
    Fs.writeFileSync(other, "input")
    expect(record(root, [`10 openat(AT_FDCWD, "source", O_RDONLY) = 3<${other}>`])).toEqual({
      refusal: `its trace does not say where ${file} led`
    })
    const observed = record(root, [`10 openat(AT_FDCWD, "source", O_RDONLY) = 3<${file}>`])
    expect(observed).toMatchObject({ reads: [["source", Reads.measure(file)]] })
  })

  it("accounts for the endpoint of a workspace alias to a process descriptor", () => {
    const root = directory()
    const file = join(root, "source")
    Fs.writeFileSync(file, "input")
    Fs.symlinkSync("/dev/fd/7", join(root, "alias"))
    const opening = `10 openat(AT_FDCWD, "alias", O_RDONLY) = 3<${file}>`
    expect(record(root, [opening])).toEqual({ refusal: `its trace does not say where ${root}/alias led` })
    expect(record(root, [
      `10 openat(AT_FDCWD, "source", O_RDONLY) = 7<${file}>`,
      opening
    ])).toMatchObject({ reads: [["alias", "l:/dev/fd/7"], ["source", Reads.measure(file)]] })
  })

  it("requires an explicitly probed name when an identical output has unknown or tracked provenance", () => {
    const root = directory()
    const file = join(root, "result")
    const contents = "output"
    Fs.writeFileSync(file, contents)
    const observed = record(root, [
      "10 newfstatat(AT_FDCWD, \"result\", 0x1, AT_SYMLINK_NOFOLLOW) = -1 ENOENT (No such file or directory)",
      "10 openat(AT_FDCWD, \"result\", O_WRONLY|O_CREAT|O_EXCL, 0644) = 3"
    ])
    const state = Reads.measure(file)
    expect(observed).toMatchObject({ reads: [["result", state, "-"]], left: true })
    if ("refusal" in observed) return
    const changed = (tracked: ReadonlySet<string> | undefined) =>
      Reads.changed(observed, root, undefined, undefined, undefined, undefined, undefined, undefined, () => tracked)
    expect(changed(undefined)).toBe("result changed")
    expect(changed(new Set(["result"]))).toBe("result changed")
    expect(changed(new Set())).toBeUndefined()
    Fs.unlinkSync(file)
    expect(Reads.changed(observed, root)).toBeUndefined()
    Fs.writeFileSync(file, contents)
    expect(Reads.changed(observed, root)).toBe("result changed")
  })

  it("reuses an ordinary output when creation did not read its absence", () => {
    const root = directory()
    const file = join(root, "result")
    Fs.writeFileSync(file, "output")
    const observed = record(root, ["10 openat(AT_FDCWD, \"result\", O_WRONLY|O_CREAT|O_TRUNC, 0644) = 3"])
    expect(observed).toMatchObject({ reads: [], made: ["result"], left: true })
    if ("refusal" in observed) return
    expect(Reads.changed(
      observed,
      root,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => new Set()
    )).toBeUndefined()
    Fs.unlinkSync(file)
    expect(Reads.changed(observed, root)).toBeUndefined()
  })
})

describe("inputs contributed by other steps", () => {
  it("excludes a produced subdirectory from the parent link count but still requires the producer's answer", () => {
    const root = directory()
    const parent = join(root, "parent")
    const generated = join(parent, "generated")
    const ignored = join(parent, "ignored")
    Fs.mkdirSync(generated, { recursive: true })
    Fs.mkdirSync(ignored)
    Fs.mkdirSync(join(parent, "tracked"))
    const trace = Reads.read(() => [
      "10 newfstatat(AT_FDCWD, \"parent\", {st_mode=S_IFDIR|0755, st_nlink=5}, 0) = 0"
    ], root)
    const record = Reads.record(trace, {
      root,
      ignore: [ignored],
      startedMs: Infinity,
      producers: [{ label: "//:producer", id: "artifact", made: new Set([generated]), touched: new Set([generated]) }]
    })
    expect(record).toMatchObject({ links: [["parent", 3, ["ignored"], [["generated", 0]]]] })
    if ("refusal" in record) return
    expect(Reads.changed(record, root)).toBeUndefined()
    Fs.rmdirSync(generated)
    expect(Reads.changed(record, root)).toBe("parent/generated is gone")
    expect(Reads.changed(record, root, undefined, undefined, () => new Set(["artifact"]))).toBeUndefined()
    Fs.rmdirSync(join(parent, "tracked"))
    expect(Reads.changed(record, root)).toBe("parent gained or lost a subdirectory")
  })
})

describe("measurements used to identify variable dependencies", () => {
  it("hears an escaped variable passed by execveat", () => {
    const value = "quoted\"value"
    const listener = Reads.listening({ CHOICE: value })
    const line = "10 execveat(AT_FDCWD, \"/bin/echo\", [\"echo\", " + JSON.stringify(value) + "], 0x1, 0) = 0"
    expect([...listener.lines(() => [line])()]).toEqual([line])
    expect([...listener.names]).toEqual(["CHOICE"])
  })

  it("filters declared data without treating its contents as use of a variable", () => {
    const root = directory()
    Fs.writeFileSync(join(root, "data"), "Z and ATTEMPT")
    Fs.writeFileSync(join(root, "code"), "Z")
    const trace = Reads.read(() => [
      "10 openat(AT_FDCWD, \"code\", O_RDONLY) = 3",
      "10 openat(AT_FDCWD, \"data\", O_RDONLY) = 4"
    ], root)
    const lookedAt: Array<ReadonlyArray<string>> = []
    const input = { root, ignore: [], startedMs: Infinity }
    expect(Reads.record(trace, {
      ...input,
      variables: {
        values: { Z: "one", ATTEMPT: "two" },
        text: "",
        readAsData: ["data"],
        searchFirstAbove: 0,
        ignored: (paths) => {
          lookedAt.push(paths)
          return new Set()
        }
      }
    })).toMatchObject({ variables: [["Z", Reads.heldAs("one")]] })
    expect(lookedAt).toEqual([[join(root, "code")]])
    expect(Reads.record(trace, {
      ...input,
      variables: { values: { Z: "one" }, text: "", searchFirstAbove: 0 }
    })).toMatchObject({ variables: [["Z", Reads.heldAs("one")]] })

    expect(Reads.record(trace, {
      ...input,
      io: { ...Reads.defaultIo, readFile: (file) => Fs.readFileSync(file) },
      variables: { values: { Z: "one" }, text: "", ignored: () => new Set() }
    })).toMatchObject({ variables: [["Z", Reads.heldAs("one")]] })
  })
})

describe("reconstructing a path from its observed view", () => {
  it("refuses to list a bind mount whose source no longer resolves", () => {
    const root = directory()
    const source = join(root, "source")
    const view = join(root, "view")
    const loop = join(root, "loop")
    Fs.mkdirSync(source)
    Fs.symlinkSync(loop, loop)
    const mounts = [[join(view, "nested"), loop], [view, source]] as const
    expect(Reads.listing(source, [], Reads.defaultIo, mounts)).toBeUndefined()
    Fs.unlinkSync(loop)
    Fs.symlinkSync("real", loop)
    Fs.writeFileSync(join(root, "real"), "backing")
    expect(Reads.listing(source, [], Reads.defaultIo, mounts)).toMatch(/^[0-9a-f]{64}$/)

    const nested = [[join(view, "virtual", "first"), loop], [join(view, "virtual", "second"), loop], [
      view,
      source
    ]] as const
    const listing = Reads.listing(source, [], Reads.defaultIo, nested)
    expect(listing).toMatch(/^[0-9a-f]{64}$/)
    expect(listing).not.toBe(Reads.listing(source, [], Reads.defaultIo, [[view, source]]))
  })

  it("keeps a special file's type when listing the mount that exposes it", () => {
    const root = directory()
    const source = join(root, "source")
    const view = join(root, "view")
    Fs.mkdirSync(source)
    const mounts = [[join(view, "null"), "/dev/null"], [view, source]] as const
    expect(Reads.listing(source, [], Reads.defaultIo, mounts)).toMatch(/^[0-9a-f]{64}$/)
    expect(Reads.listing(source, [], Reads.defaultIo, mounts))
      .not.toBe(Reads.listing(source, [], Reads.defaultIo, [[view, source]]))
    const count = Reads.dirLinks("/", [])
    if (count !== undefined) expect(Reads.dirLinks("/", ["tmp"])).toBe(count - 1)
  })

  it("refuses a directory whose listing cannot be read", () => {
    const root = directory()
    const named = join(root, "dir")
    Fs.mkdirSync(named)
    const trace = Reads.read(() => [
      `10 getdents64(3<${named}>, 0x1 /* 2 entries */, 32768) = 48`
    ], root)
    const io = {
      ...Reads.defaultIo,
      readdir: () => {
        throw Object.assign(new Error("directory permission changed"), { code: "EACCES" })
      }
    }
    expect(Reads.record(trace, { root, ignore: [], startedMs: Infinity, io })).toEqual({
      refusal: "dir, which it listed, cannot be listed now"
    })
    expect(Reads.dirLinks(join(root, "gone"), [], Reads.defaultIo)).toBeUndefined()
    Fs.writeFileSync(join(root, "file"), "contents")
    expect(Reads.dirLinks(join(root, "file"), [], Reads.defaultIo)).toBeUndefined()
  })

  it("keeps both a path and its target when a metadata call followed the link", () => {
    const root = directory()
    const alias = join(root, "alias")
    const target = join(root, "source")
    Fs.writeFileSync(target, "contents")
    Fs.symlinkSync("source", alias)
    const trace = Reads.read(() => [
      "10 openat(AT_FDCWD, \"alias\", O_RDONLY) = 3",
      "10 utimensat(AT_FDCWD, \"alias\", NULL, 0) = 0"
    ], root)
    const record = Reads.record(trace, { root, ignore: [], startedMs: 0 })
    expect(record).toMatchObject({
      reads: [["alias", "l:source"], ["source", Reads.measure(target)]]
    })
  })

  it.each(["openat", "openat2"])("refuses when %s follows a link later removed under another spelling", (call) => {
    const root = directory()
    const nested = join(root, "nested")
    const transient = join(nested, "removed")
    const file = join(root, "target", "file")
    Fs.mkdirSync(nested)
    Fs.mkdirSync(join(root, "target"))
    Fs.writeFileSync(file, "contents")
    Fs.symlinkSync("nested", join(root, "alias"))
    const opening = call === "openat"
      ? "10 openat(AT_FDCWD, \"alias/removed/file\", O_RDONLY) = 3"
      : `10 openat2(AT_FDCWD, "/alias/removed/file", {flags=O_RDONLY, resolve=RESOLVE_IN_ROOT}, 24) = 3<${file}>`
    const trace = Reads.read(() => [
      "10 symlink(\"../target\", \"nested/removed\") = 0",
      opening,
      "10 unlink(\"nested/removed\") = 0"
    ], root)
    expect(Reads.record(trace, { root, ignore: [], startedMs: Infinity })).toEqual({
      refusal: `${transient} was replaced while it was used`
    })
  })

  it("refuses a write or metadata update whose parent no longer resolves", () => {
    const root = directory()
    Fs.symlinkSync("dir", join(root, "dir"))
    for (
      const call of [
        "openat(AT_FDCWD, \"dir/file\", O_WRONLY|O_TRUNC) = 3",
        "utimensat(AT_FDCWD, \"dir/file\", NULL, 0) = 0"
      ]
    ) {
      const trace = Reads.read(() => [`10 ${call}`], root)
      expect(Reads.record(trace, { root, ignore: [], startedMs: Infinity })).toMatchObject({
        refusal: expect.stringContaining("passes through too many symbolic links")
      })
    }
  })

  it("does not reconstruct a read after exchanging two symbolic links", () => {
    const root = directory()
    Fs.symlinkSync("first", join(root, "a"))
    Fs.symlinkSync("second", join(root, "b"))
    const trace = Reads.read(() => [
      "10 renameat2(AT_FDCWD, \"a\", AT_FDCWD, \"b\", RENAME_EXCHANGE) = 0"
    ], root)
    expect(Reads.record(trace, { root, ignore: [], startedMs: Infinity })).toEqual({
      refusal: Reads.cannotFollow("renameat2 with RENAME_EXCHANGE of a symbolic link")
    })
  })
})

describe("recorded dependency and program identity", () => {
  it("retains the program, file and directory dependencies when a record is anchored to a later producer", () => {
    const root = directory()
    const dir = join(root, "dir")
    Fs.mkdirSync(dir)
    const program = [["//:server", "listening"]] as const
    const data = {
      reads: [],
      lists: [],
      from: [["//:producer", "original"]],
      given: [["dir", "d", 0]],
      links: [["dir", 2, []]],
      made: ["output"],
      running: true,
      served: program,
      left: true,
      variables: [["CHOICE", Reads.heldAs("value")]]
    } as const satisfies Omit<Reads.Record, "id">
    const plain = { reads: [], lists: [] }
    const trace = Reads.read(() => ["10 +++ exited with 0 +++"], root)
    const options = { root, ignore: [], startedMs: Infinity }
    expect(Reads.record(trace, { ...options, served: [] })).toEqual({ ...plain, id: Reads.idOf(plain) })
    expect(Reads.record(trace, { ...options, running: true, served: program })).toMatchObject({
      running: true,
      served: program
    })
    expect(
      new Set([
        Reads.idOf(plain),
        Reads.idOf({ ...plain, running: true }),
        Reads.idOf({ ...plain, served: program }),
        Reads.idOf({ ...plain, running: true, served: program })
      ]).size
    ).toBe(4)

    const record = { ...data, id: Reads.idOf(data), kept: { archive: "0".repeat(64), outside: [], gone: [] } }
    const late = Reads.anchored(record, () => "later")
    const anchored = { ...data, from: [["//:producer", "later"]] } as const
    expect(late).toEqual({ ...anchored, id: Reads.idOf(anchored), kept: record.kept })
    expect(late?.id).not.toBe(record.id)
    expect(Reads.asRecord(late)).toEqual(late)
    expect(Reads.asRecord({ ...record, kept: null })).toBeUndefined()
    if (late === undefined) return
    const check = (server: string) =>
      Reads.changed(
        late,
        root,
        undefined,
        undefined,
        () => new Set(["later"]),
        { CHOICE: "value" },
        undefined,
        () => new Set([server]),
        () => new Set()
      )
    expect(check("different")).toBe("the program //:server started, which it talked to, is not the one it talked to")
    expect(check("listening")).toBeUndefined()
    Fs.rmdirSync(dir)
    expect(check("listening")).toBeUndefined()
  })

  it("refuses to keep a produced file outside the workspace whose bytes cannot be read", () => {
    const root = directory()
    const outside = join(directory(), "result")
    Fs.writeFileSync(outside, "written")
    const trace = Reads.read(() => [
      `10 openat(AT_FDCWD, "${outside}", O_WRONLY|O_CREAT|O_TRUNC, 0644) = 3`
    ], root)
    const observed = Reads.observe(trace, {
      root,
      ignore: [],
      startedMs: Infinity,
      io: {
        ...Reads.defaultIo,
        digest: () => {
          throw Object.assign(new Error("storage read failed"), { code: "EIO" })
        }
      }
    })
    expect(observed).toMatchObject({
      left: { refusal: `it left ${outside} outside the workspace, which cannot be read` }
    })
  })
})

describe("replacing an empty directory", () => {
  const replace = (preamble: ReadonlyArray<string> = [], named = "dir") => () => [
    ...preamble,
    `10 rmdir("${named}") = 0`,
    `10 mkdir("${named}", 0777) = 0`
  ]

  it("records the first successful rmdir and validates the previous directory's emptiness", () => {
    const root = directory()
    const name = join(root, "dir")
    Fs.mkdirSync(name)
    const options = { root, ignore: [], startedMs: Infinity, held: () => new Set<string>() }
    const trace = Reads.read(replace(), root)
    expect(trace.removedEmpty).toEqual(new Set([name]))
    const recorded = Reads.withServed(trace, [])
    expect(recorded.removedEmpty).toBe(trace.removedEmpty)
    const record = Reads.record(recorded, options)
    expect(record).toMatchObject({
      reads: [["dir", "d", "d"]],
      lists: [["dir", Reads.listing(name, []), []]]
    })
    if ("refusal" in record) return
    expect(Reads.changed(record, root)).toBeUndefined()
    Fs.writeFileSync(join(name, "input"), "not an empty directory")
    expect(Reads.changed(record, root)).toBe("dir gained or lost an entry")
    expect(Reads.record(trace, options)).toMatchObject({ reads: [["dir", "d", "?"]] })
    Fs.rmSync(name, { recursive: true })
    expect(Reads.changed(record, root)).toBe("dir is gone")
  })

  it("recognizes successful removal through AT_REMOVEDIR and rejects prior listings or an unsuccessful removal", () => {
    const root = directory()
    const name = join(root, "dir")
    const read = (lines: ReadonlyArray<string>) => Reads.read(() => lines, root)
    expect(read(["10 unlinkat(AT_FDCWD, \"dir\", AT_REMOVEDIR) = 0"]).removedEmpty).toEqual(new Set([name]))
    expect(read(["10 rmdir(\"dir\") = -1 ENOTEMPTY (Directory not empty)"]).removedEmpty).toBeUndefined()
    expect(read([`10 getdents64(3<${name}>, 0x1 /* 2 entries */, 32768) = 48`, ...replace()()]).removedEmpty)
      .toBeUndefined()
  })

  it("does not infer an earlier empty directory across child writes, mounts, or continuations", () => {
    const root = directory()
    const name = join(root, "dir")
    Fs.mkdirSync(name)
    const base = { root, ignore: [], startedMs: Infinity, held: () => new Set<string>() }
    const trace = Reads.read(replace(), root)
    const modifiedChild = Reads.read(replace(["10 unlink(\"dir/input\") = 0"]), root)
    const continuation = Reads.servedBy(
      () => ["10 openat(AT_FDCWD, \"server\", O_RDONLY) = 3"],
      () => ["10 rmdir(\"dir\") = 0", "10 mkdir(\"dir\", 0777) = 0"],
      root
    )
    expect(continuation.removedEmpty).toBeUndefined()
    for (
      const [reading, options] of [
        [modifiedChild, base],
        [Reads.withServed(trace, [continuation]), base],
        [trace, { ...base, mounts: [[join(root, "workspace"), root]] as const }],
        [trace, { ...base, found: new Map([[name, "l:elsewhere"]]) }],
        [trace, {
          ...base,
          producers: [{ label: "//:producer", id: "id", made: new Set<string>(), touched: new Set<string>() }]
        }]
      ] as const
    ) {
      expect(Reads.record(reading, options)).toMatchObject({ reads: expect.arrayContaining([["dir", "d", "?"]]) })
    }
  })

  it("does not infer emptiness through an alias or after rewriting the parent", () => {
    const root = directory()
    const dir = join(root, "parent", "dir")
    Fs.mkdirSync(dir, { recursive: true })
    Fs.symlinkSync("parent", join(root, "alias"))
    const options = { root, ignore: [], startedMs: Infinity, held: () => new Set<string>() }
    for (const lines of [replace([], "alias/dir"), replace(["10 chmod(\"parent\", 0755) = 0"], "parent/dir")]) {
      expect(Reads.record(Reads.read(lines, root), options)).toMatchObject({
        reads: expect.arrayContaining([["parent/dir", "d", "?"]])
      })
    }
  })
})

describe("record edges for optional and exceptional path evidence", () => {
  it("validates a legacy trace without truncation evidence or a make timestamp for a listed directory", () => {
    const root = directory()
    const path = join(root, "dir")
    Fs.mkdirSync(path)
    const parsed = Reads.read(() => [`10 getdents64(3<${path}>, 0x1 /* 2 entries */, 32768) = 48`], root)
    const { required: _required, ...legacy } = parsed
    expect(Reads.record({ ...legacy, built: new Set([path]) }, {
      root,
      ignore: [],
      startedMs: Infinity
    })).toMatchObject({ lists: [["dir", Reads.listing(path, []), []]] })
  })

  it("does not ask checkout provenance for absolute recorded names", () => {
    const root = directory()
    const file = join(root, "external")
    Fs.writeFileSync(file, "identical")
    const record = Reads.asRecord({
      id: "",
      reads: [[file, Reads.measure(file), "-"]],
      lists: [],
      made: [file]
    })
    expect(record).toBeDefined()
    if (record === undefined) return
    const held: Array<ReadonlyArray<string>> = []
    expect(Reads.changed(record, root, undefined, undefined, undefined, undefined, undefined, undefined, (paths) => {
      held.push(paths)
      return undefined
    })).toBe(`${file} changed`)
    expect(held).toEqual([])
  })

  it("refuses an overlong name a continuation reported as written and ignores pseudo-file writes", () => {
    const root = directory()
    const trace = Reads.read(() => ["10 +++ exited with 0 +++"], root)
    const pseudo = "/dev/workspace-record-edge"
    const path = join(root, "x".repeat(5000))
    const options = { root, ignore: [], startedMs: Infinity }
    expect(Reads.record({ ...trace, changed: new Set([path]) }, options)).toEqual({
      refusal: Reads.cannotFollow("a path longer than 4095 bytes")
    })
    expect(
      Reads.record(
        { ...trace, changed: new Set([pseudo]), made: new Map([[pseudo, 1]]), removed: new Set([pseudo]) },
        options
      )
    )
      .toMatchObject({ reads: [], lists: [] })
    expect(Reads.record({ ...trace, exchanged: [[pseudo, join(root, "missing")]] }, options)).toEqual({
      refusal: Reads.cannotFollow("renameat2 with RENAME_EXCHANGE of a directory")
    })
  })

  it("accounts for a process executable endpoint when the same program was already observed", () => {
    const root = directory()
    const file = join(root, "source")
    const alias = join(root, "alias")
    Fs.writeFileSync(file, "program")
    Fs.symlinkSync("/proc/self/exe", alias)
    const trace = Reads.read(() => [
      `10 openat(AT_FDCWD, "source", O_RDONLY) = 7<${file}>`,
      `10 openat(AT_FDCWD, "alias", O_RDONLY) = 3<${file}>`
    ], root)
    const opts = { root, ignore: [], startedMs: Infinity, held: () => new Set<string>() }
    expect(Reads.record(trace, opts)).toMatchObject({
      reads: [["alias", "l:/proc/self/exe"], ["source", Reads.measure(file)]]
    })
    Fs.unlinkSync(alias)
    Fs.symlinkSync("alias", alias)
    expect(Reads.record({ ...trace, found: new Map() }, opts)).toHaveProperty("refusal")
  })

  it("keeps only actual inputs when inspecting metadata on a generated file", () => {
    const root = directory()
    const dir = join(root, "dir")
    const file = join(dir, "generated")
    Fs.mkdirSync(dir)
    Fs.writeFileSync(file, "output")
    const trace = Reads.read(() => [
      "10 mkdir(\"dir\", 0777) = 0",
      "10 openat(AT_FDCWD, \"dir/generated\", O_WRONLY|O_CREAT|O_EXCL, 0644) = 3",
      "10 utimensat(AT_FDCWD, \"dir/generated\", NULL, 0) = 0"
    ], root)
    expect(Reads.record(trace, { root, ignore: [], startedMs: Infinity, held: () => new Set<string>() }))
      .toMatchObject({ reads: [], made: ["dir"] })

    Fs.writeFileSync(join(root, "source"), "untouched")
    Fs.symlinkSync("source", join(root, "linked"))
    expect(Reads.record(
      Reads.read(() => [
        "10 symlink(\"source\", \"linked\") = 0",
        "10 utimensat(AT_FDCWD, \"linked\", NULL, 0) = 0"
      ], root),
      { root, ignore: [], startedMs: Infinity, held: () => new Set<string>() }
    ))
      .toMatchObject({ reads: [], made: ["linked"] })

    Fs.symlinkSync("alias", join(root, "alias"))
    expect(Reads.record(Reads.read(() => ["10 utimensat(AT_FDCWD, \"alias\", NULL, 0) = 0"], root), {
      root,
      ignore: [],
      startedMs: Infinity
    })).toHaveProperty("refusal")
  })

  it("omits link counts when the filesystem supplies none", () => {
    const root = directory()
    const file = join(root, "dir")
    Fs.mkdirSync(file)
    const trace = Reads.read(() => [
      "10 newfstatat(AT_FDCWD, \"dir\", {st_mode=S_IFDIR|0755, st_nlink=1}, 0) = 0"
    ], root)
    const observed = Reads.record(trace, {
      root,
      ignore: [],
      startedMs: Infinity,
      io: {
        ...Reads.defaultIo,
        lstat: (path) => {
          const stats = Fs.lstatSync(path)
          if (path === file) stats.nlink = 1
          return stats
        }
      }
    })
    expect(observed).toMatchObject({ reads: [["dir", "d"]] })
    expect(observed).not.toHaveProperty("links")
  })

  it("requires a preimage for a tracked name replaced with a directory", () => {
    const root = directory()
    Fs.mkdirSync(join(root, "old"))
    const trace = Reads.read(() => ["10 rename(\"new\", \"old\") = 0"], root)
    const record = Reads.record(trace, {
      root,
      ignore: [],
      startedMs: Infinity,
      held: () => new Set(["old"])
    })
    expect(record).toMatchObject({ reads: expect.arrayContaining([["old", "d", "?"]]) })
  })

  it("retains the absolute path of a constrained open when a separate transient link existed", () => {
    const root = directory()
    const file = join(root, "source")
    Fs.writeFileSync(file, "input")
    const trace = Reads.read(() => [
      "10 symlink(\"source\", \"removed\") = 0",
      `10 openat2(AT_FDCWD, "${file}", {flags=O_RDONLY, resolve=RESOLVE_NO_SYMLINKS}, 24) = 3<${file}>`,
      `10 openat2(AT_FDCWD, "${root}/missing", {flags=O_RDONLY, resolve=RESOLVE_NO_SYMLINKS}, 24) = -1 ENOENT (No such file)`,
      "10 unlink(\"removed\") = 0"
    ], root)
    expect(Reads.record(trace, { root, ignore: [], startedMs: Infinity, held: () => new Set<string>() }))
      .toMatchObject({ reads: expect.arrayContaining([["source", Reads.measure(file)], ["missing", "-"]]) })
  })
})
