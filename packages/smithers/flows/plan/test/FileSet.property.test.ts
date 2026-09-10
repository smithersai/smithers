import * as FileSet from "@smthrs/plan/FileSet"
import * as Schema from "effect/Schema"
import { FastCheck } from "effect/testing"
import { describe, expect, it } from "vitest"
import { params as sharedParams } from "./FastCheckParams.ts"

const params = sharedParams(100)

// --- workspace-relative confinement -----------------------------------------

/** Segments biased toward traversal, aliasing, drive, and control-byte forms. */
const hostileToken = FastCheck.oneof(
  FastCheck.constantFrom("..", ".", "", "~", "C:", "c:", "...", "..\u0000", "a b", "\u00e9", "e\u0301"),
  FastCheck.string({ unit: "grapheme", maxLength: 5 }),
  FastCheck.string({ unit: "binary-ascii", maxLength: 5 })
)

/** Joins hostile tokens with a mix of both separators and hostile anchors. */
const rawPath = FastCheck.tuple(
  FastCheck.array(hostileToken, { minLength: 1, maxLength: 5 }),
  FastCheck.array(FastCheck.constantFrom("/", "\\"), { minLength: 4, maxLength: 4 }),
  FastCheck.constantFrom("", "/", "\\", "C:/", "c:\\")
).map(([tokens, seps, prefix]) =>
  prefix + tokens.map((token, index) => index === 0 ? token : `${seps[(index - 1) % seps.length]!}${token}`).join("")
)

describe("FileSet.workspaceRelative properties", () => {
  const confinementCorpus: Array<[string]> = [
    ["..\\up"],
    ["a\\..\\b"],
    ["src\\a.ts"],
    ["C:\\win"],
    ["\\\\server\\share"],
    ["a/./b"],
    ["a//b"],
    ["a/"],
    ["."],
    [".."],
    ["a\u0000b"],
    ["a\u001fb"],
    ["a\u007fb"],
    ["..."]
  ]

  it("acceptance implies confinement: no absolute anchor, no drive anchor, no traversal or aliasing under either separator", () => {
    FastCheck.assert(
      FastCheck.property(rawPath, (path) => {
        if (!FileSet.workspaceRelative(path)) return
        // The oracle splits on both separators independently of the
        // implementation: an accepted spelling resolves strictly downward.
        expect(/[\u0000-\u001f\u007f]/u.test(path)).toBe(false)
        expect(path.startsWith("/") || path.startsWith("\\")).toBe(false)
        const segments = path.split(/[/\\]/)
        expect(/^[A-Za-z]:$/.test(segments[0]!)).toBe(false)
        expect(segments.length).toBeGreaterThan(0)
        for (const segment of segments) {
          expect(segment === ".." || segment === "." || segment === "").toBe(false)
        }
      }),
      { ...params, examples: confinementCorpus }
    )
  })

  it("acceptance is idempotent under separator normalization and closed under concatenation", () => {
    FastCheck.assert(
      FastCheck.property(rawPath, rawPath, (first, second) => {
        if (FileSet.workspaceRelative(first)) {
          expect(FileSet.workspaceRelative(first.replaceAll("\\", "/"))).toBe(true)
          if (FileSet.workspaceRelative(second)) {
            expect(FileSet.workspaceRelative(`${first}/${second}`)).toBe(true)
          }
        }
      }),
      { ...params, examples: [["src\\a.ts", "b/c"], ["a", "b:c"]] }
    )
  })

  it("the Pattern schema admits exactly the non-empty workspace-relative strings", () => {
    FastCheck.assert(
      FastCheck.property(rawPath, (path) => {
        expect(Schema.is(FileSet.Pattern)(path)).toBe(path.length > 0 && FileSet.workspaceRelative(path))
      }),
      params
    )
  })
})

// --- glob semantics: `*` confined to a segment, `**` crossing ----------------

type Piece = { readonly star: true } | { readonly star: false; readonly text: string }

/** Literal chunks loaded with regex metacharacters, so escaping is exercised. */
const literalText = FastCheck.array(
  FastCheck.constantFrom(..."abZ09_-.$+?^{}()|[]"),
  { minLength: 1, maxLength: 4 }
).map((chars) => chars.join(""))

const piece: FastCheck.Arbitrary<Piece> = FastCheck.oneof(
  literalText.map((text) => ({ star: false as const, text })),
  FastCheck.constant<Piece>({ star: true })
)

