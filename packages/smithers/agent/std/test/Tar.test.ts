/**
 * The tar reader `RemoteSearch` brings a machine's files back through.
 *
 * Each archive here is built byte by byte, so every header form a GNU,
 * BusyBox, or BSD `tar` writes is pinned exactly, and so is every way a
 * stream can be cut or corrupted on its way back.
 */
import { describe, expect, it } from "vitest"
import * as Tar from "../src/internal/Tar.ts"

const encoder = new TextEncoder()

interface Header {
  readonly name: string
  readonly size?: number | undefined
  readonly type?: string | undefined
  readonly magic?: string | undefined
  readonly link?: string | undefined
  readonly prefix?: string | undefined
  readonly sizeField?: string | undefined
  readonly corrupt?: boolean | undefined
}

const put = (block: Uint8Array, offset: number, value: string) => block.set(encoder.encode(value), offset)

const header = (spec: Header): Uint8Array => {
  const block = new Uint8Array(512)
  put(block, 0, spec.name)
  put(block, 100, "0000644\0")
  put(block, 108, "0000000\0")
  put(block, 116, "0000000\0")
  put(block, 124, spec.sizeField ?? `${(spec.size ?? 0).toString(8).padStart(11, "0")}\0`)
  put(block, 136, "00000000000\0")
  put(block, 156, spec.type ?? "0")
  if (spec.link !== undefined) put(block, 157, spec.link)
  put(block, 257, spec.magic ?? "ustar\0")
  put(block, 263, "00")
  if (spec.prefix !== undefined) put(block, 345, spec.prefix)
  block.fill(32, 148, 156)
  let sum = 0
  for (const byte of block) sum += byte
  put(block, 148, `${(spec.corrupt === true ? sum + 1 : sum).toString(8).padStart(6, "0")}\0 `)
  return block
}

const padded = (data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(Math.ceil(data.length / 512) * 512)
  out.set(data)
  return out
}

const entry = (spec: Omit<Header, "size">, data: string | Uint8Array = ""): Uint8Array => {
  const bytes = typeof data === "string" ? encoder.encode(data) : data
  return concat(header({ ...spec, size: bytes.length }), padded(bytes))
}

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const end = new Uint8Array(1024)

const pax = (records: ReadonlyArray<string>): string =>
  records.map((record) => {
    // The length counts the bytes of itself, the space, the record, and the newline.
    const bytes = (text: string) => encoder.encode(text).length
    let length = bytes(record) + 3
    while (bytes(`${length} ${record}\n`) !== length) length++
    return `${length} ${record}\n`
  }).join("")

const decoded = (files: ReadonlyMap<string, Uint8Array> | undefined) =>
  files === undefined
    ? undefined
    : Object.fromEntries([...files].map(([name, bytes]) => [name, new TextDecoder().decode(bytes)]))

