import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import {
  ACCOUNT_MAX_LENGTH,
  decodeJwtClaims,
  detectHarnessesWith,
  DETECTORS,
  findBinary,
  harnessCandidateDirs,
  type HarnessHost,
  harnessModels,
  harnessModelSpec,
  modelProbeEnv,
  OPENCODE_CEREBRAS_MODEL,
  OPENCODE_KIMI_MODEL,
  parseVersionLine,
  PROBE_ENV_KEYS,
  probeEnv,
  sanitizeDisplayText,
  VERSION_MAX_LENGTH,
  VERSION_TIMEOUT_MS
} from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

// eslint-disable-next-line no-control-regex
const FORBIDDEN_DISPLAY = /\u001b|[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/

const toBase64Url = (value: string): string =>
  Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")

const makeJwt = (payloadJson: string): string =>
  `${toBase64Url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${toBase64Url(payloadJson)}.sig`

const makeHost = (opts: {
  readonly platform?: string
  readonly home?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly files?: Readonly<Record<string, string | null>>
  readonly dirs?: Readonly<Record<string, ReadonlyArray<string>>>
  readonly version?: (binary: string) => Promise<string | null>
  readonly throwOnRead?: boolean
}): HarnessHost => {
  const files = opts.files ?? {}
  const dirs = opts.dirs ?? {}
  return {
    platform: opts.platform ?? "darwin",
    home: opts.home ?? "/Users/alice",
    env: opts.env ?? {},
    listDir: (dir) => dirs[dir] ?? [],
    isFile: (path) => {
      if (opts.throwOnRead === true) throw new Error("EACCES")
      return Object.prototype.hasOwnProperty.call(files, path)
    },
    readText: (path) => {
      if (opts.throwOnRead === true) throw new Error("EIO")
      return Object.prototype.hasOwnProperty.call(files, path) ? (files[path] ?? null) : null
    },
    version: opts.version ?? (async () => "1.2.3")
  }
}

describe("@smthrs/harness-detect fuzz invariants", () => {
  it("sanitizeDisplayText and parseVersionLine strip ANSI/controls/bidi and bound length", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        prefix: Schema.Literals([
          "",
          "\u001b[31m",
          "\u001b]0;title\u0007",
          "\u001b]8;;https://evil\u001b\\",
          "\u001b]unterminated",
          "\u202e\u061c\u200e\u2066",
          "\x00\x07\x1f\x7f\x9f",
          "   \n\n\u001b[32m  \n"
        ]),
        body: Schema.Literals([
          "",
          "   ",
          "2.1.247 (Claude Code)",
          "crush version v0.1.11-rc.1+build.42",
          "custom-banner-without-semver",
          "v" + "9".repeat(120) + ".1.2",
          "x".repeat(VERSION_MAX_LENGTH + 40),
          "line1\nline2 3.4.5"
        ]),
        suffix: Schema.Literals(["", "\u001b[0m", "\u202c\u2069", "\r\n2.0.0", "   "])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ prefix, body, suffix }) =>
          Effect.sync(() => {
            const raw = `${prefix}${body}${suffix}`
            const sanitized = sanitizeDisplayText(raw)
            if (FORBIDDEN_DISPLAY.test(sanitized)) return false
            if (sanitized !== sanitized.trim()) return false
            if (sanitizeDisplayText(sanitized) !== sanitized) return false

            const parsed = parseVersionLine(raw)
            if (parsed !== null) {
              if (parsed.length === 0 || parsed.length > VERSION_MAX_LENGTH) return false
              if (FORBIDDEN_DISPLAY.test(parsed)) return false
            }
            return VERSION_TIMEOUT_MS > 0 && ACCOUNT_MAX_LENGTH > 0
          }),
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("decodeJwtClaims never throws and accepts only JSON object payloads", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        kind: Schema.Literals([
          "object",
          "object-utf8",
          "array",
          "primitive",
          "invalid-json",
          "invalid-base64",
          "no-dot",
          "empty-payload",
          "non-string"
        ]),
        email: Schema.Literals(["alice@example.com", "bob+tag@smithers.ai", "用户@例え.jp", ""]),
        extra: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 999 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ kind, email, extra }) =>
          Effect.sync(() => {
            let input: unknown
            switch (kind) {
              case "object":
                input = makeJwt(JSON.stringify({ email, sub: `u_${extra}`, slash_plus: "a+b/c?d=e" }))
                break
              case "object-utf8":
                input = makeJwt(JSON.stringify({ email: `${email} 🚀`, n: extra }))
                break
              case "array":
                input = makeJwt(JSON.stringify([email, extra]))
                break
              case "primitive":
                input = makeJwt(JSON.stringify(email))
                break
              case "invalid-json":
                input = makeJwt("{not valid json")
                break
              case "invalid-base64":
                input = "aaa.!!!not-base64!!!.ccc"
                break
              case "no-dot":
                input = "single-segment-token"
                break
              case "empty-payload":
                input = "header..sig"
                break
              case "non-string":
                input = extra % 2 === 0 ? null : extra
                break
            }
            const claims = decodeJwtClaims(input)
            if (kind === "object" || kind === "object-utf8") {
              return claims !== null && typeof claims === "object" && !Array.isArray(claims)
            }
            return claims === null
          }),
        { seed: seed + 1, executions }
      )
    )
    assertPassed(report)
  })

  it("probeEnv and modelProbeEnv never leak unapproved secrets and filter relative PATHs", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        platform: Schema.Literals(["posix", "darwin", "linux", "win32", "undefined"]),
        pathKey: Schema.Literals(["PATH", "Path", "path"]),
        pathStyle: Schema.Literals(["mixed", "relative-only", "empty", "missing", "unc"]),
        harnessId: Schema.Literals([
          "claude",
          "codex",
          "gemini",
          "kimi",
          "opencode",
          "opencode-kimi",
          "opencode-cerebras",
          "crush",
          "amp",
          "cursor-agent",
          "hermes",
          "pi",
          "unknown-harness"
        ]),
        hasSecret: Schema.Boolean,
        hasEmptyAllowed: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ platform, pathKey, pathStyle, harnessId, hasSecret, hasEmptyAllowed }) =>
          Effect.sync(() => {
            const isWin = platform === "win32"
            const effectivePlatform = platform === "undefined" ? undefined : platform
            const delim = effectivePlatform === undefined ? NodePath.delimiter : isWin ? ";" : ":"
            const pathVal = pathStyle === "missing"
              ? undefined
              : pathStyle === "empty"
              ? ""
              : pathStyle === "relative-only"
              ? [".", "node_modules/.bin", isWin ? "\\drive-relative" : "rel/bin"].join(delim)
              : pathStyle === "unc"
              ? (isWin ? "\\\\server\\share\\bin;\\bad;C:\\Windows\\System32" : "/usr/bin:./rel")
              : (isWin
                ? "C:\\Tools\\bin;.;relative;\\\\host\\share\\tools"
                : "/usr/local/bin:.:node_modules/.bin:/bin")

            const source: Record<string, string | undefined> = {
              HOME: hasEmptyAllowed ? "" : "/Users/alice",
              LANG: "en_US.UTF-8",
              XDG_CONFIG_HOME: "/Users/alice/.config",
              SMITHERS_CLOUD_TOKEN: hasSecret ? "secret-cloud-token" : undefined,
              GITHUB_TOKEN: hasSecret ? "ghp_secret" : undefined,
              ANTHROPIC_API_KEY: "sk-ant-test",
              OPENAI_API_KEY: "sk-openai-test",
              KIMI_API_KEY: "sk-kimi-test",
              CEREBRAS_API_KEY: "sk-cerebras-test",
              [pathKey]: pathVal
            }

            const base = probeEnv(source, effectivePlatform)
            if (base.NO_COLOR !== "1") return false
            if ("SMITHERS_CLOUD_TOKEN" in base || "GITHUB_TOKEN" in base) return false
            if ("ANTHROPIC_API_KEY" in base || "KIMI_API_KEY" in base || "CEREBRAS_API_KEY" in base) return false
            if (hasEmptyAllowed && "HOME" in base) return false
            if (pathStyle === "relative-only" || pathStyle === "empty" || pathStyle === "missing") {
              if ("PATH" in base) return false
            }
            const allowedBase = new Set<string>(["NO_COLOR", ...PROBE_ENV_KEYS])
            for (const key of Object.keys(base)) {
              if (!allowedBase.has(key)) return false
            }

            const modelEnv = modelProbeEnv(harnessId, source)
            const expectedCreds = new Set(harnessModels(harnessId)?.listCredentials ?? [])
            if ("SMITHERS_CLOUD_TOKEN" in modelEnv || "GITHUB_TOKEN" in modelEnv) return false
            for (const key of Object.keys(modelEnv)) {
              if (!allowedBase.has(key) && !expectedCreds.has(key)) return false
            }
            const spec = harnessModelSpec(harnessId)
            const models = harnessModels(harnessId)
            if ((spec === undefined) !== (models === undefined)) return false
            if (spec !== undefined && spec.flag.length === 0) return false
            return OPENCODE_KIMI_MODEL.includes("/") && OPENCODE_CEREBRAS_MODEL.includes("/")
          }),
        { seed: seed + 2, executions }
      )
    )
    assertPassed(report)
  })

  it("harnessCandidateDirs and findBinary enforce path safety, semver ordering, and platform rules", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        platform: Schema.Literals(["darwin", "linux", "win32", "undefined"]),
        relativeHome: Schema.Boolean,
        binaryName: Schema.Literals([
          "claude",
          "codex",
          "",
          ".",
          "..",
          "sub/bin",
          "sub\\bin",
          "bad\0name"
        ]),
        installLocation: Schema.Literals(["candidate", "nvm", "path", "relative-path", "none"]),
        pathKey: Schema.Literals(["PATH", "Path"]),
        pathextStyle: Schema.Literals(["default", "custom", "mixed-case", "malicious"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ platform, relativeHome, binaryName, installLocation, pathKey, pathextStyle }) =>
          Effect.sync(() => {
            const isWin = platform === "win32"
            const resolvedPlatform = platform === "undefined" ? process.platform : platform
            const pathApi = resolvedPlatform === "win32" ? NodePath.win32 : NodePath.posix
            const home = relativeHome
              ? "relative/home"
              : isWin
              ? "C:\\Users\\alice"
              : "/Users/alice"

            const nvmRoot = pathApi.join(home, ".nvm", "versions", "node")
            const nvmEntries = [
              "v18.2.0",
              "v22.10.1",
              "22.10.1",
              "v20.0.0",
              "v9007199254740993.0.1",
              "v9007199254740992.0.1",
              "not-a-version",
              "v20.1.0\nmalicious"
            ]

            const dirs = harnessCandidateDirs({
              home,
              ...(platform === "undefined" ? {} : { platform }),
              listDir: (dir) => (dir === nvmRoot ? nvmEntries : [])
            })

            if (relativeHome) {
              if (dirs.some((d) => d.includes(".nvm") || d.includes(".local"))) return false
            } else {
              const nvmDirs = dirs.filter((d) => d.includes(".nvm"))
              if (nvmDirs.length !== 6) return false
              if (!nvmDirs[0]!.includes("9007199254740993")) return false
              if (!nvmDirs[1]!.includes("9007199254740992")) return false
              if (!nvmDirs[nvmDirs.length - 1]!.includes("18.2.0")) return false
            }
            if (isWin && dirs.some((d) => d === "/opt/homebrew/bin" || d === "/usr/local/bin")) {
              return false
            }

            const files: Record<string, string> = {}
            const ext = isWin ? ".cmd" : ""
            const validBin = binaryName !== "" && binaryName !== "." && binaryName !== ".."
              && !/[/\\]/.test(binaryName) && !binaryName.includes("\0")
            const absPathDir = isWin ? "D:\\Tools\\bin" : "/custom/bin"
            const relPathDir = isWin ? "relative\\bin" : "./relative/bin"

            if (validBin) {
              if (installLocation === "candidate" && !relativeHome) {
                files[pathApi.join(home, ".local", "bin", `${binaryName}${ext}`)] = "bin"
              } else if (installLocation === "nvm" && !relativeHome) {
                files[pathApi.join(nvmRoot, "v22.10.1", "bin", `${binaryName}${ext}`)] = "bin"
              } else if (installLocation === "path") {
                files[pathApi.join(absPathDir, `${binaryName}${ext}`)] = "bin"
              } else if (installLocation === "relative-path") {
                files[pathApi.join(relPathDir, `${binaryName}${ext}`)] = "bin"
              }
            }

            const env: Record<string, string | undefined> = {
              [pathKey]: `${relPathDir}${pathApi.delimiter}${absPathDir}`
            }
            if (isWin) {
              if (pathextStyle === "custom") env.PATHEXT = ".EXE;.CMD"
              else if (pathextStyle === "mixed-case") env.PathExt = ".CMD;.BAT"
              else if (pathextStyle === "malicious") env.PATHEXT = ";..\\evil;a/b;.CMD"
            }

            const host = makeHost({
              platform: resolvedPlatform,
              home,
              env,
              files,
              dirs: { [nvmRoot]: nvmEntries }
            })
            const found = findBinary(binaryName, host)
            if (!validBin) return found === null
            if (installLocation === "relative-path" || installLocation === "none") return found === null
            if (installLocation === "path" && !isWin && pathKey !== "PATH") return found === null
            if ((installLocation === "candidate" || installLocation === "nvm") && relativeHome) return found === null
            return found !== null && found.endsWith(`${binaryName}${ext}`)
          }),
        { seed: seed + 3, executions }
      )
    )
    assertPassed(report)
  })

  it("detectHarnessesWith exercises every detector auth signal, error isolation, and contract invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        platform: Schema.Literals(["darwin", "linux", "win32"]),
        relativeHome: Schema.Boolean,
        installAll: Schema.Boolean,
        versionMode: Schema.Literals(["ok", "null", "throws", "ansi-dirty"]),
        signalFault: Schema.Boolean,
        authVariant: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5 }))),
        useCustomEnvDirs: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ platform, relativeHome, installAll, versionMode, signalFault, authVariant, useCustomEnvDirs }) =>
          Effect.promise(async () => {
            const isWin = platform === "win32"
            const pathApi = isWin ? NodePath.win32 : NodePath.posix
            const home = relativeHome
              ? "rel/home"
              : isWin
              ? "C:\\Users\\alice"
              : "/Users/alice"
            const binDir = isWin ? "C:\\Tools\\bin" : "/usr/local/bin"
            const ext = isWin ? ".exe" : ""

            const files: Record<string, string | null> = {}
            const env: Record<string, string | undefined> = {
              PATH: binDir
            }

            for (let i = 0; i < DETECTORS.length; i += 1) {
              const det = DETECTORS[i]!
              if (installAll || (i + authVariant) % 2 === 0) {
                files[pathApi.join(binDir, `${det.binary}${ext}`)] = "binary"
              }
            }

            const customRoot = isWin ? "D:\\CustomRoot" : "/opt/custom"
            const xdgData = useCustomEnvDirs ? pathApi.join(customRoot, "data") : pathApi.join(home, ".local", "share")
            const xdgConfig = useCustomEnvDirs ? pathApi.join(customRoot, "config") : pathApi.join(home, ".config")
            const claudeDir = useCustomEnvDirs ? pathApi.join(customRoot, "claude") : pathApi.join(home, ".claude")
            const claudeStateDir = useCustomEnvDirs ? pathApi.join(customRoot, "claude") : home
            const codexDir = useCustomEnvDirs ? pathApi.join(customRoot, "codex") : pathApi.join(home, ".codex")
            const geminiDir = useCustomEnvDirs ? pathApi.join(customRoot, "gemini") : pathApi.join(home, ".gemini")
            const kimiDir = useCustomEnvDirs ? pathApi.join(customRoot, "kimi") : pathApi.join(home, ".kimi")

            if (useCustomEnvDirs) {
              env.XDG_DATA_HOME = xdgData
              env.XDG_CONFIG_HOME = xdgConfig
              env.CLAUDE_CONFIG_DIR = claudeDir
              env.CODEX_HOME = codexDir
              env.GEMINI_DIR = geminiDir
              env.KIMI_SHARE_DIR = kimiDir
            } else {
              env.XDG_DATA_HOME = "relative/data"
              env.CLAUDE_CONFIG_DIR = "relative/claude"
            }

            if (authVariant === 0) {
              const longWithSurrogate = `${"a".repeat(ACCOUNT_MAX_LENGTH - 1)}\uD83D\uDE00`
              files[pathApi.join(claudeStateDir, ".claude.json")] = JSON.stringify({
                oauthAccount: { emailAddress: "alice@anthropic.com", organizationName: longWithSurrogate }
              })
              files[pathApi.join(codexDir, "auth.json")] = JSON.stringify({
                tokens: { id_token: makeJwt(JSON.stringify({ email: "alice@openai.com" })) }
              })
              files[pathApi.join(geminiDir, "oauth_creds.json")] = "{}"
              files[pathApi.join(geminiDir, "google_accounts.json")] = JSON.stringify({ active: "alice@google.com" })
              files[pathApi.join(kimiDir, "credentials", "kimi-code.json")] = "{}"
              files[pathApi.join(xdgData, "opencode", "auth.json")] = JSON.stringify({
                "kimi-for-coding": { key: "k-secret" },
                cerebras: { nested: ["c-secret"] },
                "\u001b[31m": { key: "control-only-provider-name" },
                empty: { nested: { empty: "   " } }
              })
              files[pathApi.join(xdgData, "crush", "providers.json")] = JSON.stringify(["token-in-array"])
              files[pathApi.join(xdgConfig, "amp", "secrets.json")] = JSON.stringify({ amp: { token: "amp-tok" } })
              const cursorAuth = platform === "darwin"
                ? pathApi.join(home, ".cursor", "auth.json")
                : pathApi.join(xdgConfig, "cursor", "auth.json")
              files[cursorAuth] = JSON.stringify({ token: "cursor-tok" })
              files[pathApi.join(home, ".hermes", "auth.json")] = JSON.stringify({ key: "hermes-tok" })
              files[pathApi.join(home, ".pi", "agent", "auth.json")] = JSON.stringify({ key: "pi-tok" })
            } else if (authVariant === 1) {
              files[pathApi.join(claudeStateDir, ".claude.json")] = "not-json"
              files[pathApi.join(claudeDir, ".credentials.json")] = "{}"
              files[pathApi.join(codexDir, "auth.json")] = JSON.stringify({
                tokens: { id_token: "not.a.jwt", access_token: "acc-tok" }
              })
              files[pathApi.join(geminiDir, "oauth_creds.json")] = "{}"
              files[pathApi.join(geminiDir, "google_accounts.json")] = JSON.stringify({ active: "   " })
              files[pathApi.join(xdgConfig, "crush", "crush.json")] = JSON.stringify({ a: { b: "val" } })
              files[pathApi.join(home, ".hermes", "config.yaml")] = "model: sonnet\n"
              let deep: unknown = "too-deep"
              for (let d = 0; d < 12; d += 1) deep = { child: deep }
              files[pathApi.join(home, ".pi", "agent", "auth.json")] = JSON.stringify(deep)
            } else if (authVariant === 2) {
              files[pathApi.join(codexDir, "auth.json")] = JSON.stringify({ OPENAI_API_KEY: "sk-file" })
              env.ANTHROPIC_API_KEY = "sk-ant"
              env.GEMINI_API_KEY = "sk-gem"
              env.KIMI_API_KEY = "sk-kimi"
              env.CEREBRAS_API_KEY = "sk-cer"
              env.AMP_API_KEY = "sk-amp"
              env.CURSOR_API_KEY = "sk-cur"
            } else if (authVariant === 3) {
              env.OPENAI_API_KEY = "sk-oai"
              env.GOOGLE_API_KEY = "sk-goog"
              env.OPENROUTER_API_KEY = "sk-or"
              files[pathApi.join(claudeStateDir, ".claude.json")] = JSON.stringify(["array-not-object"])
              files[pathApi.join(xdgData, "opencode", "auth.json")] = "{corrupt"
              files[pathApi.join(xdgConfig, "amp", "secrets.json")] = "{corrupt"
              files[pathApi.join(home, ".pi", "agent", "auth.json")] = null
            } else if (authVariant === 4) {
              files[pathApi.join(codexDir, "auth.json")] = JSON.stringify({ tokens: {} })
            } else {
              files[pathApi.join(claudeStateDir, ".claude.json")] = JSON.stringify({
                oauthAccount: { emailAddress: 123, organizationName: null }
              })
              files[pathApi.join(codexDir, "auth.json")] = JSON.stringify({
                tokens: { id_token: makeJwt(JSON.stringify({ sub: "no-email" })) }
              })
            }

            const probedBinaries: Array<string> = []
            const host = makeHost({
              platform,
              home,
              env,
              files,
              throwOnRead: false,
              version: async (binary) => {
                probedBinaries.push(binary)
                if (versionMode === "throws") throw new Error("ETIMEDOUT")
                if (versionMode === "null") return null
                if (versionMode === "ansi-dirty") return "\u001b[33mtool v4.5.6-beta\u001b[0m\u202e\nsecond"
                return "2.3.4 (cli)"
              }
            })

            const faultHost: HarnessHost = signalFault
              ? {
                ...host,
                readText: (p) => {
                  if (!p.startsWith(binDir)) throw new Error("EACCES")
                  return host.readText(p)
                }
              }
              : host

            const rows = await detectHarnessesWith(faultHost)
            if (rows.length !== DETECTORS.length) return false

            for (let i = 0; i < rows.length; i += 1) {
              const row = rows[i]!
              const det = DETECTORS[i]!
              if (row.id !== det.id || row.displayName !== det.displayName) return false
              if (row.binary === null) {
                if (row.status !== "unavailable" || row.account !== null || row.version !== null) return false
              } else {
                if (row.status === "unavailable") return false
                if (versionMode === "throws" || versionMode === "null") {
                  if (row.version !== null) return false
                } else {
                  if (row.version === null || row.version.length > VERSION_MAX_LENGTH) return false
                  if (FORBIDDEN_DISPLAY.test(row.version)) return false
                }
                if (row.account !== null) {
                  if (row.account.email !== undefined) {
                    if (row.account.email.length > ACCOUNT_MAX_LENGTH || FORBIDDEN_DISPLAY.test(row.account.email)) {
                      return false
                    }
                  }
                  if (row.account.label !== undefined) {
                    if (row.account.label.length > ACCOUNT_MAX_LENGTH || FORBIDDEN_DISPLAY.test(row.account.label)) {
                      return false
                    }
                  }
                }
                if (relativeHome && (row.id === "kimi" || row.id === "pi" || row.id === "hermes")) {
                  if (row.status !== "binary-only") return false
                }
              }
            }
            const installedCount = rows.filter((r) => r.binary !== null).length
            return probedBinaries.length === installedCount
          }),
        { seed: seed + 4, executions }
      )
    )
    assertPassed(report)
  })
})
