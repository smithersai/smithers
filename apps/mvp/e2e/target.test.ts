import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  appURLOf,
  type Broken,
  brokenOn,
  describeBroken,
  describeNeed,
  dotEnvSets,
  guard,
  KNOWN_BROKEN,
  NEEDS,
  type NeedName,
  oldBuildDir,
  onThisMachine,
  parseDescription,
  readIdentity,
  readPlace,
  type Run,
  scriptedAgent,
  stackRepository,
  syncedRepository,
  sessionFiles,
  targetOf,
  UndeclaredNeed,
} from "./target"

const local: Run = {
  target: "local",
  role: () => "admin",
  env: { CODE_STORAGE_ORG: "o", CODE_STORAGE_KEY: "k", E2E_DOT_ENV: join(tmpdir(), "e2e-no-such-dot-env") },
}
const deployedAs = (role: ReturnType<Run["role"]>, env: Run["env"] = {}): Run => ({ target: "deployment", role: () => role, env })

describe("the target", () => {
  it("requires an explicitly named repository for synced item coverage", () => {
    for (const value of [undefined, "", "smithers", "a/b/c", "/a/b", "a/b?x=1"]) {
      const run = deployedAs("member", { E2E_SYNCED_REPOSITORY: value })
      expect(NEEDS.syncedRepository.met(run)).toBe(false)
      expect(() => syncedRepository(run)).toThrow(UndeclaredNeed)
    }
    const run = deployedAs("member", { E2E_SYNCED_REPOSITORY: "smithersai/smithers" })
    expect(NEEDS.syncedRepository.met(run)).toBe(true)
    expect(syncedRepository(run)).toBe("smithersai/smithers")
    expect(NEEDS.syncedRepository.met(local)).toBe(false)
    const previous = process.env.E2E_SYNCED_REPOSITORY
    try {
      delete process.env.E2E_SYNCED_REPOSITORY
      expect(() => syncedRepository()).toThrow(UndeclaredNeed)
      process.env.E2E_SYNCED_REPOSITORY = "smithersai/smithers"
      expect(syncedRepository()).toBe("smithersai/smithers")
    } finally {
      if (previous === undefined) delete process.env.E2E_SYNCED_REPOSITORY
      else process.env.E2E_SYNCED_REPOSITORY = previous
    }
  })
  it("is local without BASE_URL, and for this machine's dev server on any port, over https or http", () => {
    expect(targetOf({})).toBe("local")
    expect(targetOf({ BASE_URL: "https://localhost:1443" })).toBe("local")
    expect(targetOf({ BASE_URL: "http://127.0.0.1:1338/" })).toBe("local")
  })

  it("is a deployment for any other host, and E2E_TARGET overrides the URL either way", () => {
    expect(targetOf({ BASE_URL: "https://smithers.example.workers.dev" })).toBe("deployment")
    expect(targetOf({ BASE_URL: "https://localhost.example.com" })).toBe("deployment")
    expect(targetOf({ BASE_URL: "http://localhost:1338", E2E_TARGET: "deployment" })).toBe("deployment")
    expect(targetOf({ BASE_URL: "https://smithers.example.workers.dev", E2E_TARGET: "local" })).toBe("local")
    expect(targetOf({ E2E_TARGET: "" })).toBe("local")
  })

  it("ignores a BASE_URL that isn't an http(s) URL, such as the \"/\" Vite gives vitest", () => {
    expect(targetOf({ BASE_URL: "/" })).toBe("local")
    expect(appURLOf({ BASE_URL: "/" })).toBeUndefined()
    expect(appURLOf({ BASE_URL: "https://smithers.example.workers.dev" })).toBe("https://smithers.example.workers.dev")
  })

  it("refuses an E2E_TARGET it doesn't know", () => {
    expect(() => targetOf({ E2E_TARGET: "prod" })).toThrow('E2E_TARGET is "prod": it must be local or deployment')
  })

  it("trusts a self-signed certificate only on this machine", () => {
    expect(onThisMachine("https://localhost:1443")).toBe(true)
    expect(onThisMachine("https://127.0.0.1")).toBe(true)
    expect(onThisMachine("https://localhostile.dev")).toBe(false)
    expect(onThisMachine("https://smithers.example.workers.dev")).toBe(false)
  })
})

