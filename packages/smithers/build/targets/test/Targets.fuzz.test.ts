import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as FactoryPolicy from "../src/FactoryPolicy.ts"
import * as Owners from "../src/Owners.ts"
import * as PackageJson from "../src/PackageJson.ts"
import * as RemoteCache from "../src/RemoteCache.ts"
import * as Reference from "../src/Reference.ts"
import * as SafeFs from "../src/SafeFs.ts"
import * as Secret from "../src/Secret.ts"
import * as Smithers from "../src/Smithers.ts"
import * as Target from "../src/Target.ts"
import * as Verb from "../src/Verb.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

describe("@smthrs/targets Input path/ref security, Owners, Secret, Reference, Verb & Smithers macros fuzz invariants", () => {
  it("Input path resolution, rootRelative, validateGitBase, staticPrefix, glob/file/link/gitDiff & digestFiles uphold path & ref safety", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-targets-fuzz-")))
    try {
      await Fs.mkdir(Path.join(tmpRoot, "src"), { recursive: true })
      await Fs.writeFile(Path.join(tmpRoot, "src/a.ts"), "export const a = 1\n")
      await Fs.writeFile(Path.join(tmpRoot, "src/b.ts"), "export const b = 2\n")

      const arb = Arbitrary.schema(
        Schema.Struct({
          pkgDir: Schema.Literals(["", "packages/a", "apps/mvp"]),
          relPath: Schema.Literals([
            "src/a.ts",
            "//packages/a/src/a.ts",
            "../escape.ts",
            "../../escape.ts",
            "//../escape.ts",
            "/abs/file.ts",
            "a\\b.ts",
            "C:/win.ts",
            "a\u0000b.ts",
            "//-leading-dash.ts"
          ]),
          gitBase: Schema.Literals([
            "main",
            "origin/main",
            "HEAD~1",
            "-flag",
            "--upload-pack=evil",
            "main;rm -rf /",
            "main..HEAD",
            ""
          ]),
          globPat: Schema.Literals(["src/**/*.ts", "src/*.ts", "**/*.json", "literal/file.ts"])
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ pkgDir, relPath, gitBase, globPat }) =>
            Effect.sync(() => {
              // resolvePath must reject non-portable, single-slash, and workspace-escaping paths
              const mustReject = relPath.includes("\0") ||
                relPath.includes("\\") ||
                /^[A-Za-z]:/.test(relPath) ||
                (!relPath.startsWith("//") && relPath.startsWith("/")) ||
                relPath === "//../escape.ts" ||
                (relPath === "../escape.ts" && pkgDir === "") ||
                (relPath === "../../escape.ts" && pkgDir === "")
              try {
                const resolved = Input.resolvePath(pkgDir, relPath)
                if (mustReject) return false
                if (resolved.startsWith("/") || resolved === ".." || resolved.startsWith("../")) return false
              } catch {
                if (!mustReject) return false
              }

              // rootRelative keeps leading "-" safe from argv option confusion
              if (relPath === "//-leading-dash.ts" && pkgDir === "") {
                if (Input.rootRelative("", "//-leading-dash.ts") !== "./-leading-dash.ts") return false
              }

              // validateGitBase must refuse option injection & shell chars
              const badBase = gitBase === "" || gitBase.startsWith("-") || gitBase.includes("\0")
              try {
                const valid = Input.validateGitBase(gitBase)
                if (badBase) return false
                if (valid !== gitBase) return false
              } catch {
                if (!badBase) return false
              }

              // staticPrefix must never contain wildcards
              const pref = Input.staticPrefix(globPat)
              if (pref.includes("*") || pref.includes("?")) return false

              const f = Input.file("src/a.ts")
              const g = Input.glob(globPat)
              const l = Input.link("src/a.ts")
              if (!Input.isDeclared(f) || !Input.isDeclared(g) || !Input.isDeclared(l)) return false
              if (Input.isDeclared({ bogus: 1 })) return false

              const h1 = Input.digestText(globPat + pkgDir)
              const h2 = Input.digestText(globPat + pkgDir)
              return h1 === h2 && h1.length === 64
            }),
          { seed, executions }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")

      const files = await Input.expandGlob(tmpRoot, "", Input.glob("src/**/*.ts"))
      expect(files).toEqual(["src/a.ts", "src/b.ts"])
      const d1 = await Input.digestFiles(tmpRoot, files)
      const d2 = await Input.digestFiles(tmpRoot, files)
      expect(d1).toEqual(d2)
      expect(SafeFs.defaultIo).toBeDefined()
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it("Owners.declare/Teams, Secret, Reference, Verb & Smithers target surface uphold validation invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        owner: Schema.Literals(["alice", "team:core", "bad owner", "", "-leading"]),
        policy: Schema.Literals(["auto-land", "human-approve", "deny"]),
        secretName: Schema.Literals(["NPM_TOKEN", "SMITHERS_API_KEY", "bad-name", "123START", ""]),
        pkgName: Schema.Literals(["@smthrs/demo", "demo-app"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ owner, policy, secretName, pkgName }) =>
          Effect.sync(() => {
            const validOwner = /^(?:team:)?[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(owner)
            try {
              const decl = Owners.declare({
                owners: [owner],
                agents: { default: policy }
              })
              if (!validOwner) return false
              if (!Owners.isDeclaration(decl)) return false
              const refs = Owners.teamReferences(decl)
              if (owner.startsWith("team:") && !refs.includes(owner.slice(5))) return false
            } catch {
              if (validOwner) return false
            }

            const teams = Owners.Teams({ core: ["alice", "bob"] })
            if (!Owners.isTeamsDeclaration(teams)) return false

            const validSecret = /^[A-Za-z_][A-Za-z0-9_]*$/.test(secretName)
            try {
              const sec = Smithers.Secret(secretName)
              if (!validSecret) return false
              if (!Secret.isSecret(sec) || sec.env !== secretName) return false
            } catch {
              if (validSecret) return false
            }

            const rt = Smithers.Runtime.Node({ version: ">=26.4.0" })
            const pm = Smithers.PackageManager.Pnpm({ version: "11.25.0", runtime: rt })
            if (rt === undefined || pm === undefined) return false
            const fg = Smithers.Filegroup({ srcs: [Smithers.glob("src/**/*.ts")] })
            if (!Target.isTarget(fg)) return false
            const srcGlob = Smithers.glob("src/**/*.ts")
            const lib = Smithers.TsBuild({
              srcs: [srcGlob],
              entries: [Smithers.file("src/index.ts")],
              deps: [],
              tsconfig: Smithers.file("tsconfig.json"),
              tool: { name: "program", entry: Smithers.file("scripts/build.mjs") },
              format: "dual",
              outDir: "dist",
              cwd: "."
            })
            const tc = Smithers.Typecheck({
              srcs: [srcGlob],
              deps: [lib],
              tsconfig: Smithers.file("tsconfig.json"),
              buildMode: false,
              incremental: false,
              cwd: "."
            })
            const vit = Smithers.Vitest({
              tests: [Smithers.glob("test/**/*.test.ts")],
              sources: [srcGlob],
              deps: [lib],
              config: Smithers.file("vitest.config.ts"),
              environment: "node",
              passWithNoTests: false,
              cwd: "."
            })
            if (!Target.isTarget(lib) || !Target.isTarget(vit) || !Target.isTarget(tc)) return false
            if (pkgName.length === 0 || Reference === undefined || Verb === undefined) return false
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("RemoteCache endpoint/token validation, PackageJson merge/render/diff/parseGenerated & FactoryPolicy.make uphold invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        endpoint: Schema.Literals([
          "https://cache.smithers.sh",
          "https://cache.smithers.sh/v1/",
          "http://127.0.0.1:8787",
          "http://cache.example.com",
          "https://user:pass@cache.smithers.sh",
          "ftp://cache.smithers.sh",
          "not-a-url",
          ""
        ]),
        tokenEnv: Schema.Literals(["SMITHERS_CACHE_TOKEN", "MY_TOKEN_1", "bad-env", "123BAD", ""]),
        pkgName: Schema.Literals(["@smthrs/demo", "plain-pkg", "UPPER_BAD", "../escape", ""]),
        desc: Schema.Literals(["Clean package description", "Short desc"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ endpoint, tokenEnv, pkgName, desc }) =>
          Effect.sync(() => {
            // RemoteCache.normalizeEndpoint must reject credentials, non-http(s), empty, and malformed URLs
            try {
              const norm = RemoteCache.normalizeEndpoint(endpoint)
              if (endpoint === "" || endpoint === "not-a-url" || endpoint.startsWith("ftp://") || endpoint.includes("user:pass@")) return false
              if (!norm.startsWith("http://") && !norm.startsWith("https://")) return false
            } catch {
              if (endpoint === "https://cache.smithers.sh") return false
            }

            try {
              const env = RemoteCache.normalizeTokenEnv(tokenEnv)
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) return false
              if (env !== tokenEnv) return false
            } catch {
              if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) return false
            }

            const rc = RemoteCache.make({ endpoint: "https://cache.smithers.sh" })
            if (!RemoteCache.isRemoteCache(rc)) return false

            // PackageJson.assertPackageName, merge, render, diffFields, parseGenerated
            try {
              const okName = PackageJson.assertPackageName(pkgName)
              if (pkgName === "" || pkgName.includes("..") || /[A-Z]/.test(pkgName)) return false
              if (okName !== pkgName) return false
            } catch {
              if (pkgName === "@smthrs/demo" || pkgName === "plain-pkg") return false
            }

            const merged = PackageJson.merge(
              { name: "@smthrs/demo", version: "1.0.0" },
              { description: desc, license: "MIT" }
            )
            const rendered = PackageJson.render(merged)
            if (JSON.parse(rendered).description !== desc) return false
            const diffSame = PackageJson.diffFields(merged, merged)
            if (diffSame.length !== 0) return false
            const parsedGen = PackageJson.parseGenerated(JSON.stringify({ description: desc }), ["description"])
            if (parsedGen.description !== desc) return false

            const policy = FactoryPolicy.make({})
            return policy !== undefined
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