/** One pattern segment that is never the recursive `**` or an alias form. */
const segmentPieces = FastCheck.array(piece, { minLength: 1, maxLength: 3 }).map((pieces): ReadonlyArray<Piece> => {
  const rendered = pieces.map((part) => (part.star ? "*" : part.text)).join("")
  return rendered === "**" || rendered === "." || rendered === ".."
    ? [{ star: false, text: "x" }, ...pieces]
    : pieces
})

/** Path fillers: separator-free, possibly empty, including backslash and unicode. */
const filler = FastCheck.array(FastCheck.constantFrom(..."xyz01\\ é."), { maxLength: 4 }).map((chars) => chars.join(""))

const fillerNonEmpty = FastCheck.array(FastCheck.constantFrom(..."xyz01\\ é."), { minLength: 1, maxLength: 4 })
  .map((chars) => chars.join(""))

describe("FileSet.matchesPattern properties", () => {
  it("rejects an admitted 24-star near miss within 100 ms", () => {
    const pattern = "*a".repeat(24) + "b"
    const path = "a".repeat(47) + "c"
    expect(Schema.is(FileSet.Pattern)(pattern)).toBe(true)
    expect(Schema.is(FileSet.Pattern)(path)).toBe(true)
    const started = performance.now()
    expect(FileSet.matchesPattern(pattern, path)).toBe(false)
    expect(performance.now() - started).toBeLessThan(100)
  })

  it("bounds repeated recursive segments and long literal near misses", () => {
    const started = performance.now()
    expect(FileSet.matchesPattern("**/a/".repeat(24) + "b", "a/".repeat(48) + "c")).toBe(false)
    expect(FileSet.matchesPattern("*" + "a".repeat(20_000) + "b*", "a".repeat(40_000) + "c")).toBe(false)
    expect(performance.now() - started).toBeLessThan(100)
  })

  it.each(["\u2028", "\u2029"])("trailing ** covers single-star paths containing %j", (separator) => {
    FastCheck.assert(
      FastCheck.property(literalText, literalText, (before, after) => {
        const path = `src/a${before}${separator}${after}b.ts`
        expect(Schema.is(FileSet.Pattern)(path)).toBe(true)
        expect(FileSet.matchesPattern("src/*", path)).toBe(true)
        expect(FileSet.matchesPattern("src/**", path)).toBe(true)
        const glob: FileSet.Glob = { _tag: "Glob", include: ["src/**"] }
        expect(FileSet.overlaps(glob, path)).toBe(true)
        expect(FileSet.overlaps(path, glob)).toBe(true)
      }),
      { ...params, examples: [["", ""]] }
    )
  })

  it("a single `*` matches any separator-free text but never crosses a separator", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.array(segmentPieces, { minLength: 1, maxLength: 4 }),
        FastCheck.array(filler, { minLength: 1, maxLength: 4 }),
        literalText,
        (segments, fillers, extra) => {
          const pattern = segments
            .map((pieces) => pieces.map((part) => (part.star ? "*" : part.text)).join(""))
            .join("/")
          let next = 0
          const pathSegments = segments.map((pieces) =>
            pieces.map((part) => (part.star ? fillers[next++ % fillers.length]! : part.text)).join("")
          )
          const path = pathSegments.join("/")
          // Completeness: every star absorbs its separator-free filler and
          // every escaped metacharacter matches itself literally.
          expect(FileSet.matchesPattern(pattern, path)).toBe(true)
          // Separator confinement: one extra segment can never match a
          // pattern without `**`.
          expect(FileSet.matchesPattern(pattern, `${path}/${extra}`)).toBe(false)
          // A separator inside a star's filler must break the match.
          if (segments.some((pieces) => pieces.some((part) => part.star))) {
            let replaced = false
            const crossed = segments.map((pieces) =>
              pieces.map((part) => {
                if (!part.star) return part.text
                const value = fillers[next++ % fillers.length]!
                if (replaced) return value
                replaced = true
                return `${value}/${value}`
              }).join("")
            ).join("/")
            expect(FileSet.matchesPattern(pattern, crossed)).toBe(false)
          }
        }
      ),
      params
    )
  })

  it("`**` crosses any number of whole segments, `*` crosses exactly one, a trailing `**` needs at least one", () => {
    FastCheck.assert(
      FastCheck.property(
        literalText,
        literalText,
        FastCheck.array(fillerNonEmpty, { maxLength: 3 }),
        (head, tail, between) => {
          const path = [head, ...between, tail].join("/")
          expect(FileSet.matchesPattern(`${head}/**/${tail}`, path)).toBe(true)
          expect(FileSet.matchesPattern(`${head}/*/${tail}`, path)).toBe(between.length === 1)
          expect(FileSet.matchesPattern(`${head}/**`, [head, ...between].join("/"))).toBe(between.length > 0)
        }
      ),
      params
    )
  })
})