describe("needs", () => {
  it("quota-refusal needs an explicitly refusing provider", () => {
    expect(NEEDS.modelQuotaRefusal.met(local)).toBe(false)
    expect(NEEDS.modelQuotaRefusal.met({ ...local, env: { E2E_MODEL_QUOTA_REFUSED: "1" } })).toBe(true)
    expect(NEEDS.modelQuotaRefusal.met({ ...local, env: { E2E_MODEL_QUOTA_REFUSED: "0" } })).toBe(false)
  })

  it("uses a declared writable scratch stack in a deployment, and Spoon-Knife locally", () => {
    expect(NEEDS.writableStack.met(local)).toBe(true)
    expect(stackRepository(local)).toBe("octocat/Spoon-Knife")
    expect(stackRepository()).toBe("octocat/Spoon-Knife")
    for (const repository of [undefined, "", "SmithersAI/smithers", "invalid", "a/b/c"]) {
      const run = deployedAs("member", { E2E_STACK_REPOSITORY: repository })
      expect(NEEDS.writableStack.met(run)).toBe(false)
      expect(() => stackRepository(run)).toThrow(UndeclaredNeed)
    }
    const scratch = deployedAs("member", { E2E_STACK_REPOSITORY: "roninjin10/smithers-github-tests" })
    expect(NEEDS.writableStack.met(scratch)).toBe(true)
    expect(stackRepository(scratch)).toBe("roninjin10/smithers-github-tests")
  })

  it("requires the local secrets flag and fixture repository together", () => {
    for (const target of ["local", "deployment"] as const) {
      for (const flag of [undefined, "false", "true"]) {
        for (const repository of [undefined, "other/repo", "octocat/Spoon-Knife"]) {
          const run = { ...local, target, env: { SANDBOX_SECRETS: flag, GITHUB_REPOSITORY: repository } } as Run
          expect(NEEDS.sandboxSecrets.met(run)).toBe(target === "local" && flag === "true" && repository === "octocat/Spoon-Knife")
        }
      }
    }
  })

  it("are all met locally, where local development's Admin is signed in, but GitHub sign-in", () => {
    const unmet = (Object.keys(NEEDS) as Array<NeedName>).filter((name) => !NEEDS[name].met(local))
    expect(unmet).toEqual([
      "outsideRoles",
      "sandboxSecrets",
      "webhookSecret",
      "alertProviders",
      "oldBuild",
      "githubSignIn",
      "syncedRepository",
      "modelQuotaRefusal",
      "liveModel",
      "personalModelKey",
      "hostedModelOff",
      "factoryRepository",
      "githubScratch",
      "syncedScratch",
      "secondRepository",
      "dogfood",
      "repoFlows",
      "githubAppKey",
      "githubPushToken",
      "githubApp",
      "longRun",
      "docsSite",
    ])
  })

  it("requires a scratch CI fixture independently of the deployment's pusher credentials", () => {
    for (const target of ["local", "deployment"] as const) {
      const run = { ...local, target }
      for (const repository of [undefined, "", "SmithersAI/smithers", "invalid", "a/b/c"]) {
        expect(NEEDS.repoFlows.met({ ...run, env: { E2E_REPO_FLOWS_REPOSITORY: repository } })).toBe(false)
      }
      expect(NEEDS.repoFlows.met({ ...run, env: { E2E_REPO_FLOWS_REPOSITORY: "acme/ci-tests" } })).toBe(true)
    }
  })

  it("declares App key credentials separately from a local person's push token", () => {
    const env = { GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: "test-only", E2E_GITHUB_TOKEN: "test-only" }
    expect(NEEDS.githubAppKey.met(deployedAs("admin", env))).toBe(true)
    expect(NEEDS.githubPushToken.met({ ...local, env })).toBe(true)
    for (const name of ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"]) {
      for (const value of [undefined, ""]) {
        expect(NEEDS.githubAppKey.met(deployedAs("admin", { ...env, [name]: value }))).toBe(false)
      }
    }
    expect(NEEDS.githubPushToken.met(local)).toBe(false)
    expect(NEEDS.githubPushToken.met({ ...local, env: { E2E_GITHUB_TOKEN: "" } })).toBe(false)
  })

  it("for the docs site, are met only by a deployment at its custom domain", () => {
    expect(NEEDS.docsSite.met(deployedAs("guest", { BASE_URL: "https://app.example.com" }))).toBe(true)
    expect(NEEDS.docsSite.met(deployedAs("guest", { BASE_URL: "https://smithers-mvp-prod.example.workers.dev" }))).toBe(false)
    expect(NEEDS.docsSite.met(deployedAs("guest"))).toBe(false)
    expect(NEEDS.docsSite.met({ ...local, env: { BASE_URL: "https://app.example.com" } })).toBe(false)
  })

  it("in a deployment, leave out every dev-only need, and meet a role need by the account's role", () => {
    const met = (role: ReturnType<Run["role"]>) => (Object.keys(NEEDS) as Array<NeedName>).filter((name) => NEEDS[name].met(deployedAs(role)))
    expect(met("guest")).toEqual(["outsideRoles", "githubSignIn", "codeStorage", "hostedModelOff", "githubApp"])
    expect(met(null)).toEqual(["outsideRoles", "githubSignIn", "codeStorage", "hostedModelOff", "githubApp"])
    expect(met("member")).toEqual(["outsideRoles", "githubSignIn", "codeStorage", "hostedModelOff", "githubApp", "member"])
    expect(met("maintainer")).toEqual(["outsideRoles", "githubSignIn", "codeStorage", "hostedModelOff", "githubApp", "member", "maintainer"])
    expect(met("admin")).toEqual(["outsideRoles", "githubSignIn", "codeStorage", "hostedModelOff", "githubApp", "member", "maintainer"])

    // An Admin turned the deployment's own model on; a local dev server answers with it unless told otherwise.
    expect(NEEDS.hostedModelOff.met(deployedAs("member", { E2E_HOSTED_MODEL: "on" }))).toBe(false)
    expect(NEEDS.hostedModelOff.met({ ...local, env: { HOSTED_MODEL_ENABLED: "false" } })).toBe(true)
  })

  it("for local development's people and sign-out, are unmet once the dev server signs in through GitHub", () => {
    const withApp: Run = { ...local, env: { GITHUB_APP_CLIENT_ID: "Iv1.x" } }
    expect(NEEDS.devPeople.met(withApp)).toBe(false)
    expect(NEEDS.devSignIn.met(withApp)).toBe(false)
    expect(NEEDS.noGitHubApp.met(local)).toBe(true)
    expect(NEEDS.noGitHubApp.met({ ...local, env: { GITHUB_APP_ID: "1" } })).toBe(false)
    expect(NEEDS.noGitHubApp.met({ ...local, env: { E2E_ISSUES_REPOSITORY: "a/b" } })).toBe(false)
  })

  it("for roles on another repository: proved against a deployment, where roles are per repository; VibeLang's maintainer, locally or at run time", () => {
    // Local development without the App keeps its people's roles on every repository (decision 0079).
    expect(NEEDS.outsideRoles.met(local)).toBe(false)
    expect(NEEDS.outsideRoles.met(deployedAs("member"))).toBe(true)
    expect(NEEDS.outsideRoles.met(deployedAs(null))).toBe(true)
    // Against a deployment the journey asks the deployment at run time (e2e/vibelang.ts `requiresMaintainer`); the
    // role on the deployment's own repository decides nothing.
    expect(NEEDS.vibelangMaintainer.met(local)).toBe(true)
    expect(NEEDS.vibelangMaintainer.met(deployedAs("admin"))).toBe(false)
    expect(NEEDS.vibelangMaintainer.blocked).toBe(true)
  })

  it("for the dev server's own settings, are met only locally with those settings; the webhook's secret, wherever it is set", () => {
    expect(NEEDS.webhookSecret.met({ ...local, env: { E2E_GITHUB_WEBHOOK_SECRET: "s" } })).toBe(true)
    expect(NEEDS.webhookSecret.met(deployedAs("admin", { E2E_GITHUB_WEBHOOK_SECRET: "s" }))).toBe(true)
    expect(NEEDS.webhookSecret.met(deployedAs("admin", { E2E_GITHUB_WEBHOOK_SECRET: "" }))).toBe(false)
    const providers = { ALERT_TELEGRAM_API_URL: "http://localhost:9", ALERT_EMAIL_API_URL: "http://localhost:9", MODEL_SPEND_ALERTS: "true" }
    expect(NEEDS.alertProviders.met({ ...local, env: providers })).toBe(true)
    expect(NEEDS.alertProviders.met({ ...local, env: { ...providers, ALERT_EMAIL_API_URL: "http://localhost:8" } })).toBe(false)
    expect(NEEDS.alertProviders.met({ ...local, env: { ...providers, MODEL_SPEND_ALERTS: "false" } })).toBe(false)
  })

  it("deployment answers need an explicit personal key, never a hosted credential", () => {
    expect(NEEDS.personalModel.met(local)).toBe(true)
    for (const env of [{}, { E2E_PERSONAL_MODEL_KEY: "" }, { OPENAI_API_KEY: "test-only", CEREBRAS_API_KEY: "test-only" }]) {
      expect(NEEDS.personalModel.met(deployedAs("member", env))).toBe(false)
      expect(NEEDS.liveModel.met(deployedAs("member", env))).toBe(false)
    }
    expect(NEEDS.personalModel.met(deployedAs("member", { E2E_PERSONAL_MODEL_KEY: "test-only" }))).toBe(true)
    expect(describeNeed("personalModel")).toContain("E2E_PERSONAL_MODEL_KEY")
  })

  it("for a person's own model, are met by a key for it in the environment, wherever the run is", () => {
    for (const run of [local, deployedAs("member")]) {
      expect(NEEDS.personalModelKey.met(run)).toBe(false)
      expect(NEEDS.personalModelKey.met({ ...run, env: { E2E_PERSONAL_MODEL_KEY: "k" } })).toBe(true)
      expect(NEEDS.personalModelKey.met({ ...run, env: { OPENAI_API_KEY: "k" } })).toBe(false)
      expect(NEEDS.personalModelKey.met({ ...run, env: { OPENAI_API_KEY: "" } })).toBe(false)
    }
  })

  it("for the live model, are met by a deployment, or locally by the model key in the environment or the dev server's .env", () => {
    expect(NEEDS.liveModel.met(deployedAs("member"))).toBe(false)
    expect(NEEDS.liveModel.met(deployedAs("member", { E2E_PERSONAL_MODEL_KEY: "test-only" }))).toBe(true)
    expect(NEEDS.liveModel.met(local)).toBe(false)
    expect(NEEDS.liveModel.met({ ...local, env: { ...local.env, CEREBRAS_API_KEY: "k" } })).toBe(true)
    expect(NEEDS.liveModel.met({ ...local, env: { ...local.env, CEREBRAS_API_KEY: "" } })).toBe(false)
    const dir = mkdtempSync(join(tmpdir(), "e2e-dot-env-"))
    try {
      const file = join(dir, ".env")
      const sets = (text: string) => {
        writeFileSync(file, text)
        return dotEnvSets(file, "CEREBRAS_API_KEY")
      }
      expect(sets("CEREBRAS_API_KEY=k\n")).toBe(true)
      expect(sets("A=1\r\n  export CEREBRAS_API_KEY = \"k\"\r\n")).toBe(true)
      expect(sets("CEREBRAS_API_KEY='k'")).toBe(true)
      expect(sets("CEREBRAS_API_KEY=\n")).toBe(false)
      expect(sets("CEREBRAS_API_KEY=\"\"")).toBe(false)
      expect(sets("CEREBRAS_API_KEY=''")).toBe(false)
      expect(sets("CEREBRAS_API_KEY= # unset")).toBe(false)
      expect(sets("# CEREBRAS_API_KEY=k")).toBe(false)
      expect(sets("OTHER_CEREBRAS_API_KEY=k")).toBe(false)
      expect(NEEDS.liveModel.met({ ...local, env: { ...local.env, E2E_DOT_ENV: file } })).toBe(false)
      sets("CEREBRAS_API_KEY=k")
      expect(NEEDS.liveModel.met({ ...local, env: { ...local.env, E2E_DOT_ENV: file } })).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(dotEnvSets(join(tmpdir(), "e2e-no-such-dot-env"), "CEREBRAS_API_KEY")).toBe(false)
  })

  it("for the old build, are met only where its index.html is on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-old-build-"))
    try {
      expect(NEEDS.oldBuild.met({ ...local, env: { OLD_BUILD_DIR: dir } })).toBe(false)
      writeFileSync(join(dir, "index.html"), "<!doctype html>")
      expect(NEEDS.oldBuild.met({ ...local, env: { OLD_BUILD_DIR: dir } })).toBe(true)
      expect(NEEDS.oldBuild.met(deployedAs("admin", { OLD_BUILD_DIR: dir }))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(oldBuildDir({})).toMatch(/Desktop\/smithers-mvp\/builds\/c6940ac53e5a$/)
  })

  it("for a dev build's switches, are met by alchemy dev on this machine even when it signs in through GitHub", () => {
    expect(NEEDS.scriptedAgent.met({ ...deployedAs("member"), devBuild: true })).toBe(true)
    expect(NEEDS.faults.met({ ...deployedAs("member"), devBuild: true })).toBe(true)
    expect(NEEDS.scriptedAgent.met({ ...deployedAs("member"), devBuild: false })).toBe(false)
  })

  it("for the factory, are met only on a live instance whose repository is a scratch one", () => {
    expect(NEEDS.factoryRepository.met(deployedAs("member", { E2E_FACTORY_REPOSITORY: "codeplanesmithers/factory" }))).toBe(true)
    expect(NEEDS.factoryRepository.met(deployedAs("member", { E2E_FACTORY_REPOSITORY: "smithersai/smithers" }))).toBe(false)
    expect(NEEDS.factoryRepository.met({ ...local, env: { E2E_FACTORY_REPOSITORY: "codeplanesmithers/factory" } })).toBe(false)
  })

  it("for the dogfood loop, are met only in a deployment told by name to write to smithersai/smithers", () => {
    expect(NEEDS.dogfood.met(deployedAs("member", { E2E_DOGFOOD: "smithersai/smithers" }))).toBe(true)
    expect(NEEDS.dogfood.met(deployedAs("member", { E2E_DOGFOOD: "1" }))).toBe(false)
    expect(NEEDS.dogfood.met(deployedAs("member"))).toBe(false)
    expect(NEEDS.dogfood.met({ ...local, env: { E2E_DOGFOOD: "smithersai/smithers" } })).toBe(false)
  })

  it("for asking, are met locally, and in a deployment only once it has its own conversation, else blocked", () => {
    expect(NEEDS.ownConversation.met(local)).toBe(true)
    expect(NEEDS.ownConversation.met(deployedAs("member"))).toBe(false)
    expect(NEEDS.ownConversation.met({ ...deployedAs("member"), ownConversation: () => false })).toBe(false)
    expect(NEEDS.ownConversation.met({ ...deployedAs("member"), ownConversation: () => true })).toBe(true)
    expect(NEEDS.ownConversation.blocked).toBe(true)
  })

  it("for Code Storage, are met locally only with its organization and key set", () => {
    expect(NEEDS.codeStorage.met({ ...local, env: { CODE_STORAGE_ORG: "o" } })).toBe(false)
    expect(NEEDS.codeStorage.met({ ...local, env: { CODE_STORAGE_ORG: "o", CODE_STORAGE_KEY: "" } })).toBe(false)
  })

  it("requires the synced scratch for projected issues and rejects a second repository", () => {
    const env = { E2E_ISSUES_REPOSITORY: "owner/scratch", E2E_SYNCED_REPOSITORY: "OWNER/Scratch" }
    const run = deployedAs("maintainer", env)
    expect(NEEDS.syncedScratch.met(run)).toBe(true)
    expect(NEEDS.githubScratch.met(run)).toBe(true)
    expect(NEEDS.syncedScratch.met(deployedAs("maintainer", { E2E_ISSUES_REPOSITORY: "owner/scratch", GITHUB_REPOSITORY: "owner/scratch" }))).toBe(true)
    expect(NEEDS.secondRepository.met(run)).toBe(false)
    const second = deployedAs("maintainer", { ...env, E2E_SYNCED_REPOSITORY: "smithersai/smithers" })
    expect(NEEDS.syncedScratch.met(second)).toBe(false)
    expect(NEEDS.secondRepository.met(second)).toBe(true)
    expect(NEEDS.syncedScratch.met(deployedAs("maintainer"))).toBe(false)
    expect(NEEDS.syncedScratch.met(deployedAs("maintainer", { E2E_ISSUES_REPOSITORY: "SmithersAI/smithers", E2E_SYNCED_REPOSITORY: "smithersai/smithers" }))).toBe(false)
    expect(NEEDS.syncedScratch.met({ ...local, env })).toBe(false)
  })

  it("marks VibeLang roles broken only on deployments of another repository", () => {
    const entry = KNOWN_BROKEN.vibelangRoles!
    expect(entry.in).toEqual(["deployment"])
    expect(brokenOn("vibelangRoles", deployedAs("member"))).toBe(true)
    expect(brokenOn("vibelangRoles", local)).toBe(false)
    expect(brokenOn("vibelangRoles", deployedAs("member", { GITHUB_REPOSITORY: "smithersai/smithers", E2E_SYNCED_REPOSITORY: "smithersai/vibelang" }))).toBe(true)
    expect(() => brokenOn("unknown", local)).toThrow("No known-broken entry unknown")
    expect(brokenOn("vibelangRoles", deployedAs("member", { E2E_SYNCED_REPOSITORY: "SmithersAI/VibeLang" }))).toBe(false)
    expect(brokenOn("vibelangRoles", deployedAs("maintainer", { GITHUB_REPOSITORY: "smithersai/vibelang" }))).toBe(false)
  })

  it("for a second repository, are met only when the scratch repository isn't the deployment's own", () => {
    const scratch = { E2E_ISSUES_REPOSITORY: "roninjin10/smithers-github-tests" }
    expect(NEEDS.secondRepository.met(deployedAs("member", scratch))).toBe(true)
    expect(NEEDS.secondRepository.met(deployedAs("member", { ...scratch, E2E_SYNCED_REPOSITORY: "Roninjin10/Smithers-GitHub-Tests" }))).toBe(false)
    expect(NEEDS.secondRepository.met(deployedAs("member"))).toBe(false)
    expect(NEEDS.secondRepository.met({ ...local, env: scratch })).toBe(false)
  })

  it("for GitHub writes, are met only in a deployment with a scratch repository that isn't smithersai's", () => {
    expect(NEEDS.githubScratch.met(deployedAs("member", { E2E_ISSUES_REPOSITORY: "roninjin10/smithers-github-tests" }))).toBe(true)
    expect(NEEDS.githubScratch.met(deployedAs("member", { E2E_ISSUES_REPOSITORY: "SmithersAI/smithers" }))).toBe(false)
    expect(NEEDS.githubScratch.met(deployedAs("member"))).toBe(false)
    for (const repository of ["", "owner", "owner/repo/extra", "owner/repo?query"]) {
      expect(NEEDS.githubScratch.met(deployedAs("member", { E2E_ISSUES_REPOSITORY: repository }))).toBe(false)
    }
    expect(NEEDS.githubScratch.met({ ...local, env: { E2E_ISSUES_REPOSITORY: "roninjin10/smithers-github-tests" } })).toBe(false)
  })

  it("for ChatApi's records, are met locally, and in a deployment when a Cloudflare tail can open: a token and the account", () => {
    expect(NEEDS.localLogs.met(local)).toBe(true)
    expect(NEEDS.localLogs.met(deployedAs("member", { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" }))).toBe(true)
    expect(NEEDS.localLogs.met(deployedAs("member", { CLOUDFLARE_API_TOKEN: "t" }))).toBe(false)
    expect(NEEDS.localLogs.met(deployedAs("member", { CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "a" }))).toBe(false)
  })

  it("for a deployment's long windows, are met only against a deployment with E2E_LONG=1", () => {
    expect(NEEDS.longRun.met(deployedAs("member", { E2E_LONG: "1" }))).toBe(true)
    expect(NEEDS.longRun.met(deployedAs("member"))).toBe(false)
    expect(NEEDS.longRun.met({ ...local, env: { E2E_LONG: "1" } })).toBe(false)
  })

  it("read the role only when a role need asks, so a dev-only need never needs the setup", () => {
    const run: Run = { target: "deployment", role: () => { throw new Error("no identity") }, env: {} }
    expect(NEEDS.faults.met(run)).toBe(false)
    expect(() => NEEDS.member.met(run)).toThrow("no identity")
  })

  it("each say why, and missing account or fixture prerequisites block the run", () => {
    for (const name of Object.keys(NEEDS) as Array<NeedName>) expect(NEEDS[name].reason.length, name).toBeGreaterThan(20)
    expect((Object.keys(NEEDS) as Array<NeedName>).filter((name) => NEEDS[name].blocked)).toEqual(["vibelangMaintainer", "syncedRepository", "member", "ownConversation", "maintainer"])
  })
})

describe("descriptions", () => {
  // A temporary registry entry exercises description parsing independently of the current known failures.
  const registry = KNOWN_BROKEN as Record<string, Broken>
  beforeAll(() => {
    registry.clones = { in: ["deployment"], reason: "the deployment's clones never finish (an example entry)" }
  })
  afterAll(() => {
    delete registry.clones
  })

  it("name the need, and the summary reads the name back", () => {
    expect(describeNeed("faults")).toMatch(/^needs faults: the app's faulty services/)
    expect(describeNeed("member")).toMatch(/^blocked member: /)
    expect(describeBroken("clones")).toBe("broken clones: the deployment's clones never finish (an example entry)")
    expect(parseDescription(describeNeed("faults"))).toEqual({ kind: "needs", name: "faults" })
    expect(parseDescription(describeNeed("member"))).toEqual({ kind: "blocked", name: "member" })
    expect(parseDescription(describeBroken("clones"))).toEqual({ kind: "broken", name: "clones" })
  })

  it("name no known-broken entry once it is deleted", () => {
    expect(parseDescription("broken remoteFlows: every remote flow fails MigrationError")).toBeUndefined()
  })

  it("that name no declared need, or the wrong kind for it, are not declarations", () => {
    expect(parseDescription(undefined)).toBeUndefined()
    expect(parseDescription("BASE_URL is a deployment")).toBeUndefined()
    expect(parseDescription("needs telepathy: it reads minds")).toBeUndefined()
    expect(parseDescription("needs member: it asks")).toBeUndefined()
    expect(parseDescription("blocked faults: it throws a switch")).toBeUndefined()
    expect(parseDescription("broken faults: it throws a switch")).toBeUndefined()
  })

  it("every known-broken entry names its targets and why", () => {
    for (const [name, entry] of Object.entries(KNOWN_BROKEN)) {
      expect(entry.in.length, name).toBeGreaterThan(0)
      expect(entry.reason.length, name).toBeGreaterThan(20)
    }
  })
})

describe("guard", () => {
  it("lets a helper run where its need is met, and otherwise fails saying which requires is missing", () => {
    expect(() => guard("faults", local)).not.toThrow()
    const thrown = (() => {
      try {
        guard("faults", deployedAs("member"))
      } catch (error) {
        return error
      }
    })()
    expect(thrown).toBeInstanceOf(UndeclaredNeed)
    expect((thrown as UndeclaredNeed).need).toBe("faults")
    expect((thrown as Error).message).toContain('Declare it with requires("faults")')
  })
})

describe("the scripted agent's address", () => {
  it("opens the app, or adds to a page's own address, with the script named", () => {
    expect(scriptedAgent("echo", "/app", local)).toBe("/app?agent=echo")
    expect(scriptedAgent("sandbox-once", "", local)).toBe("?agent=sandbox-once")
  })

  it("can't be opened against a deployment's build", () => {
    expect(() => scriptedAgent("echo", "/app", deployedAs("admin"))).toThrow(UndeclaredNeed)
  })
})

describe("the stored session's files", () => {
  const root = mkdtempSync(join(tmpdir(), "e2e-target-"))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it("sit in one folder per host, outside the repository, under E2E_SESSION_DIR when it is set", () => {
    const files = sessionFiles("https://smithers.example.workers.dev/app", { E2E_SESSION_DIR: root })
    expect(files).toEqual({
      dir: join(root, "smithers.example.workers.dev"),
      session: join(root, "smithers.example.workers.dev", "session.json"),
      identity: join(root, "smithers.example.workers.dev", "identity.json"),
      conversation: join(root, "smithers.example.workers.dev", "conversation.json"),
    })
    expect(sessionFiles("http://localhost:1338", { E2E_SESSION_DIR: root }).dir).toBe(join(root, "localhost_1338"))
    expect(sessionFiles("https://smithers.example.workers.dev", {}).dir).toMatch(/\.smithers-e2e\/smithers\.example\.workers\.dev$/)
  })

  it("hold an identity the setup wrote, or none yet", () => {
    const path = join(root, "identity.json")
    expect(readIdentity(path)).toBeUndefined()
    writeFileSync(path, JSON.stringify({ origin: "https://a.dev", login: "codeplanesmithers", personId: "p1", role: "guest", signedInAt: 1 }))
    expect(readIdentity(path)).toEqual({ origin: "https://a.dev", login: "codeplanesmithers", personId: "p1", role: "guest" })
    writeFileSync(path, JSON.stringify({ origin: "https://a.dev", login: "codeplanesmithers", personId: "p1" }))
    expect(readIdentity(path)?.role).toBeNull()
  })

  it("hold the place a deployment run asks in, or none until the setup could track one", () => {
    const path = join(root, "conversation.json")
    expect(readPlace(path)).toBeUndefined()
    writeFileSync(path, JSON.stringify({ path: "/roninjin10/smithers-github-tests/tree/smithers-e2e", conversationId: "c1", extra: 1 }))
    expect(readPlace(path)).toEqual({ path: "/roninjin10/smithers-github-tests/tree/smithers-e2e", conversationId: "c1" })
    writeFileSync(path, JSON.stringify({ path: "/x" }))
    expect(() => readPlace(path)).toThrow("is not a place the e2e setup wrote")
  })

  it("refuse an identity file the setup didn't write", () => {
    const path = join(root, "bad.json")
    for (const bad of [{ login: "x", personId: "p" }, { origin: "o", login: "x", personId: "p", role: "owner" }, { origin: "o", personId: "p" }]) {
      writeFileSync(path, JSON.stringify(bad))
      expect(() => readIdentity(path)).toThrow("is not an identity the e2e setup wrote")
    }
  })
})

// The suite's one way to tell targets apart and skip (docs/rules.md, test.e2e-declared-needs): every spec skips only by
// `requires`, and none decides for itself whether its target is local.
describe("the specs", () => {
  const specs = async () => {
    const dir = new URL(".", import.meta.url).pathname
    const names = (await readdir(dir)).filter((name) => name.endsWith(".spec.ts"))
    return Promise.all(names.map(async (name) => ({ name, source: await readFile(join(dir, name), "utf8") })))
  }

  it("skip only by declaring a need", async () => {
    const offenders = (await specs()).filter(({ source }) => /\btest\.skip\(/.test(source)).map(({ name }) => name)
    expect(offenders, "use requires(...) from e2e/target.ts instead of test.skip").toEqual([])
  })

  // docs/rules.md, test.e2e-fails-on-server-errors: a spec's test comes from e2e/fixtures.ts, e2e/devices.ts or
  // e2e/watch.ts, each of which fails it on a server, console or page error it didn't declare.
  it("build on a test that checks for server, console and page errors, never Playwright's own", async () => {
    const offenders = (await specs())
      .filter(({ source }) => /import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*"@playwright\/test"/.test(source))
      .map(({ name }) => name)
    expect(offenders, "import test from ./fixtures, ./devices or ./watch (strictTest)").toEqual([])
  })

  it("never tell local from deployed by the URL themselves", async () => {
    const offenders = (await specs()).filter(({ source }) => /localhost\|127|process\.env\.BASE_URL|E2E_SESSION_COOKIE|\bDEV_URL\b/.test(source)).map(({ name }) => name)
    expect(offenders, "use target, requires and the stored session from e2e/target.ts").toEqual([])
  })
})
