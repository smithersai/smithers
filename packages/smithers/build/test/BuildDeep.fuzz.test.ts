import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as BoundedOutput from "../src/internal/boundedOutput.ts"
import * as BunInternal from "../src/internal/bun.ts"
import * as Validate from "../src/internal/validate.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "300" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261201")

describe("@smthrs/build bun lockfile/bunfig parser, validate, boundedOutput & platform deep fuzz", () => {
  it("BunInternal.readLockfile, checkBunfig & reservedAssignment handle JSONC, comments, trailing commas, credentials & attacks", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        lockKind: Schema.Literals([
          "valid_minimal",
          "valid_with_comments_and_workspaces",
          "invalid_json",
          "wrong_version",
          "non_object",
          "bad_workspace_path",
          "patched_dep",
          "file_dep",
          "git_dep",
          "catalog_dep"
        ]),
        bunfigKind: Schema.Literals([
          "empty",
          "registry_token",
          "cafile",
          "preload",
          "safe_install",
          "bad_toml_section"
        ]),
        credential: Schema.Boolean,
        envLine: Schema.Literals([
          "FOO=bar",
          "BUN_CONFIG_REGISTRY=https://evil",
          "export BUN_INSTALL=/tmp/x",
          "NODE_OPTIONS=--require=/tmp/pwn",
          "# comment only\nSAFE=1",
          ""
        ])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ lockKind, bunfigKind, credential, envLine }) =>
          Effect.sync(() => {
            const lockText =
              lockKind === "valid_minimal"
                ? JSON.stringify({ lockfileVersion: 1, workspaces: { "": { name: "app" } }, packages: {} })
                : lockKind === "valid_with_comments_and_workspaces"
                  ? `// top comment\n{\n  /* block */\n  "lockfileVersion": 1,\n  "workspaces": { "": { "name": "root", "dependencies": { "a": "1.0.0" } }, "pkgs/a": { "name": "a" }, },\n  "packages": { "a": ["a@1.0.0", "", {}, "sha512-abc"], },\n}\n`
                  : lockKind === "invalid_json"
                    ? "{ broken json"
                    : lockKind === "wrong_version"
                      ? JSON.stringify({ lockfileVersion: 99, workspaces: {}, packages: {} })
                      : lockKind === "non_object"
                        ? "[]"
                        : lockKind === "bad_workspace_path"
                          ? JSON.stringify({ lockfileVersion: 1, workspaces: { "../escape": { name: "bad" } }, packages: {} })
                          : lockKind === "patched_dep"
                            ? JSON.stringify({
                                lockfileVersion: 1,
                                workspaces: { "": { name: "app" } },
                                patchedDependencies: { "foo@1.0.0": "patches/foo.patch" },
                                packages: {}
                              })
                            : lockKind === "file_dep"
                              ? JSON.stringify({
                                  lockfileVersion: 1,
                                  workspaces: { "": { name: "app" } },
                                  packages: { local: ["local@file:../local", "", {}, ""] }
                                })
                              : lockKind === "git_dep"
                                ? JSON.stringify({
                                    lockfileVersion: 1,
                                    workspaces: { "": { name: "app" } },
                                    packages: { g: ["g@github:owner/repo#abc", "", {}, ""] }
                                  })
                                : JSON.stringify({
                                    lockfileVersion: 1,
                                    workspaces: { "": { name: "app" } },
                                    catalog: { dep: "^1.0.0" },
                                    packages: {}
                                  })

            const lockRes = BunInternal.readLockfile(lockText)
            const refused = BunInternal.isRefusal(lockRes)
            if ((lockKind === "invalid_json" || lockKind === "wrong_version" || lockKind === "non_object" || lockKind === "bad_workspace_path") && !refused) {
              return false
            }

            const bunfigText =
              bunfigKind === "empty"
                ? ""
                : bunfigKind === "registry_token"
                  ? `[install.scopes]\n"@acme" = { token = "secret", url = "https://reg.acme" }\n`
                  : bunfigKind === "cafile"
                    ? `[install]\ncafile = "/etc/ssl/ca.pem"\n`
                    : bunfigKind === "preload"
                      ? `preload = ["./evil.ts"]\n`
                      : bunfigKind === "safe_install"
                        ? `[install]\nfrozenLockfile = true\n`
                        : `[install.cache]\ndir = "/tmp/cache"\n`
            const figRes = BunInternal.checkBunfig(bunfigText, credential)
            if (figRes !== undefined && !BunInternal.isRefusal(figRes)) return false

            const reserved = BunInternal.reservedAssignment(envLine)
            if (reserved !== undefined && typeof reserved !== "string") return false
            return true
          }),
        { seed, executions: Math.min(executions, 150) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Validate, BoundedOutput & Platform helpers enforce strict plain-object, UTF-8, env-name & diagnostic invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        envName: Schema.Literals(["PATH", "FOO_BAR", "BAD=NAME", "", "123BAD", "a\0b", "HOME"]),
        envVal: Schema.Literals(["ok", "val with spaces", "bad\uD800lone", ""]),
        windows: Schema.Boolean,
        badBytes: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ envName, envVal, windows, badBytes }) =>
          Effect.sync(() => {
            const wf = Validate.isWellFormedText(envVal)
            if (envVal.includes("\uD800") && wf) return false
            const len = Validate.utf8ByteLength("hello-世界")
            if (len <= 6) return false
            const usable = Validate.usableText(envVal, 1024)
            if (envVal.includes("\uD800") && usable) return false

            const nameOk = Validate.usableEnvironmentName(envName, windows)
            if ((envName === "" || envName.includes("=") || envName.includes("\0")) && nameOk) return false

            try {
              const norm = Validate.normalizeEnvironment(
                { [envName]: envVal },
                windows,
                "fuzz-env"
              )
              if (typeof norm !== "object") return false
            } catch {
              // expected on invalid env names/values
            }

            try {
              Validate.exactKeys({ a: 1, b: 2 }, new Set(["a"]), "fuzz-keys")
              return false
            } catch {
              // expected unknown key refusal
            }
            const rec = Validate.plainRecord({ a: 1 }, "fuzz-rec")
            if (Validate.ownData(rec, "a", "fuzz-rec") !== 1) return false

            const bytes = badBytes ? new Uint8Array([0xff, 0xfe, 0x80]) : new TextEncoder().encode("valid utf8\n")
            try {
              const dec = BoundedOutput.decodedText(bytes, "sample.txt")
              if (badBytes) return false
              if (!dec.includes("valid utf8")) return false
            } catch {
              if (!badBytes) return false
            }

            return true
          }),
        { seed: seed + 1, executions: Math.min(executions, 150) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