// --- overlap: symmetric, and conservative against the boundary's own matcher --

/** A tiny alphabet keeps entry pairs colliding often enough to matter. */
const tinySegment = FastCheck.constantFrom("a", "b", "c", "a.b", "*", "\u00e9", "e\u0301")

const tinyPattern = FastCheck.array(
  FastCheck.oneof(tinySegment, FastCheck.constantFrom("*", "**")),
  { minLength: 1, maxLength: 3 }
).map((segments) => segments.join("/"))

const tinyPath = FastCheck.array(tinySegment, { minLength: 1, maxLength: 4 }).map((segments) => segments.join("/"))

const tinyGlob: FastCheck.Arbitrary<FileSet.Glob> = FastCheck.tuple(
  tinyPattern,
  FastCheck.array(tinyPattern, { maxLength: 2 }),
  FastCheck.oneof(FastCheck.constant(undefined), FastCheck.array(tinyPattern, { maxLength: 2 }))
).map(([head, rest, exclude]) => ({
  _tag: "Glob",
  include: [head, ...rest],
  ...(exclude === undefined ? {} : { exclude })
}))

const tinyEntry: FastCheck.Arbitrary<FileSet.Entry> = FastCheck.oneof(
  tinyPath,
  tinyGlob,
  tinyPath.map((path): FileSet.TreeArtifact => ({ _tag: "TreeArtifact", path }))
)

const normalizeEntry = (entry: FileSet.Entry, form: "NFC" | "NFD"): FileSet.Entry => {
  if (typeof entry === "string") return entry.normalize(form)
  if (entry._tag === "TreeArtifact") return { ...entry, path: entry.path.normalize(form) }
  const include: [string, ...Array<string>] = [
    entry.include[0].normalize(form),
    ...entry.include.slice(1).map((pattern) => pattern.normalize(form))
  ]
  return {
    ...entry,
    include,
    ...(entry.exclude === undefined
      ? {}
      : { exclude: entry.exclude.map((pattern) => pattern.normalize(form)) })
  }
}

/**
 * The execution boundary's own membership rule (StepBoundary `declaredCovers`):
 * a plain string is a literal path, a tree artifact covers its subtree, and a
 * glob matches with exclusions.
 */
const covers = (entry: FileSet.Entry, path: string): boolean =>
  typeof entry === "string"
    ? entry === path
    : entry._tag === "TreeArtifact"
    ? path === entry.path || path.startsWith(`${entry.path}/`)
    : FileSet.matchesGlob(entry, path)

describe("FileSet.overlaps properties", () => {
  it("is symmetric for every entry pair", () => {
    FastCheck.assert(
      FastCheck.property(tinyEntry, tinyEntry, (left, right) => {
        expect(FileSet.overlaps(left, right)).toBe(FileSet.overlaps(right, left))
      }),
      params
    )
  })

  it("is conservative: a path covered by both entries proves overlap", () => {
    FastCheck.assert(
      FastCheck.property(tinyEntry, tinyEntry, tinyPath, (left, right, path) => {
        if (covers(left, path) && covers(right, path)) {
          expect(FileSet.overlaps(left, right)).toBe(true)
        }
      }),
      {
        ...params,
        examples: [
          ["a/b", { _tag: "TreeArtifact", path: "a" }, "a/b"],
          [{ _tag: "Glob", include: ["**"] }, "a/b/c", "a/b/c"],
          ["a/*", { _tag: "Glob", include: ["a/*"] }, "a/*"]
        ]
      }
    )
  })

  it("is invariant under NFC and NFD spellings", () => {
    FastCheck.assert(
      FastCheck.property(tinyEntry, tinyEntry, (left, right) => {
        expect(FileSet.overlaps(normalizeEntry(left, "NFC"), normalizeEntry(right, "NFC"))).toBe(
          FileSet.overlaps(normalizeEntry(left, "NFD"), normalizeEntry(right, "NFD"))
        )
      }),
      {
        ...params,
        examples: [
          ["caf\u00e9.txt", "cafe\u0301.txt"],
          [{ _tag: "Glob", include: ["caf\u00e9.*"] }, "cafe\u0301.txt"]
        ]
      }
    )
  })
})
