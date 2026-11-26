import { Migrations } from "@smthrs/effect-tanstack-db"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Logger, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as EditorTab from "./device/editorTab.ts"
import * as OlderLeader from "./device/olderLeader.ts"
import { deviceRegistry } from "./device/registry.ts"
import * as DocumentLocale from "./documentLocale.ts"
import * as ErrorCode from "./errorCode.ts"
import * as RepoPaths from "./features/repo/paths.ts"
import * as PersonOnly from "./flows/personOnly.ts"
import * as ShapeApplied from "./shapeApplied.vibe"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "300"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")
const silentLogger = Logger.layer([])

describe("apps/mvp core src module fuzz invariants", () => {
  it("RepoPaths: resolveRef longest-prefix & branch-over-tag, parseLines/parseLineHash bounds, hrefFor/editHrefFor/viewHrefFor & copyPayloadOf", async () => {
    const sha40 = "0123456789abcdef0123456789abcdef01234567"
    const arb = Arbitrary.schema(
      Schema.Struct({
        ref: Schema.NullOr(Schema.Literals(["main", "feat", "release", sha40, "unknown"])),
        splat: Schema.Literals(["", "v1/src/index.ts", "nested/file.md", "src/app.ts", "dir///"]),
        lineInput: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(32))),
          Schema.Literals([
            "1",
            "5-10",
            "10-5",
            "0",
            "-3",
            "10-10",
            "999999999",
            "1000000000",
            "L5",
            "#L5-L20",
            "#L20-L5"
          ])
        ]),
        kind: Schema.Literals(["tree", "blob"]),
        editFiles: Schema.Boolean,
        copyWhat: Schema.Literals(["clone-url", "path", "permalink", "contents"]),
        hasSha: Schema.Boolean,
        owner: Schema.Literals(["Acme", "smithersai"]),
        repo: Schema.Literals(["App", "widgets"]),
        filePath: Schema.Literals(["", "README.md", "docs/guide.markdown", "src/index.ts", "dir/sub/file 1.ts"])
      })
    )
    const refs: RepoPaths.KnownRefs = {
      branches: [
        { name: "feat/v1", sha: "1111111111111111111111111111111111111111" },
        { name: "feat", sha: "2222222222222222222222222222222222222222" },
        { name: "release", sha: "3333333333333333333333333333333333333333" }
      ],
      tags: [
        { name: "release", sha: "4444444444444444444444444444444444444444" }
      ]
    }
    const repoMeta = { defaultBranch: "main", headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ ref, splat, lineInput, kind, editFiles, copyWhat, hasSha, owner, repo, filePath }) =>
          Effect.sync(() => {
            const resolved = RepoPaths.resolveRef(repoMeta, ref, splat, refs)
            if (ref === sha40) {
              if (resolved === undefined || resolved.sha !== sha40 || resolved.path !== splat) return false
            }
            if (ref === "feat" && splat.startsWith("v1/")) {
              // Longest prefix "feat/v1" MUST win over shorter "feat"
              if (resolved === undefined || resolved.revision !== "feat/v1") return false
            }
            if (ref === "release") {
              // Branch MUST win over tag of same name
              if (resolved === undefined || resolved.sha !== "3333333333333333333333333333333333333333") return false
            }
            if (ref === "unknown" && resolved !== undefined) return false

            // parseLines & parseLineHash invariants: line >= 1, lineEnd === null || lineEnd > line
            const pl = RepoPaths.parseLines(lineInput)
            if (pl.line !== null && pl.line < 1) return false
            if (pl.lineEnd !== null && (pl.line === null || pl.lineEnd <= pl.line)) return false
            const ph = RepoPaths.parseLineHash(lineInput)
            if (ph.line !== null && ph.line < 1) return false
            if (ph.lineEnd !== null && (ph.line === null || ph.lineEnd <= ph.line)) return false

            // hrefFor / editHrefFor / viewHrefFor
            const loc: RepoPaths.Location = {
              kind,
              path: filePath,
              ...(pl.line !== null ? { line: pl.line } : {}),
              ...(pl.lineEnd !== null ? { lineEnd: pl.lineEnd } : {})
            }
            const vh = RepoPaths.viewHrefFor({ owner, name: repo, defaultBranch: "main" }, "main", loc, editFiles)
            if (editFiles && kind === "blob" && !RepoPaths.isMarkdownPath(filePath)) {
              if (!vh.includes("?edit=")) return false
            } else {
              if (vh !== RepoPaths.hrefFor({ owner, name: repo, defaultBranch: "main" }, "main", loc)) return false
            }

            // targetOf strips trailing slashes and drops line anchors on tree routes
            const target = RepoPaths.targetOf(
              kind,
              { owner, repo, ref: ref ?? undefined, _splat: splat },
              RepoPaths.lineSearch({ L: lineInput, extra: "drop" })
            )
            if (target.path.endsWith("/")) return false
            if (kind === "tree" && (target.line !== null || target.lineEnd !== null)) return false

            // copyPayloadOf
            const cp = RepoPaths.copyPayloadOf(
              {
                owner,
                name: repo,
                kind,
                path: filePath,
                sha: hasSha ? sha40 : null,
                line: pl.line,
                lineEnd: pl.lineEnd
              },
              copyWhat
            )
            if (copyWhat === "clone-url" && cp === undefined) return false
            if (copyWhat === "path" && (filePath === "") !== (cp === undefined)) return false
            if ((copyWhat === "permalink" || copyWhat === "contents") && !hasSha && cp !== undefined) return false

            // staysInRepository is case-insensitive
            if (
              !RepoPaths.staysInRepository(`/${owner.toLowerCase()}/${repo.toUpperCase()}/tree/main`, { owner, repo })
            ) {
              return false
            }
            if (RepoPaths.staysInRepository(undefined, { owner, repo })) return false

            // canonicalRepoHref returns undefined when unchanged
            const canonical = RepoPaths.canonicalRepoHref(
              { pathname: `/${owner}/${repo}/tree/main`, searchStr: "", hash: "" },
              { owner, repo },
              `${owner}/${repo}`,
              false
            )
            if (canonical !== undefined) return false
            // readmeOf finds direct README.md case-insensitively only in target dir
            if (RepoPaths.readmeOf(["a/README.md", "b/readme.md"], "a") !== "a/README.md") return false
            if (RepoPaths.readmeOf(["a/sub/README.md"], "a") !== undefined) return false
            // keys are non-empty and structured
            if (!RepoPaths.treeKey("id", sha40).includes("@")) return false
            if (!RepoPaths.blobKey("id", sha40, filePath).includes(":")) return false
            if (!RepoPaths.refsKey("id", sha40, null).endsWith("@")) return false
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("ErrorCode.codeOf NEVER leaks arbitrary messages or non-identifier strings", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        tag: Schema.Union([
          Schema.Undefined,
          Schema.Literals(["SqlError", "HttpClientError", "CustomTag", "has spaces secret payload", "x".repeat(80)])
        ]),
        code: Schema.Union([
          Schema.Undefined,
          Schema.Literals(["forbidden", "rate_limited", "Bearer sk-secret-token", ""])
        ]),
        name: Schema.Union([Schema.Undefined, Schema.Literals(["Error", "TypeError", "bad name\nsecret"])]),
        reasonTag: Schema.Union([
          Schema.Undefined,
          Schema.Literals(["TransportError", "StatusCodeError", "bad reason!"])
        ]),
        message: Schema.String.pipe(Schema.check(Schema.isMaxLength(120)))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ tag, code, name, reasonTag, message }) =>
          Effect.sync(() => {
            const obj = {
              _tag: tag,
              code,
              name,
              message,
              reason: reasonTag === undefined ? undefined : { _tag: reasonTag }
            }
            const out = ErrorCode.codeOf(obj)
            if (!/^(?:(?:sql|http):)?[A-Za-z0-9_.:/@-]{1,64}$/.test(out)) return false
            if (ErrorCode.codeOf(null) !== "unknown" || ErrorCode.codeOf(message) !== "unknown") return false
            if (tag === "SqlError" && reasonTag === "TransportError" && out !== "sql:TransportError") return false
            if (tag === "HttpClientError" && reasonTag === "StatusCodeError" && out !== "http:StatusCodeError") {
              return false
            }
            if (name === "Error" && tag === undefined && code === undefined && out !== "unknown") return false
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("DocumentLocale.documentLocale never throws, always returns valid dir, and classifies RTL scripts accurately", async () => {
    const arb = Arbitrary.schema(
      Schema.Union([
        Schema.String.pipe(Schema.check(Schema.isMaxLength(40))),
        Schema.Literals([
          "en",
          "en-US",
          "ar",
          "ar-EG",
          "he",
          "fa",
          "ur",
          "dv",
          "en-Arab",
          "ar-Latn",
          "ja-JP",
          "zh-Hans",
          "",
          "!!!invalid!!!"
        ])
      ])
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (language) =>
          Effect.sync(() => {
            const res = DocumentLocale.documentLocale(language)
            if (res.dir !== "ltr" && res.dir !== "rtl") return false
            if (res.lang.length === 0) return false
            if ((language === "ar" || language === "he" || language === "en-Arab") && res.dir !== "rtl") return false
            if ((language === "en-US" || language === "ar-Latn" || language === "ja-JP") && res.dir !== "ltr") {
              return false
            }
            const root = { lang: "", dir: "" }
            DocumentLocale.applyDocumentLocale(root, language)
            return root.lang === res.lang && root.dir === res.dir
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("PersonOnly.refusesCredential is true iff flow is a route-enforced person-only flow and immune to prototype keys", async () => {
    const knownFlows = Object.keys(PersonOnly.PERSON_ONLY_FLOWS)
    const arb = Arbitrary.schema(
      Schema.Union([
        Schema.String.pipe(Schema.check(Schema.isMaxLength(48))),
        Schema.Literals([...knownFlows, "toString", "constructor", "__proto__", "valueOf", "repo/read"])
      ])
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (flow) =>
          Effect.sync(() => {
            const refused = PersonOnly.refusesCredential(flow)
            if (Object.hasOwn(PersonOnly.PERSON_ONLY_FLOWS, flow)) {
              const enforcement = PersonOnly.PERSON_ONLY_FLOWS[flow as PersonOnly.PersonOnlyFlow]
              return refused === ("route" in enforcement)
            }
            return refused === false
          }),
        { seed: seed + 3, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("OlderLeader.olderLeader & watchLeader, EditorTab.claimEditorTabId, and ShapeApplied.observeInitialApplied uphold durability invariants", async () => {
    const registry = deviceRegistry
    const issueWritesVersion = Migrations.declarationOf(registry, "issue-writes")!.schemaVersion
    const todosVersion = Migrations.declarationOf(registry, "todos")!.schemaVersion
    const arb = Arbitrary.schema(
      Schema.Struct({
        collection: Schema.Literals(["issue-writes", "todos", "unknown-col"]),
        found: Schema.Literals(["1", "2", "3", "5", "missing"]),
        expected: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 8 }))),
        hasLocks: Schema.Boolean,
        lockHeld: Schema.Boolean,
        lockThrows: Schema.Boolean,
        storageThrows: Schema.Boolean,
        storageDrops: Schema.Boolean,
        preloadFails: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ collection, found, expected, hasLocks, lockHeld, lockThrows, storageThrows, storageDrops, preloadFails }) =>
          Effect.gen(function*() {
            const msg = `Schema version mismatch for collection "${collection}": found ${found}, expected ${expected}`
            const isOlder = OlderLeader.olderLeader(registry, new Error(msg))
            const ours = collection === "issue-writes"
              ? issueWritesVersion
              : collection === "todos"
              ? todosVersion
              : undefined
            if (isOlder !== (ours !== undefined && expected < ours)) return false
            if (OlderLeader.olderLeader(registry, "unrelated error")) return false

            // EditorTab.claimEditorTabId never throws and only reports persistent: true when lock + storage succeed
            let saved: string | null = null
            const tab = yield* Effect.promise(() =>
              EditorTab.claimEditorTabId({
                storage: {
                  getItem: () => {
                    if (storageThrows) throw new Error("quota")
                    return storageDrops ? null : saved
                  },
                  setItem: (_k, v) => {
                    if (storageThrows) throw new Error("quota")
                    saved = v
                  }
                },
                locks: !hasLocks
                  ? undefined
                  : {
                    request: ((_name: string, _opts: unknown, cb: (lock: Lock | null) => Promise<void> | void) => {
                      if (lockThrows) return Promise.reject(new Error("denied"))
                      if (lockHeld) return Promise.resolve(cb(null))
                      return Promise.resolve(cb({ name: _name, mode: "exclusive" } as Lock))
                    }) as unknown as LockManager["request"]
                  },
                page: { addEventListener: () => {} },
                randomId: () => "550e8400-e29b-41d4-a716-446655440000"
              })
            )
            const expectedPersistent = hasLocks && !lockHeld && !lockThrows && !storageThrows && !storageDrops
            if (tab.persistent !== expectedPersistent) return false
            if (!tab.persistent && tab.reason === undefined) return false

            // ShapeApplied.observeInitialApplied never fails (swallows errors via Effect.ignore) and runs both barriers on success
            let applied = false
            yield* ShapeApplied.observeInitialApplied(
              {
                preload: preloadFails ? Effect.fail({ _tag: "LoadFailed" } as never) : Effect.void,
                currentApplied: Effect.sync(() => {
                  applied = true
                })
              },
              "todos",
              "github/acme/app"
            ).pipe(Effect.provide(silentLogger))
            if (applied !== !preloadFails) return false
            return true
          }),
        { seed: seed + 4, executions: Math.min(executions, 200) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
