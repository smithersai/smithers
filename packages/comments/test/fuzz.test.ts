import { describe, expect, it } from "@effect/vitest"
import { Fuzz } from "@smthrs/fuzz"
import * as Arbitrary from "effect/Arbitrary"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { Lexer, Sidecar, VirtualFile } from "../src/index.ts"

const TokenPiece = Schema.Literals([
  "//",
  "/*",
  "*/",
  "/**",
  "#",
  "--",
  "<!--",
  "-->",
  "\"",
  "'",
  "`",
  "\\",
  "${",
  "}",
  "\n",
  "\r\n",
  " ",
  "foo",
  "export function a() {}",
  "@ts-expect-error",
  "SPDX-License-Identifier: MIT",
  "/regex/",
  "## @id\n",
  "---\n"
])

const AdversarialInput = Schema.Struct({
  ext: Schema.Literals([".ts", ".rs", ".py", ".sql", ".html"]),
  pieces: Schema.Array(TokenPiece)
})

const AdversarialSidecar = Schema.Struct({
  pieces: Schema.Array(
    Schema.Literals([
      "---\n",
      "source: src/a.ts\n",
      "version: 1\n",
      "version: 2\n",
      "## @id1\n",
      "## @id2\n",
      "\\## @escaped\n",
      "anchor: file\n",
      "anchor: line 1\n",
      "anchor: line 0\n",
      "anchor: symbol foo\n",
      "anchor: pattern bar\n",
      "placement: before\n",
      "placement: inline\n",
      "placement: after\n",
      "style: line\n",
      "style: block\n",
      "style: doc\n",
      "code-hash: deadbeef\n",
      "\n",
      "body text here\n",
      "bad: field\n"
    ])
  )
})

describe("Feedback-guided fuzzing (@smthrs/fuzz)", () => {
  it.effect(
    "fuzzes Lexer across all language families: never throws, offsets strictly ordered & in-bounds",
    () =>
      Effect.gen(function*() {
        const report = yield* Fuzz.run(
          Arbitrary.schema(AdversarialInput),
          (input) =>
            Effect.gen(function*() {
              const source = input.pieces.join("")
              const res = Lexer.lexComments(source, `fuzz/sample${input.ext}`)
              yield* Fuzz.observe(`ext:${input.ext}`)
              yield* Fuzz.observe(`comments:${Math.min(res.comments.length, 5)}`)

              let prevEnd = 0
              for (const c of res.comments) {
                if (c.startOffset < prevEnd || c.endOffset <= c.startOffset || c.endOffset > source.length) {
                  return false
                }
                if (source.slice(c.startOffset, c.endOffset) !== c.raw) {
                  return false
                }
                if (c.startLine < 1 || c.endLine < c.startLine) {
                  return false
                }
                prevEnd = c.endOffset
              }

              const stripped = Lexer.stripProseComments(source, `fuzz/sample${input.ext}`)
              return stripped.code.length <= source.length
            }),
          { seed: 42, executions: 1_500 }
        )

        expect(report._tag).toBe("Passed")
      }),
    30_000
  )

  it.effect(
    "fuzzes Sidecar parser: always returns valid SidecarDocument or typed SidecarParseError",
    () =>
      Effect.gen(function*() {
        const report = yield* Fuzz.run(
          Arbitrary.schema(AdversarialSidecar),
          (input) =>
            Effect.gen(function*() {
              const raw = input.pieces.join("")
              const exit = yield* Effect.exit(Sidecar.parseSidecar(raw))
              if (Exit.isFailure(exit)) {
                yield* Fuzz.observe("sidecar:err")
                return true
              }
              yield* Fuzz.observe("sidecar:ok")
              yield* Fuzz.observe(`entries:${Math.min(exit.value.entries.length, 4)}`)
              const formatted = Sidecar.formatSidecar(exit.value)
              const reparsed = yield* Effect.exit(Sidecar.parseSidecar(formatted))
              if (Exit.isFailure(reparsed)) return false
              return JSON.stringify(reparsed.value) === JSON.stringify(exit.value)
            }),
          { seed: 1337, executions: 1_500 }
        )

        expect(report._tag).toBe("Passed")
      }),
    30_000
  )

  it.effect(
    "fuzzes VirtualFile projector with adversarial source + entries: deterministic and crash-free",
    () =>
      Effect.gen(function*() {
        const report = yield* Fuzz.run(
          Arbitrary.schema(AdversarialInput),
          (input) =>
            Effect.gen(function*() {
              const source = input.pieces.join("")
              const filePath = `src/fuzzed${input.ext}`
              const sidecar: Sidecar.SidecarDocument = {
                source: filePath,
                version: 1,
                entries: [
                  {
                    id: "f1",
                    anchor: { kind: "file" },
                    placement: "before",
                    style: "line",
                    body: "Fuzzed header note"
                  },
                  {
                    id: "f2",
                    anchor: { kind: "line", line: 1 },
                    placement: "after",
                    style: "block",
                    body: "Fuzzed trailing note"
                  }
                ]
              }
              const exit1 = yield* Effect.exit(
                VirtualFile.projectFile(source, sidecar, filePath, { onUnresolved: "skip" })
              )
              const exit2 = yield* Effect.exit(
                VirtualFile.projectFile(source, sidecar, filePath, { onUnresolved: "skip" })
              )
              if (Exit.isFailure(exit1) || Exit.isFailure(exit2)) {
                yield* Fuzz.observe("proj:err")
                return Exit.isFailure(exit1) && Exit.isFailure(exit2)
              }
              yield* Fuzz.observe("proj:ok")
              return exit1.value.content === exit2.value.content && exit1.value.digest === exit2.value.digest
            }),
          { seed: 99, executions: 800 }
        )

        expect(report._tag).toBe("Passed")
      }),
    30_000
  )
})
