import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as ChildProcess from "effect/process/ChildProcess"
import * as Scope from "effect/Scope"
import { afterAll, describe, test } from "vitest"
import {
  Capability,
  CapabilitySet,
  ChildProcessEnvironment,
  CommandLine,
  GrantStore,
  Permission,
  Workspace
} from "../src/index.ts"

const scope = Effect.runSync(Scope.make())
afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)))

const mustCap = (value: string) => Option.getOrThrow(Capability.parse(value))
const mustPat = (value: string) => Option.getOrThrow(Capability.parsePattern(value))

const rules: ReadonlyArray<Permission.Rule> = [
  new Permission.Rule({ pattern: mustPat("fs:read:/workspace/**"), effect: "allow" }),
  new Permission.Rule({ pattern: mustPat("fs:write:/workspace/packages/**"), effect: "allow" }),
  new Permission.Rule({ pattern: mustPat("fs:*:/workspace/**/.env*"), effect: "deny" }),
  new Permission.Rule({ pattern: mustPat("proc:spawn:pnpm *"), effect: "allow" }),
  new Permission.Rule({ pattern: mustPat("net:get:api.github.com/**"), effect: "allow" }),
  ...Array.from({ length: 12 }, (_, index) =>
    new Permission.Rule({
      pattern: mustPat(`fs:read:/workspace/packages/mod-${index}/**`),
      effect: "allow"
    }))
]

const grantStore = await Effect.runPromise(
  Scope.provide(GrantStore.make({ rules }).pipe(Effect.provide(Workspace.layer("/workspace"))), scope)
)
const allowedCap = mustCap("fs:read:/workspace/packages/mod-7/src/Engine.ts")
const envelopePatterns = [
  mustPat("fs:read:/workspace/**"),
  mustPat("fs:write:/workspace/packages/**"),
  mustPat("proc:spawn:pnpm *"),
  mustPat("net:get:api.github.com/**")
]

const standardCommand = ChildProcess.make("pnpm", [
  "exec",
  "vitest",
  "run",
  "--reporter=verbose",
  "test/my file.test.ts"
], {
  cwd: "/workspace/packages/smithers/flows/kernel",
  env: { NODE_ENV: "test", CI: "1" }
})

const pipedCommand = ChildProcess.pipeTo(
  ChildProcess.make("jj", ["diff", "--git", "-r", "@"]),
  ChildProcess.make("wc", ["-l"])
)

const resourceCtx: CommandLine.ResourceContext = {
  ambient: { PATH: "/usr/bin:/bin", HOME: "/Users/bench", USER: "bench" },
  contains: (directory) => directory.startsWith("/workspace")
}

const ambientEnv: Record<string, string> = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/Users/bench",
  USER: "bench",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  TERM: "xterm-256color",
  TMPDIR: "/tmp",
  SHELL: "/bin/zsh",
  GITHUB_TOKEN: "ghp_secret",
  OPENAI_API_KEY: "sk-secret",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  DATABASE_PASSWORD: "db-secret",
  SESSION_COOKIE: "cookie-secret",
  ...Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`APP_VAR_${i}`, `val-${i}`]))
}

const declaredEnv = { NODE_ENV: "production", FORCE_COLOR: "0", USER: undefined }

const checkEffect = grantStore.check(allowedCap)
const policyEffect = grantStore.policy
const attenuatedEffect = CapabilitySet.attenuate([
  mustPat("fs:read:/workspace/**")
])(CapabilitySet.current)

const runPromise = Effect.runPromise
const runSync = Effect.runSync
const canonicalPatternsFn = GrantStore.canonicalEnvelopePatterns
const envelopeSigFn = GrantStore.envelopeSignature
const renderCmdFn = CommandLine.render
const resourceCmdFn = CommandLine.resource
const makeEnvFn = ChildProcessEnvironment.make
const opts = { time: 120, warmupTime: 30 }

describe("@smthrs/kernel", () => {
  test("GrantStore.check (17 rules) and GrantStore.policy", async ({ bench }) => {
    await bench("GrantStore.check (allow)", () => runPromise(checkEffect)).run(opts)
    await bench("GrantStore.policy", () => runPromise(policyEffect)).run(opts)
  })

  test("GrantStore envelope canonicalization and signature", async ({ bench }) => {
    await bench("canonicalEnvelopePatterns", () => {
      canonicalPatternsFn(envelopePatterns)
    }).run(opts)

    await bench("envelopeSignature", () => {
      envelopeSigFn("a".repeat(64), "run", envelopePatterns)
    }).run(opts)
  })

  test("CommandLine.render and CommandLine.resource", async ({ bench }) => {
    await bench("CommandLine.render (piped)", () => {
      renderCmdFn(pipedCommand)
    }).run(opts)

    await bench("CommandLine.resource (standard)", () => {
      resourceCmdFn(standardCommand, resourceCtx)
    }).run(opts)
  })

  test("ChildProcessEnvironment.make (37 ambient vars)", async ({ bench }) => {
    await bench("ChildProcessEnvironment.make", () => {
      makeEnvFn(ambientEnv, declaredEnv)
    }).run(opts)
  })

  test("CapabilitySet.attenuate + current", async ({ bench }) => {
    await bench("CapabilitySet.attenuate", () => {
      runSync(attenuatedEffect)
    }).run(opts)
  })
})