describe("Tar.files", () => {
  it("reads every regular file, by every name form, across concatenated archives", () => {
    const long = `${"d".repeat(120)}/${"f".repeat(120)}.txt`
    const stream = concat(
      entry({ name: "plain.txt" }, "plain\n"),
      entry({ name: "n".repeat(100) }, "a name that fills its field\n"),
      entry({ name: "nul-type.txt", type: "\0" }, "nul type\n"),
      entry({ name: "contiguous.txt", type: "7" }, "contiguous\n"),
      entry({ name: "dir/", type: "5" }),
      entry({ name: "f.txt", prefix: "long/prefix" }, "prefixed\n"),
      entry({ name: "gnu.txt", magic: "ustar  \0", prefix: "not-a-prefix" }, "gnu\n"),
      entry({ name: "././@LongLink", type: "L" }, `${long}\0`),
      entry({ name: "././@LongLink", type: "K" }, "target\0"),
      entry({ name: "truncated-name" }, "long name\n"),
      entry({ name: "PaxHeader", type: "x" }, pax(["mtime=1.5", "path=pax/é name.txt"])),
      entry({ name: "pax-short" }, "pax\n"),
      entry({ name: "PaxHeader", type: "x" }, pax(["mtime=2"])),
      entry({ name: "pax-without-path.txt" }, "header name\n"),
      entry({ name: "GlobalHeader", type: "g" }, pax(["comment=global"])),
      entry({ name: "link", type: "2" }),
      end,
      entry({ name: "second.txt" }, "second archive\n"),
      end,
      new Uint8Array(100)
    )
    expect(decoded(Tar.files(stream))).toEqual({
      "plain.txt": "plain\n",
      ["n".repeat(100)]: "a name that fills its field\n",
      "nul-type.txt": "nul type\n",
      "contiguous.txt": "contiguous\n",
      "long/prefix/f.txt": "prefixed\n",
      "gnu.txt": "gnu\n",
      [long]: "long name\n",
      "pax/é name.txt": "pax\n",
      "pax-without-path.txt": "header name\n",
      "second.txt": "second archive\n"
    })
  })

  it("retains hard-linked names and chains, including empty files", () => {
    const stream = concat(
      entry({ name: "./a.txt" }, "needle\n"),
      entry({ name: "./b.txt", type: "1", link: "./a.txt" }),
      entry({ name: "c.txt", type: "1", link: "./b.txt" }),
      entry({ name: "empty.txt" }),
      entry({ name: "empty-link.txt", type: "1", link: "empty.txt" }),
      end
    )
    expect(decoded(Tar.files(stream))).toEqual({
      "./a.txt": "needle\n",
      "./b.txt": "needle\n",
      "c.txt": "needle\n",
      "empty.txt": "",
      "empty-link.txt": ""
    })
  })

  it("reads GNU long link targets and POSIX linkpath records without leaking them to the next member", () => {
    const target = `long/${"t".repeat(120)}.txt`
    const alias = `aliases/${"a".repeat(120)}.txt`
    const stream = concat(
      entry({ name: "LongLink", type: "L" }, `${target}\0`),
      entry({ name: "short" }, "long target\n"),
      entry({ name: "LongLink", type: "K" }, `${target}\0`),
      entry({ name: "LongLink", type: "L" }, `${alias}\0`),
      entry({ name: "short-alias", type: "1", link: "truncated-target" }),
      entry({ name: "pax", type: "x" }, pax([`path=pax/é.txt`, `linkpath=${target}`])),
      entry({ name: "short-pax", type: "1", link: "truncated-target" }),
      entry({ name: "normal.txt" }, "normal\n"),
      entry({ name: "normal-link.txt", type: "1", link: "normal.txt" }),
      end
    )
    expect(decoded(Tar.files(stream))).toEqual({
      [target]: "long target\n",
      [alias]: "long target\n",
      "pax/é.txt": "long target\n",
      "normal.txt": "normal\n",
      "normal-link.txt": "normal\n"
    })
  })

  it("uses the member prefix for a hard link's own name and refuses an unavailable target", () => {
    expect(decoded(Tar.files(concat(
      entry({ name: "target.txt" }, "target\n"),
      entry({ name: "alias.txt", prefix: "nested", type: "1", link: "target.txt" }),
      end
    )))).toEqual({ "target.txt": "target\n", "nested/alias.txt": "target\n" })
    expect(Tar.files(concat(entry({ name: "alias.txt", type: "1", link: "missing.txt" }), end))).toBeUndefined()
  })

  it("keeps the path a malformed extended record already gave and stops at the break", () => {
    const broken = `${pax(["path=kept.txt"])}9999 path=lost.txt\n`
    const stream = concat(entry({ name: "PaxHeader", type: "x" }, broken), entry({ name: "short" }, "kept\n"), end)
    expect(decoded(Tar.files(stream))).toEqual({ "kept.txt": "kept\n" })
    for (const record of ["x path=no.txt\n", "no-length-at-all", "2 path=too-short.txt\n"]) {
      const unparsable = concat(entry({ name: "PaxHeader", type: "x" }, record), entry({ name: "named" }, "n\n"), end)
      expect(decoded(Tar.files(unparsable)), record).toEqual({ named: "n\n" })
    }
  })

  it("refuses a stream that is not a whole archive", () => {
    expect(Tar.files(new Uint8Array())).toEqual(new Map())
    expect(Tar.files(header({ name: "bad.txt", size: 4, corrupt: true }))).toBeUndefined()
    expect(Tar.files(header({ name: "bad.txt", sizeField: "zz\0" }))).toBeUndefined()
    expect(Tar.files(header({ name: "cut.txt", size: 600 }))).toBeUndefined()
    // A tar that stopped between members wrote no end.
    expect(Tar.files(entry({ name: "unended.txt" }, "x\n"))).toBeUndefined()
  })
})
